import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../../src/core/memory/store';
import { extractMemories } from '../../src/core/memory/extractor';
import type { ChatMessage, ChatModel, CompleteResult } from '../../src/core/chatmodel/types';

/** 返回预设 CompleteResult 队列的假模型（不联网） */
class FakeModel implements ChatModel {
  readonly id = 'mock:extract';
  calls = 0;
  constructor(private readonly queue: CompleteResult[]) {}
  async complete(): Promise<CompleteResult> {
    const r = this.queue[this.calls % this.queue.length]!;
    this.calls++;
    return r;
  }
}

const msg = (role: 'user' | 'assistant', content: string): ChatMessage => ({ role, content });

describe('Phase 20 · 自动提取 extractMemories', () => {
  it('最近 user 文本过短时直接跳过，不调用模型', async () => {
    const mem = new MemoryStore(':memory:');
    const model = new FakeModel([{ content: '[]', toolCalls: [] }]);
    const n = await extractMemories([msg('user', 'hi')], { model, store: mem });
    expect(n).toBe(0);
    expect(model.calls).toBe(0);
  });

  it('模型返回合法 JSON 数组 → 写入记忆库（source=auto）并返回条数', async () => {
    const mem = new MemoryStore(':memory:');
    const model = new FakeModel([
      {
        content: JSON.stringify([
          { name: 'tab 缩进', type: 'user', description: '用 tab 缩进写代码', body: '用户偏好用 tab 缩进写代码' },
        ]),
        toolCalls: [],
      },
    ]);
    const n = await extractMemories([msg('user', '我以后都用 tab 缩进写代码')], { model, store: mem });
    expect(n).toBe(1);
    expect(model.calls).toBe(1);
    const all = mem.recall(10);
    expect(all[0]!.source).toBe('auto');
    expect(all[0]!.fact).toContain('tab 缩进');
    expect(all[0]!.name).toBe('tab 缩进');
    expect(all[0]!.type).toBe('user');
  });

  it('模型返回 [] → 写入 0 条、不抛错', async () => {
    const mem = new MemoryStore(':memory:');
    const model = new FakeModel([{ content: '[]', toolCalls: [] }]);
    const n = await extractMemories([msg('user', '今天天气不错我们聊聊项目')], { model, store: mem });
    expect(n).toBe(0);
    expect(mem.recall(10)).toHaveLength(0);
  });

  it('模型返回非法 JSON → 写入 0 条、不抛错', async () => {
    const mem = new MemoryStore(':memory:');
    const model = new FakeModel([{ content: '我觉得应该记住一些东西但不是 json', toolCalls: [] }]);
    const n = await extractMemories([msg('user', '用户喜欢在周五做代码评审')], { model, store: mem });
    expect(n).toBe(0);
  });

  it('已有同名记忆 → 二次去重跳过（按 name 归一化）', async () => {
    const mem = new MemoryStore(':memory:');
    mem.remember('用户偏好用 tab 缩进', 'agent', { name: 'tab 缩进', description: '用tab缩进', type: 'user' });
    // 模型这次返回一条「名字相同、正文略不同」的记忆，应被去重跳过
    const model = new FakeModel([
      {
        content: JSON.stringify([
          { name: 'tab 缩进', type: 'user', description: '用 tab 缩进', body: '用户以后都用tab缩进写代码' },
        ]),
        toolCalls: [],
      },
    ]);
    const n = await extractMemories([msg('user', '用户以后都用 tab 缩进写代码，别用空格')], { model, store: mem });
    expect(n).toBe(0);
    // 库里仍只有最初那条（source=agent），未被重复写入
    const all = mem.recall(10);
    expect(all.filter((r) => r.source === 'auto')).toHaveLength(0);
  });

  it('节流：同一进程内短时间内第二次提取被跳过', async () => {
    const mem = new MemoryStore(':memory:');
    const model = new FakeModel([
      { content: JSON.stringify([{ name: 'A', type: 'user', description: 'a', body: '事实A' }]), toolCalls: [] },
      { content: '[]', toolCalls: [] },
    ]);
    const h = [msg('user', '用户偏好喝美式咖啡并且用 vim 编辑器')];
    // 用独立节流状态持有对象，隔离模块级单例对其他测试的污染
    const throttleState = { last: 0 };
    const n1 = await extractMemories(h, { model, store: mem, throttleMs: 100_000, throttleState });
    const n2 = await extractMemories(h, { model, store: mem, throttleMs: 100_000, throttleState });
    expect(n1).toBe(1);
    expect(n2).toBe(0);
    expect(model.calls).toBe(1); // 第二次未真正调模型
  });

  it('模型调用异常 → 静默返回 0，不影响主流程', async () => {
    const mem = new MemoryStore(':memory:');
    const model: ChatModel = {
      id: 'mock:throw',
      async complete(): Promise<CompleteResult> {
        throw new Error('network down');
      },
    };
    const n = await extractMemories([msg('user', '用户习惯把环境变量写进 .env 文件')], { model, store: mem });
    expect(n).toBe(0);
  });
});
