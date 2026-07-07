import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/core/chatmodel/anthropic';
import type { ChatMessage } from '../../src/core/chatmodel/types';

/** 构造 Anthropic 命名事件流：每个事件 = `event: TYPE\ndata: JSON\n\n` */
function anthropicStream(events: { type: string; data: unknown }[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  // 真实 Anthropic 的 data JSON 顶层也带 type 字段（与 event: 同名），适配器据此分支
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

const baseConfig = { apiKey: 'test-key', model: 'claude-test' };

describe('AnthropicAdapter 流式解析', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('逐片拼接文本 content_block_delta 并通过 onText', async () => {
    const chunks: string[] = [];
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      body: anthropicStream([
        { type: 'message_start', data: { message: { id: 'm1' } } },
        { type: 'content_block_start', data: { index: 0, content_block: { type: 'text' } } },
        { type: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: '你' } } },
        { type: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: '好' } } },
        { type: 'content_block_stop', data: { index: 0 } },
        { type: 'message_stop', data: {} },
      ]),
    });

    const adapter = new AnthropicAdapter(baseConfig);
    const result = await adapter.complete({
      messages: [{ role: 'user', content: 'hi' }],
      onText: (c) => chunks.push(c),
    });

    expect(result.content).toBe('你好');
    expect(chunks).toEqual(['你', '好']);
    expect(result.toolCalls).toEqual([]);
  });

  it('分片累积 input_json_delta 还原 tool_use 参数', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      body: anthropicStream([
        { type: 'content_block_start', data: { index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file' } } },
        { type: 'content_block_delta', data: { index: 0, delta: { type: 'input_json_delta', partial_json: '{"path"' } } },
        { type: 'content_block_delta', data: { index: 0, delta: { type: 'input_json_delta', partial_json: ':"/a.txt"}' } } },
        { type: 'content_block_stop', data: { index: 0 } },
        { type: 'message_stop', data: {} },
      ]),
    });

    const adapter = new AnthropicAdapter(baseConfig);
    const result = await adapter.complete({ messages: [{ role: 'user', content: '读文件' }] });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: 'tu_1',
      name: 'read_file',
      arguments: { path: '/a.txt' },
    });
  });

  it('把 system 抽成顶层字段，并把 tool 结果并入 user 的 tool_result', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '读文件' },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'tu_1', name: 'read_file', arguments: { path: '/a.txt' } }],
      },
      { role: 'tool', tool_call_id: 'tu_1', name: 'read_file', content: '文件内容' },
    ];

    (globalThis.fetch as any).mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      // 断言格式翻译正确
      expect(body.system).toBe('SYS');
      expect(body.messages[0]).toEqual({ role: 'user', content: '读文件' });
      expect(body.messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: '/a.txt' } }],
      });
      expect(body.messages[2]).toEqual({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '文件内容' }],
      });
      return {
        ok: true,
        body: anthropicStream([
          { type: 'content_block_start', data: { index: 0, content_block: { type: 'text' } } },
          { type: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: '完成' } } },
          { type: 'content_block_stop', data: { index: 0 } },
          { type: 'message_stop', data: {} },
        ]),
      };
    });

    const adapter = new AnthropicAdapter(baseConfig);
    const result = await adapter.complete({ messages });
    expect(result.content).toBe('完成');
  });

  it('tool 映射使用 input_schema（而非 OpenAI 的 parameters）', async () => {
    (globalThis.fetch as any).mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.tools[0]).toEqual({
        name: 'read_file',
        description: '读文件',
        input_schema: { type: 'object' },
      });
      return {
        ok: true,
        body: anthropicStream([
          { type: 'message_stop', data: {} },
        ]),
      };
    });

    const adapter = new AnthropicAdapter(baseConfig);
    await adapter.complete({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'read_file', description: '读文件', inputSchema: { type: 'object' } }],
    });
  });
});
