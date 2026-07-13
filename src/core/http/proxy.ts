// 共享的出口代理辅助（Phase 21 抽取）。
//
// 用途：让 LLM 适配器（chatmodel/*）与 web 工具（tools/web/*）复用同一套代理逻辑，
// 使内网/代理环境下的「模型 API 请求」与「联网搜索」走同一个出口代理（呼应 PaiCLI 文章
// 把 undici 列为「值得学」的点：显式控制连接出口，而非依赖全局 fetch 隐式行为）。
//
// 设计要点：
// 1. 探测顺序 HTTPS_PROXY → HTTP_PROXY（含小写变体）；
// 2. dispatcher 按「代理 URL」缓存失效：env 可能在运行时才注入，避免「启动后设代理却一直直连」；
// 3. localhost / 私网 / 命中 NO_PROXY 的目标自动绕过代理（不会把本机请求误送出口）；
// 4. 任何失败都安全降级为 undefined（直连），绝不让代理配置变成请求的阻断点。

import { ProxyAgent, type Dispatcher } from 'undici';

/** fetch 的扩展 init：Node 原生 RequestInit 不含 dispatcher（undici 专有），按需透传。 */
export type FetchInit = RequestInit & { dispatcher?: Dispatcher };

let cachedDispatcher: Dispatcher | undefined | null = null; // null = 尚未探测；undefined = 无代理
let cachedProxyUrl: string | undefined | null = null; // 上次探测所用的代理 URL（感知 env 变化）

function resolveProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    undefined
  );
}

/** 返回缓存的代理 dispatcher（未配置代理则返回 undefined）。创建失败也安全降级为 undefined。
 *  缓存按「代理 URL」失效：env 可能在运行时变化（进程启动后才注入代理），若探测时的 URL
 *  与当前不一致则重新探测，避免「启动后才设 HTTPS_PROXY 却始终走直连」的隐性失效。 */
export function getProxyDispatcher(): Dispatcher | undefined {
  const url = resolveProxyUrl();
  if (cachedDispatcher === null || cachedProxyUrl !== url) {
    cachedProxyUrl = url;
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
export function dispatcherForUrl(targetUrl: string): Dispatcher | undefined {
  const d = getProxyDispatcher();
  if (!d) return undefined;
  return shouldBypassProxy(targetUrl) ? undefined : d;
}
