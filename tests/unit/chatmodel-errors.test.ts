import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyFetchError, ModelRequestError, isNetworkError } from '../../src/core/chatmodel/errors';
import { OpenAICompatibleAdapter } from '../../src/core/chatmodel/openai-compatible';

describe('classifyFetchError（模型请求错误分类）', () => {
  it('fetch failed + ConnectTimeoutError 归类为 network', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('Connect Timeout Error'), { name: 'ConnectTimeoutError' }),
    });
    const r = classifyFetchError(err, '调用 agnes-2.0-flash');
    expect(r).toBeInstanceOf(ModelRequestError);
    expect(r.kind).toBe('network');
    expect(r.message).toContain('网络连接失败');
    expect(r.message).toContain('agnes-2.0-flash');
  });

  it('ENOTFOUND / ECONNREFUSED 等 errno 归类为 network', () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT']) {
      const err = Object.assign(new Error('something'), { code });
      const r = classifyFetchError(err);
      expect(r.kind).toBe('network');
    }
  });

  it('AbortError 归类为 abort（用户 Ctrl+C 中断，无需提示）', () => {
    const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const r = classifyFetchError(err);
    expect(r.kind).toBe('abort');
  });

  it('其它未知错误归类为 unknown', () => {
    const r = classifyFetchError(new Error('boom'));
    expect(r.kind).toBe('unknown');
    expect(r.message).toContain('boom');
  });

  it('isNetworkError 类型守卫', () => {
    expect(isNetworkError(classifyFetchError(new TypeError('fetch failed')))).toBe(true);
    expect(isNetworkError(new Error('x'))).toBe(false);
  });
});

describe('OpenAICompatibleAdapter 错误处理', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const cfg = {
    baseURL: 'https://example.test/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    stream: false as const,
  };

  it('fetch 抛网络错误时，complete 抛 ModelRequestError(kind=network) 而非原始 TypeError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('Connect Timeout Error'), { name: 'ConnectTimeoutError' }),
        }),
      ),
    );
    const adapter = new OpenAICompatibleAdapter(cfg);
    await expect(
      adapter.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('HTTP 非 2xx 时，complete 抛 ModelRequestError(kind=http) 并带状态码', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'unauthorized',
      }),
    );
    const adapter = new OpenAICompatibleAdapter(cfg);
    const err = await adapter
      .complete({ messages: [{ role: 'user', content: 'hi' }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ModelRequestError);
    expect(err.kind).toBe('http');
    expect(err.status).toBe(401);
  });
});
