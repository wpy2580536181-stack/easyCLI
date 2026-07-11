// 搜索 Provider 工厂（Phase 18 + Phase 20 增强）。
//
// 按 config.search.provider 选择实现：
// - 'tavily'：需 key，缺 key 时降级到零 key 的 DuckDuckGo（调用方 main.ts 负责打印一次降级提示）。
// - 'bing'：零 key，抓 Bing HTML，在受限网络/代理下通常可达。
// - 'duckduckgo'：零 key，抓 DuckDuckGo HTML（开箱即用，但某些网络会被封锁）。
// - 默认（未显式指定 provider）：FallbackSearchProvider，按 [bing, duckduckgo] 顺序尝试，
//   任一可用即返回，最大化「开箱即用」成功率。

import type { SearchConfig } from '../../../config';
import type { SearchProvider, SearchOptions, SearchResult } from './types';
import { TavilyProvider } from './providers/tavily';
import { DuckDuckGoProvider } from './providers/duckduckgo';
import { BingProvider } from './providers/bing';

export function createSearchProvider(cfg: SearchConfig): SearchProvider {
  if (cfg.provider === 'tavily') {
    if (cfg.apiKey) return new TavilyProvider(cfg);
    // 选中 tavily 但没给 key：降级到零 key 的 DuckDuckGo，保证可用
    return new DuckDuckGoProvider(cfg);
  }
  if (cfg.provider === 'bing') return new BingProvider(cfg);
  if (cfg.provider === 'duckduckgo') return new DuckDuckGoProvider(cfg);
  // 默认：bing 优先（受限网络更可能可达），duckduckgo 兜底
  return new FallbackSearchProvider(cfg, [new BingProvider(cfg), new DuckDuckGoProvider(cfg)]);
}

/**
 * 顺序尝试多个 Provider，第一个成功（未抛错且返回非空）即采用；全部失败则抛出最后一个错误。
 * 用于默认零 key 场景，提升「开箱即用」鲁棒性。
 */
export class FallbackSearchProvider implements SearchProvider {
  readonly name = 'fallback';

  constructor(
    private readonly cfg: SearchConfig,
    private readonly providers: SearchProvider[],
  ) {}

  async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    let lastErr: unknown;
    for (const p of this.providers) {
      try {
        const results = await p.search(query, opts);
        if (results.length > 0) return results;
        // 返回空（无结果）也视为「该 provider 可用但没命中」，继续尝试下一个以兜底
        lastErr = new Error(`搜索服务 ${p.name} 未返回结果`);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('搜索失败（未知错误）');
  }
}
