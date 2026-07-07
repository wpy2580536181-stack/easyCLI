import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OllamaAdapter } from '../../src/core/chatmodel/ollama';

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < frames.length) controller.enqueue(enc.encode(frames[i++] + '\n'));
      else controller.close();
    },
  });
}

describe('OllamaAdapter', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('id 前缀为 ollama: 且默认指向本地 /v1 端点', async () => {
    let calledUrl = '';
    (globalThis.fetch as any).mockImplementation(async (url: string) => {
      calledUrl = url;
      return {
        ok: true,
        body: sseStream(['data: {"choices":[{"delta":{"content":"ok"}}]}', 'data: [DONE]']),
      };
    });

    const adapter = new OllamaAdapter({ model: 'llama3' });
    expect(adapter.id).toBe('ollama:llama3');

    await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(calledUrl).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('复用 OpenAI 兼容协议解析 tool_calls（证明继承有效）', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      body: sseStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":\\"/a\\"}"}}]}}]}',
        'data: [DONE]',
      ]),
    });

    const adapter = new OllamaAdapter({ model: 'qwen2.5', baseURL: 'http://my-host:11434/v1' });
    const result = await adapter.complete({ messages: [{ role: 'user', content: '读' }] });
    expect(result.toolCalls[0]).toMatchObject({ id: 'c1', name: 'read_file', arguments: { path: '/a' } });
  });
});
