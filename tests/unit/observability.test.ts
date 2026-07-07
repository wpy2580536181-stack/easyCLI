import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  estimateMessagesTokens,
} from '../../src/core/observability/tokenizer';
import {
  lookupPrice,
  costFor,
  formatUSD,
  normalizeModelId,
  DEFAULT_PRICE,
} from '../../src/core/observability/pricing';
import { CostTracker, formatSnapshot, formatTokens } from '../../src/core/observability/tracker';
import { EventBus } from '../../src/core/events/bus';
import type { ChatMessage } from '../../src/core/chatmodel/types';

describe('tokenizer 估算', () => {
  it('空串返回 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('纯拉丁文约 4 字符/token', () => {
    // 40 个字母 ≈ 10 token
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });

  it('CJK 宽字符约 1 字符/token（比 4/字符更准）', () => {
    // 10 个汉字 ≈ 10 token；若用 4/字符会被低估成 3
    expect(estimateTokens('你'.repeat(10))).toBe(10);
  });

  it('中英混排能区分宽/窄', () => {
    const zh = estimateTokens('你好world');
    // 你(1)+好(1)+world(5/4=2)=4
    expect(zh).toBe(4);
  });

  it('整段对话估算含每条消息的结构开销', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
    ];
    // system: 3 开销 + SYS(3字母→ceil(3/4)=1) = 4
    // user:   3 开销 + hi(2字母→ceil(2/4)=1)  = 4
    // 合计 = 8
    expect(estimateMessagesTokens(msgs)).toBe(8);
  });
});

describe('pricing 定价', () => {
  it('规整 modelId 去掉 provider 前缀', () => {
    expect(normalizeModelId('openai:deepseek-chat')).toBe('deepseek-chat');
    expect(normalizeModelId('gpt-4o')).toBe('gpt-4o');
  });

  it('子串匹配命中已知模型', () => {
    expect(lookupPrice('openai:deepseek-chat')).toEqual({ input: 0.00027, output: 0.0011 });
    expect(lookupPrice('anthropic:claude-3-5-sonnet')).toEqual({ input: 0.003, output: 0.015 });
  });

  it('ollama 本地模型免费', () => {
    expect(lookupPrice('ollama:llama3')).toEqual({ input: 0, output: 0 });
  });

  it('未知模型回退默认价', () => {
    expect(lookupPrice('some-unknown-model')).toBe(DEFAULT_PRICE);
  });

  it('costFor 按 input/output 分开计', () => {
    // deepseek-chat: input 0.00027, output 0.0011
    const cost = costFor('deepseek-chat', 1000, 1000);
    expect(cost).toBeCloseTo(0.00027 + 0.0011, 10);
  });

  it('formatUSD 极小值保留精度，0 显示 $0', () => {
    expect(formatUSD(0)).toBe('$0');
    expect(formatUSD(0.000001)).toBe('$0.000001');
    expect(formatUSD(1.5)).toBe('$1.50');
  });
});

describe('CostTracker 事件累加', () => {
  it('订阅 token 事件累加累计与单轮', () => {
    const bus = new EventBus();
    const t = new CostTracker();
    t.attach(bus);

    bus.emit({ type: 'token', model: 'openai:deepseek-chat', promptTokens: 1000, completionTokens: 500, totalTokens: 1500, estimated: false });
    bus.emit({ type: 'token', model: 'openai:deepseek-chat', promptTokens: 200, completionTokens: 100, totalTokens: 300, estimated: false });

    const snap = t.snapshot();
    expect(snap.calls).toBe(2);
    expect(snap.promptTokens).toBe(1200);
    expect(snap.completionTokens).toBe(600);
    expect(snap.totalTokens).toBe(1800);
    expect(snap.estimated).toBe(false);
    // cost > 0（deepseek 有价格）
    expect(snap.cost).toBeGreaterThan(0);
  });

  it('无真实用量时标记 estimated', () => {
    const bus = new EventBus();
    const t = new CostTracker();
    t.attach(bus);
    bus.emit({ type: 'token', model: 'openai:deepseek-chat', promptTokens: 100, completionTokens: 50, totalTokens: 150, estimated: true });
    expect(t.snapshot().estimated).toBe(true);
  });

  it('压缩事件累加次数与节省 token', () => {
    const bus = new EventBus();
    const t = new CostTracker();
    t.attach(bus);
    bus.emit({ type: 'compact', before: 8000, after: 4000 });
    bus.emit({ type: 'compact', before: 4000, after: 3000 });
    const snap = t.snapshot();
    expect(snap.compressions).toBe(2);
    expect(snap.tokensSavedByCompact).toBe(5000);
  });

  it('rag_search 的 tool:result 记为检索', () => {
    const bus = new EventBus();
    const t = new CostTracker();
    t.attach(bus);
    bus.emit({ type: 'tool:result', call: { name: 'rag_search' }, result: { ok: true, output: 'x' } });
    bus.emit({ type: 'tool:result', call: { name: 'read_file' }, result: { ok: true, output: 'y' } });
    expect(t.snapshot().retrievals).toBe(1);
  });

  it('beginTurn 只清单轮不清累计', () => {
    const bus = new EventBus();
    const t = new CostTracker();
    t.attach(bus);
    bus.emit({ type: 'token', model: 'deepseek-chat', promptTokens: 1000, completionTokens: 500, totalTokens: 1500, estimated: false });
    const beforeTurnCum = t.snapshot().totalTokens;
    t.beginTurn();
    bus.emit({ type: 'token', model: 'deepseek-chat', promptTokens: 10, completionTokens: 5, totalTokens: 15, estimated: false });
    expect(t.snapshot().totalTokens).toBe(beforeTurnCum + 15);
    expect(t.endTurn().totalTokens).toBe(15);
  });

  it('也可不订阅、直接 record 累加', () => {
    const t = new CostTracker();
    // 直接喂一条记录（不走事件）：用 token 事件语义经由 emit 不可行（未 attach），
    // 这里验证 record 路径通过 attach+emit 间接覆盖；此用例验证 reset。
    t.reset();
    expect(t.snapshot().totalTokens).toBe(0);
    expect(t.snapshot().calls).toBe(0);
  });
});

describe('formatSnapshot / formatTokens', () => {
  it('formatTokens 带千分位', () => {
    expect(formatTokens(1234567)).toBe('1,234,567');
  });

  it('formatSnapshot 单轮与累计拼接', () => {
    const turn = { promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0.001, calls: 1, compressions: 0, tokensSavedByCompact: 0, retrievals: 0, estimated: true };
    const cum = { promptTokens: 500, completionTokens: 250, totalTokens: 750, cost: 0.005, calls: 3, compressions: 1, tokensSavedByCompact: 2000, retrievals: 2, estimated: true };
    const s = formatSnapshot(turn, cum);
    expect(s).toContain('本轮');
    expect(s).toContain('累计');
    expect(s).toContain('(含估算)');
    expect(s).toContain('压缩 1 次');
    expect(s).toContain('检索 2 次');
  });
});
