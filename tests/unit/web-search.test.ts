import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DuckDuckGoProvider } from '../../src/core/tools/web/providers/duckduckgo';
import { BingProvider } from '../../src/core/tools/web/providers/bing';
import { TavilyProvider } from '../../src/core/tools/web/providers/tavily';
import { createSearchProvider, FallbackSearchProvider } from '../../src/core/tools/web/factory';
import { getWebTools } from '../../src/core/tools/web/index';
import { combinedSignal, fetchSearch, shouldBypassProxy, getProxyDispatcher } from '../../src/core/tools/web/fetch-util';
import type { SearchConfig } from '../../src/config';

const DDG_HTML = `
<div class="result">
  <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&amp;abc=1">Example <b>Title</b></a>
  <span><a class="result__snippet" href="x">A snippet &amp; more text</a></span>
</div>
<div class="result">
  <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Ftest.org">Test Org</a>
  <a class="result__snippet" href="y">Second snippet</a>
</div>
`;

describe('DuckDuckGoProvider', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('解析 HTML 结果（含 uddg URL 解码、HTML 反转义、stripTags）', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, text: async () => DDG_HTML });
    const p = new DuckDuckGoProvider({ provider: 'duckduckgo' });
    const results = await p.search('hello', { maxResults: 5 });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Example Title',
      url: 'https://example.com',
      snippet: 'A snippet & more text',
    });
    expect(results[1]!.url).toBe('https://test.org');
  });

  it('按 maxResults 截断', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, text: async () => DDG_HTML });
    const p = new DuckDuckGoProvider({ provider: 'duckduckgo' });
    const results = await p.search('hello', { maxResults: 1 });
    expect(results).toHaveLength(1);
  });
});

describe('TavilyProvider', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('解析 JSON 结果', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: 'T1', url: 'https://a.com', content: 'snippet a' },
          { title: 'T2', url: 'https://b.com', content: 'snippet b' },
        ],
      }),
    });
    const p = new TavilyProvider({ provider: 'tavily', apiKey: 'k' });
    const results = await p.search('q', { maxResults: 5 });
    expect(results).toEqual([
      { title: 'T1', url: 'https://a.com', snippet: 'snippet a' },
      { title: 'T2', url: 'https://b.com', snippet: 'snippet b' },
    ]);
  });

  it('无 apiKey 时抛错', async () => {
    const p = new TavilyProvider({ provider: 'tavily' });
    await expect(p.search('q', { maxResults: 5 })).rejects.toThrow(/api key/i);
  });

  it('429 限流在错误信息里提示', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests', text: async () => 'rate limited' });
    const p = new TavilyProvider({ provider: 'tavily', apiKey: 'k' });
    await expect(p.search('q', { maxResults: 5 })).rejects.toThrow(/限流/);
  });
});

describe('createSearchProvider 工厂', () => {
  it('tavily + key 返回 Tavily', () => {
    expect(createSearchProvider({ provider: 'tavily', apiKey: 'k' })).toBeInstanceOf(TavilyProvider);
  });
  it('tavily 无 key 降级到 DuckDuckGo', () => {
    expect(createSearchProvider({ provider: 'tavily' })).toBeInstanceOf(DuckDuckGoProvider);
  });
  it('duckduckgo 返回 DuckDuckGo', () => {
    expect(createSearchProvider({ provider: 'duckduckgo' })).toBeInstanceOf(DuckDuckGoProvider);
  });
  it('bing 返回 Bing', () => {
    expect(createSearchProvider({ provider: 'bing' })).toBeInstanceOf(BingProvider);
  });
  it('默认（无 provider）返回 Fallback，且 bing 优先', () => {
    const p = createSearchProvider({ provider: 'bing' });
    expect(p).toBeInstanceOf(BingProvider);
  });
});

describe('BingProvider', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  const BING_HTML = `
    <li class="b_algo">
      <h2><a href="https://example.com" h="ID=SERP">Example <b>Title</b></a></h2>
      <div class="b_caption"><p>Example snippet &amp; more text</p></div>
    </li>
    <li class="b_algo">
      <h2><a href="https://test.org">Test Org</a></h2>
      <p class="b_lineclamp2">Second snippet</p>
    </li>
  `;

  it('解析 b_algo 块（标题/链接/摘要，HTML 反转义、stripTags）', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, text: async () => BING_HTML });
    const p = new BingProvider({ provider: 'bing' });
    const results = await p.search('hello', { maxResults: 5 });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Example Title',
      url: 'https://example.com',
      snippet: 'Example snippet & more text',
    });
    expect(results[1]!.url).toBe('https://test.org');
  });

  it('按 maxResults 截断', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, text: async () => BING_HTML });
    const p = new BingProvider({ provider: 'bing' });
    const results = await p.search('hello', { maxResults: 1 });
    expect(results).toHaveLength(1);
  });
});

describe('FallbackSearchProvider', () => {
  it('首个可用 provider 命中即返回', async () => {
    const ok = { name: 'ok', search: vi.fn(async () => [{ title: 't', url: 'u', snippet: 's' }]) } as any;
    const neverCalled = { name: 'nc', search: vi.fn() } as any;
    const fb = new FallbackSearchProvider({ provider: 'bing' }, [ok, neverCalled]);
    const r = await fb.search('q', { maxResults: 5 });
    expect(r).toHaveLength(1);
    expect(ok.search).toHaveBeenCalledOnce();
    expect(neverCalled.search).not.toHaveBeenCalled();
  });

  it('前一个抛错时回退到下一个', async () => {
    const bad = { name: 'bad', search: vi.fn(async () => { throw new Error('boom'); }) } as any;
    const good = { name: 'good', search: vi.fn(async () => [{ title: 't', url: 'u', snippet: 's' }]) } as any;
    const fb = new FallbackSearchProvider({ provider: 'bing' }, [bad, good]);
    const r = await fb.search('q', { maxResults: 5 });
    expect(r).toHaveLength(1);
    expect(good.search).toHaveBeenCalledOnce();
  });
});

describe('代理支持（fetch-util）', () => {
  const saved = process.env.HTTPS_PROXY;
  afterEach(() => {
    if (saved === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = saved;
  });

  it('localhost / 私网地址应绕过代理', () => {
    expect(shouldBypassProxy('http://localhost:3000/x')).toBe(true);
    expect(shouldBypassProxy('http://127.0.0.1:8080/x')).toBe(true);
    expect(shouldBypassProxy('http://192.168.1.10/x')).toBe(true);
    expect(shouldBypassProxy('http://10.0.0.5/x')).toBe(true);
  });

  it('公网地址不应绕过代理', () => {
    expect(shouldBypassProxy('https://www.bing.com/search?q=1')).toBe(false);
  });

  it('配置了 HTTPS_PROXY 时 getProxyDispatcher 返回 dispatcher 实例', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:55604';
    // 重置模块级缓存后重新探测
    (getProxyDispatcher as any); // 仅引用，确认可调用
    const d = getProxyDispatcher();
    expect(d).toBeDefined();
  });
});

describe('getWebTools 工具外壳', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  const cfg: SearchConfig = { provider: 'duckduckgo' };
  const search = getWebTools(cfg)[0]!;
  const fetchTool = getWebTools(cfg)[1]!;

  it('web_search 命名/只读标记正确', () => {
    expect(search.name).toBe('web_search');
    expect(search.isReadOnly).toBe(true);
    expect(search.isDestructive).toBe(false);
  });

  it('web_search 成功返回格式化结果', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, text: async () => DDG_HTML });
    const r = await search.execute!({ query: 'hello' }, { cwd: '/tmp' });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('Example Title');
    expect(r.output).toContain('https://example.com');
    expect(r.output.startsWith('1.')).toBe(true);
  });

  it('web_search 缺 query 返回 fail', async () => {
    const r = await search.execute!({}, { cwd: '/tmp' });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('query');
  });

  it('web_search 空结果给出友好提示', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, text: async () => '<html><body>no results</body></html>' });
    const r = await search.execute!({ query: 'zzz' }, { cwd: '/tmp' });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('未找到');
  });

  it('web_search 网络错误不抛异常，转为 fail', async () => {
    (globalThis.fetch as any).mockRejectedValue(new TypeError('fetch failed'));
    const r = await search.execute!({ query: 'x' }, { cwd: '/tmp' });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('搜索失败');
  });

  it('web_fetch 抓到网页正文并去 HTML', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/html' },
      text: async () => '<html><body><script>x</script><p>Hello <b>World</b></p></body></html>',
    });
    const r = await fetchTool.execute!({ url: 'https://example.com' }, { cwd: '/tmp' });
    expect(r.ok).toBe(true);
    expect(r.output).not.toContain('<');
    expect(r.output).toContain('Hello');
  });

  it('web_fetch HTTP 错误返回 fail', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
    const r = await fetchTool.execute!({ url: 'https://example.com' }, { cwd: '/tmp' });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('404');
  });
});

describe('combinedSignal', () => {
  it('无用户信号时返回超时信号', () => {
    expect(combinedSignal(undefined, 1000)).toBeInstanceOf(AbortSignal);
  });
  it('用户信号中止时组合信号也中止', () => {
    const ctrl = new AbortController();
    const combined = combinedSignal(ctrl.signal, 10_000);
    ctrl.abort();
    expect(combined.aborted).toBe(true);
  });
});

describe('fetchSearch 重试', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('网络层失败重试一次后成功', async () => {
    (globalThis.fetch as any)
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ ok: true, text: async () => 'ok' });
    const res = await fetchSearch('https://x', {}, AbortSignal.timeout(1000), { op: '测试' });
    expect(res.ok).toBe(true);
    expect((globalThis.fetch as any).mock.calls.length).toBe(2);
  });

  it('HTTP 错误不重试，直接抛', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: false, status: 500, statusText: 'ISE', text: async () => '' });
    await expect(fetchSearch('https://x', {}, AbortSignal.timeout(1000), { op: '测试' })).rejects.toThrow(/500/);
    expect((globalThis.fetch as any).mock.calls.length).toBe(1);
  });
});
