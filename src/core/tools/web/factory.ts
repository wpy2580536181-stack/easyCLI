// 搜索 Provider 工厂（Phase 18）。
//
// 按 config.search.provider 选择实现：tavily 需 key，缺 key 时降级到零 key 的 DuckDuckGo
// （调用方 main.ts 负责打印一次降级提示）。工具外壳只依赖返回的 SearchProvider。

import type { SearchConfig } from '../../../config';
import type { SearchProvider } from './types';
import { TavilyProvider } from './providers/tavily';
import { DuckDuckGoProvider } from './providers/duckduckgo';

export function createSearchProvider(cfg: SearchConfig): SearchProvider {
  if (cfg.provider === 'tavily') {
    if (cfg.apiKey) return new TavilyProvider(cfg);
    // 选中 tavily 但没给 key：降级到零 key 的 DuckDuckGo，保证可用
    return new DuckDuckGoProvider(cfg);
  }
  return new DuckDuckGoProvider(cfg);
}
