// Tavily 搜索 Provider —— 正式 API 实现（Phase 18，推荐生产使用）。
//
// Tavily 是专为 LLM 设计的搜索 API，返回结构化 results[]（title/url/content），
// 质量与稳定性均优于抓 HTML 的 DuckDuckGo。需 api key（AGENTCLI_SEARCH_API_KEY 或 config.json）。
// 接口：POST https://api.tavily.com/search，body 含 api_key / query / max_results / search_depth。

import type { SearchConfig } from '../../../../config';
import type { SearchOptions, SearchProvider, SearchResult } from '../types';
import { combinedSignal, fetchSearch } from '../fetch-util';

export class TavilyProvider implements SearchProvider {
  readonly name = 'tavily';

  constructor(private readonly cfg: SearchConfig) {}

  async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    if (!this.cfg.apiKey) {
      throw new Error(
        'Tavily 搜索需要配置 api key：设置环境变量 AGENTCLI_SEARCH_API_KEY 或 config.json 的 search.apiKey',
      );
    }
    const url = 'https://api.tavily.com/search';
    const signal = combinedSignal(opts.signal, this.cfg.timeoutMs ?? 15_000);
    const res = await fetchSearch(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          api_key: this.cfg.apiKey,
          query,
          max_results: opts.maxResults,
          search_depth: 'basic',
        }),
      },
      signal,
      { op: 'Tavily 搜索' },
    );
    const json: any = await res.json();
    const raw: any[] = Array.isArray(json?.results) ? json.results : [];
    return raw.slice(0, opts.maxResults).map((r: any) => ({
      title: String(r?.title ?? ''),
      url: String(r?.url ?? ''),
      snippet: String(r?.content ?? r?.snippet ?? ''),
    }));
  }
}
