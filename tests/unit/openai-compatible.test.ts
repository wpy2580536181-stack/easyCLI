import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from '../../src/core/chatmodel/openai-compatible';

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < frames.length) {
        controller.enqueue(enc.encode(frames[i++] + '\n'));
      } else {
        controller.close();
      }
    },
  });
}

const baseConfig = {
  baseURL: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'test-model',
};

describe('OpenAICompatibleAdapter 流式解析', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('逐片拼接文本内容并通过 onText 回调', async () => {
    const chunks: string[] = [];
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      body: sseStream([
        'data: {"choices":[{"delta":{"content":"你"}}]}',
        'data: {"choices":[{"delta":{"content":"好"}}]}',
        'data: [DONE]',
      ]),
    });

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    const result = await adapter.complete({
      messages: [{ role: 'user', content: 'hi' }],
      onText: (c) => chunks.push(c),
    });

    expect(result.content).toBe('你好');
    expect(chunks).toEqual(['你', '好']);
    expect(result.toolCalls).toEqual([]);
  });

  it('解析分片下发的 tool_calls 并拼接 arguments', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      body: sseStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"/a.txt\\"}"}}]}}]}',
        'data: [DONE]',
      ]),
    });

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    const result = await adapter.complete({ messages: [{ role: 'user', content: '读文件' }] });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: 'call_1',
      name: 'read_file',
      arguments: { path: '/a.txt' },
    });
  });

  it('兼容 DeepSeek 的 reasoning_content', async () => {
    const chunks: string[] = [];
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      body: sseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"让我想想"}}]}',
        'data: {"choices":[{"delta":{"content":"答案"}}]}',
        'data: [DONE]',
      ]),
    });

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    const result = await adapter.complete({
      messages: [{ role: 'user', content: '?' }],
      onText: (c) => chunks.push(c),
    });

    expect(result.content).toBe('答案');
    expect(chunks).toEqual(['让我想想', '答案']);
  });

  it('请求失败时抛出可读错误', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid api key',
    });

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    await expect(adapter.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      /401/,
    );
  });
});
