import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compressHistory,
  reactiveCompact,
  estimateTokens,
  estimateHistoryTokens,
  messageText,
  simpleHash,
  type CompressOptions,
} from '../../src/core/memory/compressor';
import type { ChatMessage, ContentBlock } from '../../src/core/chatmodel/types';

function tool(content: string, id = 't1'): ChatMessage {
  return { role: 'tool', tool_call_id: id, content };
}
function assistantWithTool(id: string, name: string): ChatMessage {
  const blocks: ContentBlock[] = [
    { type: 'tool_call', id, name, arguments: { path: 'x' } },
  ];
  return { role: 'assistant', content: blocks };
}
function user(text: string): ChatMessage {
  return { role: 'user', content: text };
}
function system(text: string): ChatMessage {
  return { role: 'system', content: text };
}

/** 校验 tool_call ↔ tool_result 配对在压缩后仍合法 */
function validatePairing(h: ChatMessage[]): boolean {
  for (let i = 0; i < h.length; i++) {
    const m = h[i]!;
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_call') {
          if (!h.slice(i + 1).some((x) => x.role === 'tool' && x.tool_call_id === b.id)) return false;
        }
      }
    }
    if (m.role === 'tool' && m.tool_call_id) {
      const ok = h.slice(0, i).some(
        (x) =>
          x.role === 'assistant' &&
          Array.isArray(x.content) &&
          x.content.some((b) => b.type === 'tool_call' && b.id === m.tool_call_id),
      );
      if (!ok) return false;
    }
  }
  return true;
}

describe('estimateTokens / messageText', () => {
  it('粗略估算 ~4 字符/token', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11 → ceil(2.75)=3
    expect(estimateTokens('')).toBe(1); // 最小为 1
  });
  it('ContentBlock[] 拼成文本', () => {
    expect(messageText({ role: 'assistant', content: [{ type: 'text', text: 'ab' }] })).toBe('ab');
  });
});

describe('第 1 级：选择性裁剪超长工具输出', () => {
  it('最近 N 条 tool 结果保留完整，旧结果超长才被裁并打标记', async () => {
    // 3 个 tool 结果，最旧（old）超长，最近 2 条（mid/new）应保留完整
    const history = [
      user('u'),
      tool('x'.repeat(5000), 'old'),
      tool('Y', 'mid'),
      tool('Z', 'new'),
    ];
    const opts: CompressOptions = {
      budgetTokens: 100,
      keepRecentTurns: 4,
      maxToolOutputChars: 50,
      keepRecentToolResults: 2,
    };
    const out = await compressHistory(history, opts);
    const byId = (id: string) => out.find((m) => m.role === 'tool' && m.tool_call_id === id)!;
    const oldT = byId('old');
    const midT = byId('mid');
    const newT = byId('new');
    expect(messageText(oldT).length).toBeLessThanOrEqual(50 + 20);
    expect(messageText(oldT)).toContain('[已裁剪');
    expect(oldT.tool_call_id).toBe('old');
    expect(messageText(midT)).toBe('Y'); // 最近 2 条保留完整
    expect(messageText(newT)).toBe('Z');
  });
});

describe('第 2 级：去重相邻相同工具结果', () => {
  it('连续相同工具结果只保留一个', async () => {
    const history = [user('u'), tool('X'), tool('X')];
    const opts: CompressOptions = { budgetTokens: 2, keepRecentTurns: 4, maxToolOutputChars: 9999 };
    const out = await compressHistory(history, opts);
    const tools = out.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(1);
    expect(messageText(tools[0]!)).toBe('X');
  });
});

describe('第 3 级：折叠中间工具结果（保留配对）', () => {
  it('工具结果被折叠为占位，tool_call_id 不变，配对仍合法', async () => {
    const history = [
      user('u1'),
      assistantWithTool('a', 'read_file'),
      tool('y'.repeat(3000), 'a'),
      user('u2'),
    ];
    const opts: CompressOptions = { budgetTokens: 5, keepRecentTurns: 1, maxToolOutputChars: 9999 };
    const out = await compressHistory(history, opts);
    const folded = out.find((m) => m.role === 'tool' && m.tool_call_id === 'a')!;
    expect(messageText(folded)).toContain('[已折叠工具结果');
    expect(validatePairing(out)).toBe(true);
  });
});

describe('第 4 级：摘要（模型把中间轮压缩成一条）', () => {
  it('中间轮被摘要成 system 消息，最近轮保留，system 原样保留', async () => {
    const history = [
      system('SYS'),
      user('u1'),
      assistantWithTool('a', 'read_file'),
      tool('old result content', 'a'),
      user('u2'),
      assistantWithTool('b', 'read_file'),
      tool('recent result content', 'b'),
    ];
    const opts: CompressOptions = {
      budgetTokens: 5,
      keepRecentTurns: 1,
      maxToolOutputChars: 9999,
      summarizer: async () => 'SUMMARY',
    };
    const out = await compressHistory(history, opts);
    expect(out[0]).toEqual(system('SYS')); // 原 system 在最前
    expect(messageText(out[1]!)).toContain('[历史摘要]');
    expect(messageText(out[1]!)).toContain('SUMMARY');
    // 最近一轮（u2 + assistant b + tool b）完整保留
    expect(out.some((m) => m.role === 'tool' && m.tool_call_id === 'b')).toBe(true);
    // 中间轮 a 已被摘要替换，不应再有 tool_call_id a 的工具消息
    expect(out.some((m) => m.role === 'tool' && m.tool_call_id === 'a')).toBe(false);
    expect(validatePairing(out)).toBe(true);
  });

  it('摘要器失败则回退到折叠，不抛错', async () => {
    const history = [
      user('u1'),
      assistantWithTool('a', 'read_file'),
      tool('z'.repeat(3000), 'a'),
      user('u2'),
    ];
    const opts: CompressOptions = {
      budgetTokens: 5,
      keepRecentTurns: 1,
      maxToolOutputChars: 9999,
      summarizer: async () => {
        throw new Error('boom');
      },
    };
    const out = await compressHistory(history, opts);
    expect(validatePairing(out)).toBe(true);
    // 摘要失败回退折叠：原始超长内容不应再出现在结果中
    expect(out.some((m) => m.role === 'tool' && messageText(m).includes('z'.repeat(3000)))).toBe(false);
  });
});

describe('压缩不破坏整体配对', () => {
  it('多轮工具调用压缩后配对仍全部合法', async () => {
    const history: ChatMessage[] = [system('SYS')];
    for (let i = 0; i < 6; i++) {
      history.push(user(`u${i}`));
      history.push(assistantWithTool(`c${i}`, 'read_file'));
      history.push(tool(`result ${i} `.repeat(200), `c${i}`));
    }
    const opts: CompressOptions = {
      budgetTokens: 1000,
      keepRecentTurns: 2,
      maxToolOutputChars: 200,
      summarizer: async (t) => 'SUMMARY:' + t.length,
    };
    const out = await compressHistory(history, opts);
    expect(validatePairing(out)).toBe(true);
    expect(out[0]).toEqual(system('SYS'));
    const before = estimateHistoryTokens(history);
    const after = estimateHistoryTokens(out);
    expect(after).toBeLessThan(before); // 确实压缩了
    // 预算内需 ≥ 受保护的最近 2 轮体积（选择性保留最近 tool 结果，预算要足够大）
    expect(after).toBeLessThanOrEqual(1000);
  });
});

describe('第 0.5 级：超大结果落盘', () => {
  it('超阈值 tool 结果写盘，上下文留预览标记，可 re-read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'easycli-persist-'));
    try {
      const big = 'A'.repeat(40_000);
      const history = [user('u'), tool(big, 'big')];
      const opts: CompressOptions = {
        budgetTokens: 100,
        keepRecentTurns: 4,
        maxToolOutputChars: 50,
        persistDir: dir,
        persistThresholdChars: 30_000,
        previewChars: 200,
      };
      const out = await compressHistory(history, opts);
      const t = out.find((m) => m.role === 'tool' && m.tool_call_id === 'big')!;
      const text = messageText(t);
      expect(text).toContain('<persisted-output');
      expect(text).toContain('A'.repeat(200)); // 预览保留
      expect(text).not.toContain('A'.repeat(40_000)); // 原文已移出上下文
      const m = text.match(/path="([^"]+)"/);
      expect(m).toBeTruthy();
      expect(readFileSync(m![1]!, 'utf8')).toBe(big); // 落盘含完整原文
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未配置 persistDir 时不做落盘', async () => {
    const history = [user('u'), tool('A'.repeat(40_000), 'big')];
    const opts: CompressOptions = {
      budgetTokens: 100,
      keepRecentTurns: 4,
      maxToolOutputChars: 9999,
    };
    const out = await compressHistory(history, opts);
    const t = out.find((m) => m.role === 'tool' && m.tool_call_id === 'big')!;
    expect(messageText(t)).not.toContain('<persisted-output');
  });
});

describe('L4 摘要：缓存友好（护前缀缓存）', () => {
  it('按 middle 哈希缓存：相同内容不重复调用摘要器', async () => {
    let calls = 0;
    const summarizer = async () => {
      calls++;
      return 'SUMMARY';
    };
    const cache = new Map<string, string>();
    const mk = (): ChatMessage[] => [
      system('SYS'),
      user('u1'),
      assistantWithTool('a', 'read_file'),
      tool('old', 'a'),
      user('u2'),
      assistantWithTool('b', 'read_file'),
      tool('recent', 'b'),
    ];
    const opts = (): CompressOptions => ({
      budgetTokens: 5,
      keepRecentTurns: 1,
      maxToolOutputChars: 9999,
      summarizer,
      summaryCache: cache,
      atTurnBoundary: true,
    });
    const out1 = await compressHistory(mk(), opts());
    const out2 = await compressHistory(mk(), opts());
    expect(calls).toBe(1); // 第二次命中缓存，未再调用
    expect(messageText(out1[1]!)).toContain('SUMMARY');
    expect(messageText(out2[1]!)).toContain('SUMMARY');
  });

  it('非 turn boundary：不触发 L4 摘要，回退折叠（不乱动缓存前缀）', async () => {
    let calls = 0;
    const summarizer = async () => {
      calls++;
      return 'SUMMARY';
    };
    const history: ChatMessage[] = [
      system('SYS'),
      user('u1'),
      assistantWithTool('a', 'read_file'),
      tool('old content', 'a'),
      user('u2'),
      assistantWithTool('b', 'read_file'),
      tool('recent', 'b'),
    ];
    const opts: CompressOptions = {
      budgetTokens: 5,
      keepRecentTurns: 1,
      maxToolOutputChars: 9999,
      summarizer,
      atTurnBoundary: false,
    };
    const out = await compressHistory(history, opts);
    expect(calls).toBe(0); // 未调用摘要器
    expect(out.some((m) => messageText(m).includes('[历史摘要]'))).toBe(false);
    expect(out.some((m) => messageText(m).includes('[已折叠工具结果'))).toBe(true);
    expect(validatePairing(out)).toBe(true);
  });

  it('摘要连续失败达上限后熔断，只折叠不再调用', async () => {
    let calls = 0;
    const summarizer = async () => {
      calls++;
      throw new Error('boom');
    };
    const failures = { n: 0 };
    const mk = (): ChatMessage[] => [
      system('SYS'),
      user('u1'),
      assistantWithTool('a', 'read_file'),
      tool('old', 'a'),
      user('u2'),
      assistantWithTool('b', 'read_file'),
      tool('recent', 'b'),
    ];
    const opts = (): CompressOptions => ({
      budgetTokens: 5,
      keepRecentTurns: 1,
      maxToolOutputChars: 9999,
      summarizer,
      summaryFailures: failures,
      maxSummaryFailures: 2,
      atTurnBoundary: true,
    });
    await compressHistory(mk(), opts());
    await compressHistory(mk(), opts());
    await compressHistory(mk(), opts());
    expect(calls).toBe(2); // 第 3 次已熔断，未再调用
    expect(failures.n).toBe(2);
  });
});

describe('reactiveCompact（413 应急兜底）', () => {
  it('保留 system + 最近轮 + protected，其余激进折叠', () => {
    const history: ChatMessage[] = [
      system('SYS'),
      user('u1'),
      assistantWithTool('a', 'read_file'),
      tool('old1', 'a'),
      user('u2'),
      assistantWithTool('b', 'read_file'),
      tool('old2', 'b'),
      user('u3'),
      assistantWithTool('c', 'read_file'),
      tool('recent', 'c'),
    ];
    const opts: CompressOptions = { budgetTokens: 5, keepRecentTurns: 1, maxToolOutputChars: 9999 };
    const out = reactiveCompact(history, opts);
    expect(out[0]).toEqual(system('SYS'));
    const aMsg = out.find((m) => m.role === 'tool' && m.tool_call_id === 'a');
    const bMsg = out.find((m) => m.role === 'tool' && m.tool_call_id === 'b');
    const cMsg = out.find((m) => m.role === 'tool' && m.tool_call_id === 'c');
    expect(cMsg).toBeTruthy();
    expect(messageText(cMsg!)).toContain('recent'); // 最近轮保留完整
    // 旧轮被折叠：消息仍在（保持 tool_call 配对），但原内容已替换为占位
    expect(aMsg).toBeTruthy();
    expect(messageText(aMsg!)).toContain('[已折叠');
    expect(messageText(aMsg!)).not.toContain('old1');
    expect(bMsg).toBeTruthy();
    expect(messageText(bMsg!)).not.toContain('old2');
    expect(validatePairing(out)).toBe(true);
  });
});

describe('simpleHash', () => {
  it('同输入同哈希，不同输入不同哈希', () => {
    expect(simpleHash('hello')).toBe(simpleHash('hello'));
    expect(simpleHash('hello')).not.toBe(simpleHash('world'));
  });
});
