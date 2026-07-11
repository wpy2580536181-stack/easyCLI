// Bing 搜索 Provider —— 零 key 兜底实现（Phase 20）。
//
// 与 DuckDuckGo 同构：抓 https://www.bing.com/search 的 HTML 结果页，用正则解析
// <li class="b_algo"> 块里的标题/链接/摘要。无需任何 API key。
//
// 为什么新增它：在受限网络（仅代理放行少数 host）中，DuckDuckGo 常被封锁，
// 而 Bing 经代理通常可达。把它作为默认零 key 搜索服务，web_search 在本机也能真正可用。

import type { SearchConfig } from '../../../../config';
import type { SearchOptions, SearchProvider, SearchResult } from '../types';
import { combinedSignal, fetchSearch } from '../fetch-util';

export class BingProvider implements SearchProvider {
  readonly name = 'bing';

  constructor(private readonly cfg: SearchConfig) {}

  async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`;
    const signal = combinedSignal(opts.signal, this.cfg.timeoutMs ?? 15_000);
    const res = await fetchSearch(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; agent-cli/0.1; +https://example.com)' } },
      signal,
      { op: 'Bing 搜索' },
    );
    const html = await res.text();
    return parseBingResults(html).slice(0, opts.maxResults);
  }
}

interface RawResult {
  title: string;
  url: string;
  snippet: string;
}

/** 正则解析 Bing 搜索结果页的 <li class="b_algo"> 块 */
function parseBingResults(html: string): RawResult[] {
  const results: RawResult[] = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) ?? [];

  for (const block of blocks) {
    // 链接：优先 h2 里的 <a href>，退而求其次取块内第一个 http(s) 链接
    const hrefMatch =
      block.match(/<h2>\s*<a[^>]+href="([^"]+)"/i) ||
      block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    const url = hrefMatch ? decodeHtml(hrefMatch[1] ?? '') : '';
    if (!/^https?:\/\//.test(url)) continue;

    const titleMatch = block.match(/<h2>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleMatch ? decodeHtml(stripTags(titleMatch[1] ?? '')) : url;

    // 摘要：优先 b_lineclamp / b_caption，退而求其次取块内第一个 <p>
    const snippetMatch =
      block.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/i) ||
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(stripTags(snippetMatch[1] ?? '')) : '';

    results.push({ title, url, snippet });
  }
  return results;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}
