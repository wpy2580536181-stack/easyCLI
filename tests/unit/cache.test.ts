/**
 * 前缀缓存透传单测（P0）。
 *
 * 覆盖两类适配器的「缓存断点」翻译与「命中率」用量回报：
 *  - Anthropic：system 末块 + 末个 tool 打 cache_control:{type:'ephemeral'}；
 *    message_start.usage 的 cache_read_input_tokens / cache_creation_input_tokens 回报。
 *  - OpenAI 兼容：首个 system 消息包装为带 cache_control 的 block 数组；
 *    末个 tool 打 cache_control；usage.prompt_tokens_details.cached_tokens 回报。
 *
 * 关键不变式：cache 标记只加到「稳定前缀」的末端（system 末块 / 末个 tool），
 * 且可通过 cache.system / cache.tools 单独关闭，避免污染可变前缀。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/core/chatmodel/anthropic';
import { OpenAICompatibleAdapter } from '../../src/core/chatmodel/openai-compatible';

/* ----------------------------- 流帧构造器 ----------------------------- */

/** Anthropic 命名事件流：每个事件 = `event: TYPE\ndata: JSON\n\n` */
function anthropicStream(events: { type: string; data: unknown }[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const frames = events.map(
    (e) => `event: ${e.type}\ndata: ${JSON.stringify({ type: e.type, ...(e.data as object) })}\n\n`,
  );
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < frames.length) controller.enqueue(enc.encode(frames[i++]));
      else controller.close();
    },
  });
}

/** OpenAI 兼容 SSE 流：每行 `data: JSON\n`，结束帧 `data: [DONE]` */
function openaiStream(frames: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const lines = [...frames.map((f) => `data: ${JSON.stringify(f)}`), 'data: [DONE]'].map(
    (l) => `${l}\n`,
  );
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < lines.length) controller.enqueue(enc.encode(lines[i++]));
      else controller.close();
    },
  });
}

/* ------------------------------- Anthropic ------------------------------- */

const anthropicConfig = { apiKey: 'test-key', model: 'claude-test' };

describe('AnthropicAdapter · 前缀缓存断点', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('默认在 system 末块打 cache_control 断点（多 system 块时仅末块）', async () => {
    (globalThis.fetch as any).mockImplementation(async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      expect(Array.isArray(body.system)).toBe(true);
      // 第二个 system 块（末块）带断点，第一个不带
      expect((body.system[0] as any).cache_control).toBeUndefined();
      expect((body.system[1] as any).cache_control).toEqual({ type: 'ephemeral' });
      return { ok: true, body: anthropicStream([{ type: 'message_stop', data: {} }]) };
    });
    const adapter = new AnthropicAdapter(anthropicConfig);
    await adapter.complete({
      messages: [
        { role: 'system', content: 'SYS-A' },
        { role: 'system', content: 'SYS-B' },
        { role: 'user', content: 'x' },
      ],
    });
  });

  it('cache.system=false 时不在 system 块打断点', async () => {
    (globalThis.fetch as any).mockImplementation(async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      expect((body.system[0] as any).cache_control).toBeUndefined();
      return { ok: true, body: anthropicStream([{ type: 'message_stop', data: {} }]) };
    });
    const adapter = new AnthropicAdapter(anthropicConfig);
    await adapter.complete({
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'x' },
      ],
      cache: { system: false },
    });
  });

  it('默认仅末个 tool 打 cache_control（稳定前缀末端）', async () => {
    (globalThis.fetch as any).mockImplementation(async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      expect((body.tools[0] as any).cache_control).toBeUndefined();
      expect((body.tools[1] as any).cache_control).toEqual({ type: 'ephemeral' });
      return { ok: true, body: anthropicStream([{ type: 'message_stop', data: {} }]) };
    });
    const adapter = new AnthropicAdapter(anthropicConfig);
    await adapter.complete({
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        { name: 'a_first', description: 'A', inputSchema: { type: 'object' } },
        { name: 'z_last', description: 'Z', inputSchema: { type: 'object' } },
      ],
    });
  });

  it('cache.tools=false 时 tool 不带 cache_control', async () => {
    (globalThis.fetch as any).mockImplementation(async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      expect((body.tools[0] as any).cache_control).toBeUndefined();
      return { ok: true, body: anthropicStream([{ type: 'message_stop', data: {} }]) };
    });
    const adapter = new AnthropicAdapter(anthropicConfig);
    await adapter.complete({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'a_first', description: 'A', inputSchema: { type: 'object' } }],
      cache: { tools: false },
    });
  });

  it('解析 message_start.usage 的缓存命中/创建 token', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      body: anthropicStream([
        {
          type: 'message_start',
          data: {
            message: {
              usage: {
                input_tokens: 120,
                output_tokens: 0,
                cache_read_input_tokens: 90,
                cache_creation_input_tokens: 30,
              },
            },
          },
        },
        { type: 'message_stop', data: {} },
      ]),
    });
    const adapter = new AnthropicAdapter(anthropicConfig);
    const result = await adapter.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(result.usage?.cacheReadTokens).toBe(90);
    expect(result.usage?.cacheCreationTokens).toBe(30);
  });

  it('开启 history：cache_control 打到「当前轮之前」最后一条消息末块', async () => {
    (globalThis.fetch as any).mockImplementation(async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      // system 未开缓存（system:false）→ 顶层无断点
      expect((body.system[0] as any).cache_control).toBeUndefined();
      const users = body.messages.filter((m: any) => m.role === 'user');
      // 当前轮 user2 不该有断点
      expect(users[users.length - 1].cache_control).toBeUndefined();
      // 稳定历史段末条（user1 之后的 assistant1）末块带断点
      const asst = body.messages.filter((m: any) => m.role === 'assistant');
      expect(Array.isArray(asst[0].content)).toBe(true);
      const lastBlock = asst[0].content[asst[0].content.length - 1];
      expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
      return { ok: true, body: anthropicStream([{ type: 'message_stop', data: {} }]) };
    });
    const adapter = new AnthropicAdapter(anthropicConfig);
    await adapter.complete({
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: '上一轮的问题' },
        { role: 'assistant', content: '上一轮的回答' },
        { role: 'user', content: '当前轮的问题' },
      ],
      cache: { system: false, tools: false, history: true },
    });
  });

  it('history 与 autoContext 共存：autoContext（当前轮）不进缓存前缀', async () => {
    (globalThis.fetch as any).mockImplementation(async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      // out = [user1, assistant1, autoContext, user2]
      const msgs = body.messages as any[];
      const noCC = (m: any) =>
        !m.cache_control && !(Array.isArray(m.content) ? m.content.some((b: any) => b.cache_control) : false);
      // autoContext（index 2）与当前轮 user2（索引 3）均无断点
      expect(noCC(msgs[2])).toBe(true);
      expect(noCC(msgs[3])).toBe(true);
      // 稳定段末条 assistant1（索引 1）末块带断点
      expect(Array.isArray(msgs[1].content)).toBe(true);
      expect(msgs[1].content[msgs[1].content.length - 1].cache_control).toEqual({ type: 'ephemeral' });
      return { ok: true, body: anthropicStream([{ type: 'message_stop', data: {} }]) };
    });
    const adapter = new AnthropicAdapter(anthropicConfig);
    await adapter.complete({
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: '上一轮的问题' },
        { role: 'assistant', content: '上一轮的回答' },
        { role: 'user', content: '【自动上下文】每轮不同' },
        { role: 'user', content: '当前轮的问题' },
      ],
      cache: { system: false, tools: false, history: true },
    });
  });
});

/* --------------------------- OpenAI 兼容 --------------------------- */

const openaiConfig = { baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'om' };

describe('OpenAICompatibleAdapter · 前缀缓存断点', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('默认把首个 system 消息包装为带 cache_control 的 block 数组', async () => {
    (globalThis.fetch as any).mockImplementation(async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      const sys = body.messages.find((m: any) => m.role === 'system');
      expect(Array.isArray(sys.content)).toBe(true);
      expect(sys.content[0].cache_control).toEqual({ type: 'ephemeral' });
      return {
        ok: true,
        body: openaiStream([{ choices: [{ delta: { content: '好' } }] }, { usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }]),
      };
    });
    const adapter = new OpenAICompatibleAdapter(openaiConfig);
    await adapter.complete({
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'x' },
      ],
    });
  });

  it('cache.system=false 时 system 内容保持纯字符串', async () => {
    (globalThis.fetch as any).mockImplementation(async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      const sys = body.messages.find((m: any) => m.role === 'system');
      expect(typeof sys.content).toBe('string');
      expect(sys.content).toBe('SYS');
      return {
        ok: true,
        body: openaiStream([{ choices: [{ delta: { content: '好' } }] }, { usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }]),
      };
    });
    const adapter = new OpenAICompatibleAdapter(openaiConfig);
    await adapter.complete({
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'x' },
      ],
      cache: { system: false },
    });
  });

  it('默认仅末个 tool 打 cache_control（顶层字段）', async () => {
    (globalThis.fetch as any).mockImplementation(async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      expect((body.tools[0] as any).cache_control).toBeUndefined();
      expect((body.tools[1] as any).cache_control).toEqual({ type: 'ephemeral' });
      return {
        ok: true,
        body: openaiStream([{ choices: [{ delta: { content: '好' } }] }, { usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }]),
      };
    });
    const adapter = new OpenAICompatibleAdapter(openaiConfig);
    await adapter.complete({
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        { name: 'a_first', description: 'A', inputSchema: { type: 'object' } },
        { name: 'z_last', description: 'Z', inputSchema: { type: 'object' } },
      ],
    });
  });

  it('流式 usage.prompt_tokens_details.cached_tokens 回报为 cacheReadTokens', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      body: openaiStream([
        { choices: [{ delta: { content: '好' } }] },
        {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 2,
            total_tokens: 102,
            prompt_tokens_details: { cached_tokens: 80 },
          },
        },
      ]),
    });
    const adapter = new OpenAICompatibleAdapter(openaiConfig);
    const result = await adapter.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(result.usage?.cacheReadTokens).toBe(80);
  });

  it('非流式路径同样回报 cacheReadTokens', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '好' } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 2,
          total_tokens: 102,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      }),
    });
    const adapter = new OpenAICompatibleAdapter({ ...openaiConfig, stream: false });
    const result = await adapter.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(result.usage?.cacheReadTokens).toBe(80);
  });

  it('开启 history：cache_control 打到「当前轮之前」最后一条消息末块', async () => {
    (globalThis.fetch as any).mockImplementation(async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      const sys = body.messages.find((m: any) => m.role === 'system');
      expect(typeof sys.content).toBe('string'); // system 未开缓存
      const users = body.messages.filter((m: any) => m.role === 'user');
      expect(users[users.length - 1].cache_control).toBeUndefined(); // 当前轮 user2
      const asst = body.messages.filter((m: any) => m.role === 'assistant');
      // assistant1 被包装为 block 数组，末块带 cache_control
      expect(Array.isArray(asst[0].content)).toBe(true);
      expect(asst[0].content[asst[0].content.length - 1].cache_control).toEqual({ type: 'ephemeral' });
      return {
        ok: true,
        body: openaiStream([{ choices: [{ delta: { content: '好' } }] }, { usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }]),
      };
    });
    const adapter = new OpenAICompatibleAdapter(openaiConfig);
    await adapter.complete({
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: '上一轮的问题' },
        { role: 'assistant', content: '上一轮的回答' },
        { role: 'user', content: '当前轮的问题' },
      ],
      cache: { system: false, tools: false, history: true },
    });
  });
});
