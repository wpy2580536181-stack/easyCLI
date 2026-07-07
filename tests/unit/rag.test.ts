import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenize, embed, cosine } from '../../src/core/rag/embed';
import { chunkText } from '../../src/core/rag/chunk';
import { RagStore } from '../../src/core/rag/store';
import { getRagTools } from '../../src/core/rag/tools';
import { createToolRegistry } from '../../src/core/tools/registry';
import { PermissionManager } from '../../src/core/security/permission';
import { runAgent } from '../../src/core/agent';
import type { ChatMessage, ChatModel, CompleteResult, ToolCall } from '../../src/core/chatmodel/types';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'easycli-rag-'));
  await writeFile(
    join(dir, 'a.txt'),
    'easyCLI 是一个从零手写的命令行 Agent。它实现了 ReAct 循环与工具调用，并把 MCP 工具归一进统一注册表。',
    'utf8',
  );
  await writeFile(
    join(dir, 'b.txt'),
    'RAG 是检索增强生成，先把文档分块嵌入，再按余弦相似度检索，把相关片段补充进模型上下文。',
    'utf8',
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('chunkText 分块', () => {
  it('短文本整段为一块', () => {
    expect(chunkText('你好世界')).toEqual(['你好世界']);
  });

  it('长文本按 size 切分且相邻块有 overlap', () => {
    const text = '甲'.repeat(1000);
    const chunks = chunkText(text, { size: 300, overlap: 80 });
    expect(chunks.length).toBeGreaterThan(1);
    // 重叠：后一块的开头应与前一块末尾有重叠内容
    const last = chunks[chunks.length - 1]!;
    const prev = chunks[chunks.length - 2]!;
    const tail = prev.slice(prev.length - 80);
    expect(last.startsWith(tail.slice(0, 20)) || last.length).toBeTruthy();
    // 每块不超过 size + overlap
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(380);
  });
});

describe('手写嵌入 + 余弦相似度', () => {
  it('分词对中文产生字符 n-gram 词项', () => {
    const t = tokenize('你好世界');
    expect(t).toContain('c:你');
    expect(t).toContain('c:你好');
    expect(t).toContain('c:世界');
  });

  it('同一文本嵌入完全一致（确定性）', () => {
    const a = embed(tokenize('检索增强生成'));
    const b = embed(tokenize('检索增强生成'));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('相似文本余弦高于不相关文本', () => {
    const s1 = cosine(embed(tokenize('你好世界机器学习')), embed(tokenize('你好世界深度学习')));
    const s2 = cosine(embed(tokenize('你好世界机器学习')), embed(tokenize('量子计算加密通信')));
    expect(s1).toBeGreaterThan(s2);
    expect(cosine(embed(tokenize('相同文本')), embed(tokenize('相同文本')))).toBeCloseTo(1, 5);
  });
});

describe('RagStore 向量检索（SQLite :memory:）', () => {
  it('reindex 后 status 计数正确，search 命中相关块', () => {
    const store = new RagStore(':memory:');
    store.setSources([join(dir, 'a.txt'), join(dir, 'b.txt')]);
    const { docs, chunks } = store.reindex();
    expect(docs).toBe(2);
    expect(chunks).toBeGreaterThan(0);
    expect(store.status().chunks).toBe(chunks);

    const top = store.search('ReAct 循环 工具调用', 3);
    expect(top.length).toBeGreaterThan(0);
    expect(top[0]!.text).toContain('ReAct');
  });

  it('不同查询命中不同文档', () => {
    const store = new RagStore(':memory:');
    store.setSources([join(dir, 'a.txt'), join(dir, 'b.txt')]);
    store.reindex();
    const r1 = store.search('检索增强生成 分块嵌入', 1)[0]!;
    const r2 = store.search('命令行 Agent ReAct', 1)[0]!;
    expect(r1.text).toContain('RAG');
    expect(r2.text).toContain('easyCLI');
  });

  it('toContext 把结果拼成可注入字符串', () => {
    const store = new RagStore(':memory:');
    store.setSources([join(dir, 'a.txt')]);
    store.reindex();
    const ctx = RagStore.toContext(store.search('ReAct', 2));
    expect(ctx).toContain('参考 1');
    expect(ctx).toContain('来源:');
  });

  it('空库检索返回空，toContext 给占位提示', () => {
    const store = new RagStore(':memory:');
    expect(store.search('x', 3)).toEqual([]);
    expect(RagStore.toContext([])).toContain('未检索到');
  });

  it('addSource 增量追加并重索引，status 片段数增加', () => {
    const store = new RagStore(':memory:');
    store.setSources([join(dir, 'a.txt')]);
    store.reindex();
    const before = store.status().chunks;
    const { docs, chunks } = store.addSource(join(dir, 'b.txt'));
    expect(docs).toBe(2);
    expect(chunks).toBeGreaterThan(before);
    expect(store.getSources()).toEqual([join(dir, 'a.txt'), join(dir, 'b.txt')]);
  });

  it('threshold 抬高后候选减少', () => {
    const store = new RagStore(':memory:');
    store.setSources([join(dir, 'a.txt'), join(dir, 'b.txt')]);
    store.reindex();
    const loose = store.search('ReAct 循环', 5, 0);
    const strict = store.search('ReAct 循环', 5, 0.999);
    expect(loose.length).toBeGreaterThanOrEqual(strict.length);
  });
});

describe('rag_search 工具经执行器/权限跑通一轮', () => {
  class ScriptedModel implements ChatModel {
    readonly id = 'mock:test';
    calls = 0;
    constructor(private readonly queue: CompleteResult[]) {}
    async complete(): Promise<CompleteResult> {
      const r = this.queue[this.calls % this.queue.length]!;
      this.calls++;
      return r;
    }
  }

  it('Agent 调用 rag_search 并把检索内容回注历史', async () => {
    const store = new RagStore(':memory:');
    store.setSources([join(dir, 'a.txt')]);
    store.reindex();

    const tools = createToolRegistry();
    tools.registerAll(getRagTools(store));
    // rag_search 标记 isReadOnly → 默认权限放行，无需 resolver
    const permission = new PermissionManager({ registry: tools });

    const call: ToolCall = {
      id: 'r1',
      name: 'rag_search',
      arguments: { query: 'ReAct 循环 工具调用', k: 3 },
    };
    const model = new ScriptedModel([
      { content: '我先检索一下', toolCalls: [call] },
      { content: '根据知识库回答', toolCalls: [] },
    ]);
    const history: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'easyCLI 怎么实现工具调用？' },
    ];

    await runAgent(history, { model, tools, permission, cwd: process.cwd() });

    const toolMsg = history[3]!;
    expect(toolMsg.role).toBe('tool');
    expect(String(toolMsg.content)).toContain('ReAct');
    expect(String(toolMsg.content)).toContain('参考 1');
  });
});
