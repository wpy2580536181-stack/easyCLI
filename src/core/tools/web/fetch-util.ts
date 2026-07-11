// 联网搜索共用的 HTTP 辅助（Phase 18 + Phase 20 增强）。
//
// 三个要点：
// 1. combinedSignal：把「执行器传入的用户中断信号」与「工具自身超时」合并，
//    让用户 Ctrl+C 能真正中断搜索，且超时到点也能中止。
// 2. fetchSearch / fetchViaProxy：统一封装 fetch，把底层网络/HTTP/中断错误翻译成可读 Error，
//    并对「网络层失败」按 retries 重试一次（带退避）。复用 chatmodel/errors 的 classifyFetchError。
// 3. 代理支持（Phase 20 增强）：检测到 HTTPS_PROXY/HTTP_PROXY 时，用 undici ProxyAgent 作为
//    fetch 的 dispatcher，使 web 工具走与模型 API 相同的出口代理；并对 localhost/私网/NO_PROXY
//    目标自动绕过代理、网络失败时回退直连，避免把本机请求误送代理或单点失败。

import { ProxyAgent, type Dispatcher } from 'undici';
import { classifyFetchError, ModelRequestError } from '../../chatmodel/errors';

/**
 * 合并用户中断信号与超时信号。
 * @param userSignal 执行器注入的 ToolContext.signal（可能为 undefined）
 * @param ms 工具自身超时（来自 SearchConfig.timeoutMs）
 */
export function combinedSignal(userSignal: AbortSignal | undefined, ms: number): AbortSignal {
  if (!userSignal) return AbortSignal.timeout(ms);
  return AbortSignal.any([userSignal, AbortSignal.timeout(ms)]);
}

// ───────────────────────────── 代理支持 ─────────────────────────────

let cachedDispatcher: Dispatcher | undefined | null = null; // null = 尚未探测；undefined = 无代理

function resolveProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    undefined
  );
}

/** 返回缓存的代理 dispatcher（未配置代理则返回 undefined）。创建失败也安全降级为 undefined。 */
export function getProxyDispatcher(): Dispatcher | undefined {
  if (cachedDispatcher === null) {
    const url = resolveProxyUrl();
    try {
      cachedDispatcher = url ? new ProxyAgent(url) : undefined;
    } catch {
      cachedDispatcher = undefined;
    }
  }
  return cachedDispatcher;
}

/** 是否应绕过代理（localhost / 私网 / 命中 NO_PROXY）。 */
export function shouldBypassProxy(targetUrl: string): boolean {
  let host: string | undefined;
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    return false;
  }
  if (!host) return false;
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  // NO_PROXY：逗号/空格/分号分隔，支持前导点后缀匹配（.example.com 匹配 a.example.com）与精确匹配
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (noProxy) {
    for (const entry of noProxy.split(/[,\s;]+/).filter(Boolean)) {
      const e = entry.toLowerCase();
      if (e === h || (e.startsWith('.') && (h === e.slice(1) || h.endsWith(e)))) return true;
    }
  }
  return false;
}

/** 计算目标 URL 实际要用的 dispatcher：有代理且未绕过则用代理，否则直连（undefined）。 */
function dispatcherFor(url: string): Dispatcher | undefined {
  const d = getProxyDispatcher();
  if (!d) return undefined;
  return shouldBypassProxy(url) ? undefined : d;
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

type FetchInit = RequestInit & { dispatcher?: Dispatcher };

/**
 * 发起一次搜索用 fetch，返回 Response（已确认 !res.ok 之外的成功响应）。
 * - 若配置了代理且目标非绕过列表，优先走代理；代理网络失败时回退直连一次。
 * - 同一出口内的网络层失败（连接超时 / DNS / 掉线）按 retries 重试，退避后重来。
 * - 用户中断（abort）/ HTTP 错误 / 其它：直接抛出可读错误，不重试。
 */
export async function fetchSearch(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  opts: FetchSearchOpts,
): Promise<Response> {
  const dispatcher = dispatcherFor(url);
  const modes: Array<Dispatcher | undefined> = dispatcher ? [dispatcher, undefined] : [undefined];
  const retries = opts.retries ?? 1;
  let lastErr: unknown;

  for (const mode of modes) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, { ...init, signal, dispatcher: mode } as FetchInit);
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const hint = res.status === 429 ? '（搜索服务限流，请稍后重试或配置 API key）' : '';
          throw new ModelRequestError(
            'http',
            `搜索 HTTP ${res.status}: ${res.statusText} ${hint}${body ? '\n' + body.slice(0, 300) : ''}`.trim(),
            res.status,
          );
        }
        return res;
      } catch (err) {
        const ce = classifyFetchError(err, opts.op);
        // 仅网络层失败才可能重试 / 切换出口
        if (ce.kind === 'network') {
          lastErr = ce;
          if (attempt < retries) {
            await delay(opts.retryDelayMs ?? 500);
            continue; // 同一出口重试
          }
          break; // 本出口重试耗尽 → 尝试下一个出口（代理→直连）
        }
        throw ce; // http / abort / unknown 直接抛
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('搜索失败（未知错误）');
}

/**
 * 发起一次抓取用 fetch，返回 Response（任何 HTTP 状态都返回，由调用方决定如何解释）。
 * 同样具备代理优先 + 直连回退 + 网络错误翻译。
 */
export async function fetchViaProxy(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  op: string,
): Promise<Response> {
  const dispatcher = dispatcherFor(url);
  const modes: Array<Dispatcher | undefined> = dispatcher ? [dispatcher, undefined] : [undefined];
  let lastErr: unknown;

  for (const mode of modes) {
    try {
      return await fetch(url, { ...init, signal, dispatcher: mode } as FetchInit);
    } catch (err) {
      const ce = classifyFetchError(err, op);
      if (ce.kind === 'network') {
        lastErr = ce;
        continue; // 网络失败 → 尝试下一出口（代理→直连）
      }
      throw ce;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('抓取失败（未知错误）');
}
