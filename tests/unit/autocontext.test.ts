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

  it('autoContext 作为临时 user 消息注入（置于已缓存前缀之后、真实问题之前），且不污染持久 history', async () => {
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

    // 模型收到的第一条消息仍是 system（前缀缓存不被 autoContext 污染）
    const firstMsgs = model.captured[0]!;
    expect(firstMsgs[0]!.role).toBe('system');
    expect(String(firstMsgs[0]!.content)).toBe('sys');
    // 自动上下文以 user 角色、插在最后一个真实 user 消息「之前」注入
    const acIdx = firstMsgs.findIndex(
      (m) => m.role === 'user' && String(m.content).includes('【自动上下文】'),
    );
    expect(acIdx).toBeGreaterThan(0);
    expect(firstMsgs[acIdx]!.role).toBe('user');
    // 原始 user 消息仍在，且在 autoContext 之后（顺序：上下文 → 真实问题）
    const helloIdx = firstMsgs.findIndex((m) => m.role === 'user' && String(m.content) === '你好');
    expect(helloIdx).toBeGreaterThan(acIdx);
    // 注入的上下文【没有】写进持久 history（保持临时、可重算）
    expect(history.some((m) => typeof m.content === 'string' && m.content.includes('【自动上下文】'))).toBe(false);
    // 持久 history 仅新增了模型的最终 assistant 回答
    expect(history.at(-1)!.role).toBe('assistant');
  });

  it('autoContext 在无 user 消息时以 user 角色追加到末尾', async () => {
    const tools = createToolRegistry();
    const model = new CapturingModel([{ content: '已回答', toolCalls: [] }]);
    const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];

    await runAgent(history, { model, tools, cwd: process.cwd(), autoContext: '【自动上下文】X' });

    const firstMsgs = model.captured[0]!;
    // system 之后紧跟 autoContext（user 角色）
    expect(firstMsgs[0]!.role).toBe('system');
    expect(firstMsgs[1]!.role).toBe('user');
    expect(String(firstMsgs[1]!.content)).toContain('【自动上下文】');
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
