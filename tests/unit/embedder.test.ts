import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HandwrittenEmbedder,
  ApiEmbedder,
  createEmbedder,
} from '../../src/core/rag/embedder';
import { embed, tokenize, cosine } from '../../src/core/rag/embed';

describe('HandwrittenEmbedder', () => {
  it('返回 L2 归一化向量，且与裸 embed() 完全一致', async () => {
    const e = new HandwrittenEmbedder();
    const v = await e.embed('检索增强生成');
    expect(e.id).toBe('tfidf:1024');
    expect(e.dim).toBe(1024);
    expect(Array.from(v)).toEqual(Array.from(embed(tokenize('检索增强生成'))));
    // 归一化：模长≈1
    let s = 0;
    for (const x of v) s += x * x;
    expect(Math.sqrt(s)).toBeCloseTo(1, 5);
  });

  it('相似文本余弦高于不相关文本', async () => {
    const e = new HandwrittenEmbedder();
    const a = await e.embed('你好世界机器学习');
    const b = await e.embed('你好世界深度学习');
    const c = await e.embed('量子计算加密通信');
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });
});

describe('ApiEmbedder', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('调用 /embeddings 并把返回向量 L2 归一化', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [3, 0, 4, 0] }] }),
    });
    const e = new ApiEmbedder({ baseURL: 'https://api.x/v1', apiKey: 'k', model: 'emb', dim: 4 });
    expect(e.id).toBe('api:emb');
    expect(e.dim).toBe(4);
    const v = await e.embed('hello');
    // Float32 精度：用 toBeCloseTo 而非精确相等
    expect(Number(v[0])).toBeCloseTo(3 / 5, 5);
    expect(Number(v[1])).toBe(0);
    expect(Number(v[2])).toBeCloseTo(4 / 5, 5);
    expect(Number(v[3])).toBe(0);
  });

  it('返回格式异常时抛错', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    const e = new ApiEmbedder({ baseURL: 'https://api.x/v1', apiKey: 'k', model: 'emb' });
    await expect(e.embed('x')).rejects.toThrow(/格式异常/);
  });
});

describe('createEmbedder 工厂', () => {
  it('默认返回手写实现', () => {
    expect(createEmbedder()).toBeInstanceOf(HandwrittenEmbedder);
  });
  it('api 配置返回 ApiEmbedder', () => {
    expect(createEmbedder({ type: 'api', baseURL: 'x', apiKey: 'k', model: 'm' })).toBeInstanceOf(
      ApiEmbedder,
    );
  });
});
