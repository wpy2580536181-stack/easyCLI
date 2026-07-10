// DuckDuckGo 搜索 Provider —— 零 key 兜底实现（Phase 18）。
//
// 移植自 paicli-ts 的 WebSearchTool：抓 duckduckgo.com/html 的搜索结果页，用正则解析
// result__a / result__snippet，再做 stripTags + HTML 实体反转义。无需任何 API key，
// 作为开箱即用的兜底；正式生产建议配 Tavily（见 tavily.ts）。

import type { SearchConfig } from '../../../../config';
import type { SearchOptions, SearchProvider, SearchResult } from '../types';
import { combinedSignal, fetchSearch } from '../fetch-util';

export class DuckDuckGoProvider implements SearchProvider {
  readonly name = 'duckduckgo';

  constructor(private readonly cfg: SearchConfig) {}

  async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const signal = combinedSignal(opts.signal, this.cfg.timeoutMs ?? 15_000);
    const res = await fetchSearch(
      url,
      { headers: { 'User-Agent': 'agent-cli/0.1' } },
      signal,
      { op: 'DuckDuckGo 搜索' },
    );
    const html = await res.text();
    return parseDuckDuckGoResults(html).slice(0, opts.maxResults);
  }
}

interface RawResult {
  title: string;
  url: string;
  snippet: string;
}

/** 正则解析 DuckDuckGo HTML 结果页（来自 paicli-ts，已验证可用） */
function parseDuckDuckGoResults(html: string): RawResult[] {
  const results: RawResult[] = [];
  const resultRegex =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = resultRegex.exec(html)) !== null) {
    results.push({
      title: decodeHtml(stripTags(match[2] ?? '')),
      url: normalizeDuckDuckGoUrl(decodeHtml(match[1] ?? '')),
      snippet: decodeHtml(stripTags(match[3] ?? '')),
    });
  }
  return results;
}

/** DuckDuckGo 把真实地址藏在 uddg 参数里，需解码还原 */
function normalizeDuckDuckGoUrl(url: string): string {
  try {
    const parsed = new URL(url, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : parsed.toString();
  } catch {
    return url;
  }
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
