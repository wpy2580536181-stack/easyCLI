// 联网搜索 Provider 抽象（Phase 18 设计）。
//
// 把「搜索服务」与「工具外壳」解耦：web_search / web_fetch 两个工具只读 SearchProvider，
// 不关心底层是 Tavily（正式 API，需 key）还是 DuckDuckGo（抓 HTML，零 key 兜底）。
// 仿照项目既有的 ChatModel / Embedder 的 Provider 无关哲学。

/** 单条搜索结果 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 一次搜索调用的选项（maxResults 由工具层在配置上限内约束后传入） */
export interface SearchOptions {
  maxResults: number;
  /** 来自 ToolContext.signal，用于支持用户 Ctrl+C 中断（修正 paicli 未用执行器信号的缺陷） */
  signal?: AbortSignal;
}

/** 搜索服务抽象；所有 Provider 实现同一接口，工具外壳只依赖它 */
export interface SearchProvider {
  /** 实现名：'tavily' | 'duckduckgo'，用于日志/调试 */
  readonly name: string;
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>;
}
