// 联网搜索共用的 HTTP 辅助（Phase 18）。
//
// 两个要点（均为修正 paicli 占位实现的缺陷）：
// 1. combinedSignal：把「执行器传入的用户中断信号」与「工具自身超时」合并，
//    让用户 Ctrl+C 能真正中断搜索，且超时到点也能中止。paicli 原实现只用自建 timeout，
//    忽略了执行器信号，导致用户无法中断。
// 2. fetchSearch：统一封装 fetch，把底层网络/HTTP/中断错误翻译成可读 Error，
//    并对「网络层失败」按 retries 重试一次（带退避）。复用 chatmodel/errors 的 classifyFetchError。

import { classifyFetchError } from '../../chatmodel/errors';

/**
 * 合并用户中断信号与超时信号。
 * @param userSignal 执行器注入的 ToolContext.signal（可能为 undefined）
 * @param ms 工具自身超时（来自 SearchConfig.timeoutMs）
 */
export function combinedSignal(userSignal: AbortSignal | undefined, ms: number): AbortSignal {
  if (!userSignal) return AbortSignal.timeout(ms);
  return AbortSignal.any([userSignal, AbortSignal.timeout(ms)]);
}

export interface FetchSearchOpts {
  /** 错误描述上下文，如「Tavily 搜索」「DuckDuckGo 搜索」 */
  op: string;
  /** 网络层失败的重试次数，默认 1 */
  retries?: number;
  /** 重试退避毫秒，默认 500 */
  retryDelayMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 发起一次 fetch，返回 Response（已确认 !res.ok 之外的成功响应）。
 * - 网络层失败（连接超时 / DNS / 掉线）：按 retries 重试，退避后重来
 * - 用户中断（abort）/ HTTP 错误 / 其它：直接抛出可读错误，不重试
 * - 429 限流：在错误信息里追加提示
 */
export async function fetchSearch(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  opts: FetchSearchOpts,
): Promise<Response> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const hint = res.status === 429 ? '（搜索服务限流，请稍后重试或配置 API key）' : '';
        throw new Error(
          `搜索 HTTP ${res.status}: ${res.statusText} ${hint}${body ? '\n' + body.slice(0, 300) : ''}`.trim(),
        );
      }
      return res;
    } catch (err) {
      const ce = classifyFetchError(err, opts.op);
      // 仅网络层失败且还有重试额度才重试；abort/http/unknown 直接抛出
      if (ce.kind === 'network' && attempt < retries) {
        await delay(opts.retryDelayMs ?? 500);
        lastErr = ce;
        continue;
      }
      throw ce;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('搜索失败（未知错误）');
}
