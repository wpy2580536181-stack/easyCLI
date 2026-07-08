import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../../src/core/agent';
import { buildAutoContext, lastUserText } from '../../src/core/context';
import { MemoryStore } from '../../src/core/memory/store';
import { RagStore } from '../../src/core/rag/store';
import { HandwrittenEmbedder } from '../../src/core/rag/embedder';
import { createToolRegistry } from '../../src/core/tools/registry';
import type {
  ChatMessage,
  ChatModel,
  CompleteResult,
} from '../../src/core/chatmodel/types';

const sys: ChatMessage = { role: 'system', content: 'sys' };

/** 记录每次 complete 收到的 messages，用于验证「自动上下文」注入到模型输入 */
class CapturingModel implements ChatModel {
  readonly id = 'mock:cap';
  calls = 0;
  captured: ChatMessage[][] = [];
  constructor(private readonly queue: CompleteResult[]) {}
  async complete(opts: { messages: ChatMessage[] }): Promise<CompleteResult> {
    this.captured.push(opts.messages);
    const r = this.queue[this.calls % this.queue.length]!;
    this.calls++;
    return r;
  }
}

describe('Phase 16 · 自动上下文检索', () => {
  it('空源时 buildAutoContext 返回空文本', async () => {
    const res = await buildAutoContext('任意 query', {});
    expect(res.text).toBe('');
    expect(res.memoryCount).toBe(0);
    expect(res.ragCount).toBe(0);
  });

  it('记忆库命中时拼出记忆上下文', async () => {
    const mem = new MemoryStore(':memory:');
    mem.remember('用户偏好用 TypeScript strict 模式');
    mem.remember('项目约定提交信息用中文');
    // search 是 LIKE 子串匹配，query 需为某条事实的子串
    const res = await buildAutoContext('TypeScript', { memory: mem });
    expect(res.memoryCount).toBeGreaterThan(0);
    expect(res.text).toContain('长期记忆');
    expect(res.text).toContain('TypeScript strict');
  });

  it('空 query 时记忆走 recall 取最近若干条', async () => {
    const mem = new MemoryStore(':memory:');
    mem.remember('事实 A');
    const res = await buildAutoContext('', { memory: mem });
    expect(res.memoryCount).toBe(1);
    expect(res.text).toContain('事实 A');
  });

  it('RAG 库命中时拼出知识库上下文', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rag-'));
    writeFileSync(join(dir, 'doc.txt'), 'TypeScript strict 模式要求所有变量显式标注类型。');
    const rag = new RagStore(':memory:', new HandwrittenEmbedder());
    rag.setSources([dir]);
    await rag.reindex();
    const res = await buildAutoContext('TypeScript strict 是什么', { ragStore: rag });
    expect(res.ragCount).toBeGreaterThan(0);
    expect(res.text).toContain('知识库检索');
    expect(res.text).toContain('TypeScript');
  });
});

describe('Phase 16 · lastUserText', () => {
  it('返回最近一条 user 消息的纯文本', () => {
    const h: ChatMessage[] = [
      sys,
      { role: 'user', content: '第一个问题' },
      { role: 'assistant', content: '回答' },
      { role: 'user', content: '第二个问题' },
    ];
    expect(lastUserText(h)).toBe('第二个问题');
  });

  it('无 user 消息时返回空串', () => {
    expect(lastUserText([sys, { role: 'assistant', content: 'x' }])).toBe('');
  });
});

describe('Phase 16 · runAgent 注入临时系统消息', () => {
  beforeAll(() => {
    // 兼容 node:sqlite 在测试环境下的加载（与 memory/rag 测试同源）
  });

  it('autoContext 作为临时系统消息注入，且不污染持久 history', async () => {
    const mem = new MemoryStore(':memory:');
    mem.remember('用户偏好中文回复');
    const tools = createToolRegistry();
    const model = new CapturingModel([{ content: '已回答', toolCalls: [] }]);
    const history: ChatMessage[] = [sys, { role: 'user', content: '你好' }];

    await runAgent(history, {
      model,
      tools,
      cwd: process.cwd(),
      autoContext: '【自动上下文】用户偏好中文回复',
    });

    // 模型收到的第一条消息就是注入的自动上下文（系统消息）
    const firstMsgs = model.captured[0]!;
    expect(firstMsgs[0]!.role).toBe('system');
    expect(String(firstMsgs[0]!.content)).toContain('【自动上下文】');
    // 原始 history 的内容仍在（位于注入消息之后）
    expect(firstMsgs.some((m) => m.role === 'user' && String(m.content) === '你好')).toBe(true);
    // 注入的上下文【没有】写进持久 history（保持临时、可重算）
    expect(history.some((m) => typeof m.content === 'string' && m.content.includes('【自动上下文】'))).toBe(false);
    // 持久 history 仅新增了模型的最终 assistant 回答
    expect(history.at(-1)!.role).toBe('assistant');
  });

  it('不提供 autoContext 时不在模型输入前插入额外系统消息', async () => {
    const tools = createToolRegistry();
    const model = new CapturingModel([{ content: '已回答', toolCalls: [] }]);
    const history: ChatMessage[] = [sys, { role: 'user', content: '你好' }];

    await runAgent(history, { model, tools, cwd: process.cwd() });

    const firstMsgs = model.captured[0]!;
    expect(firstMsgs[0]!.role).toBe('system');
    expect(String(firstMsgs[0]!.content)).toBe('sys'); // 即原始 history[0]
  });
});
