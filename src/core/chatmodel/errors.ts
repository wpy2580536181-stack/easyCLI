/**
 * 模型请求错误分类（Phase 18）。
 *
 * 痛点：之前 `fetch` 失败会直接抛 `TypeError: fetch failed`（cause 是 undici 的
 * `ConnectTimeoutError`），这个原始异常冒泡成「未处理的 Promise 异常」，把整个 CLI
 * 进程打崩并吐出一长串 Node 内部堆栈（`triggerUncaughtException` → ELIFECYCLE exit 1）。
 *
 * 解决：把底层网络/HTTP 错误统一翻译成可读的 `ModelRequestError`，并带上 `kind`
 * （network/http/abort/unknown），让上层（REPL）能给出友好提示而非崩溃。
 */

export type ModelErrorKind = 'network' | 'http' | 'abort' | 'unknown';

export class ModelRequestError extends Error {
  readonly kind: ModelErrorKind;
  readonly status?: number;

  constructor(kind: ModelErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ModelRequestError';
    this.kind = kind;
    this.status = status;
  }
}

/** 会判定为「网络层失败」的 errno / undici 错误名 */
const NETWORK_CODES = new Set<string>([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_OTHER',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** 判断一个底层错误是否为「网络层失败」 */
function isNetworkFailure(err: any): boolean {
  const msg: string = err?.message ?? String(err);
  const code: string | undefined = err?.code ?? err?.cause?.code;
  const causeName: string | undefined = err?.cause?.name;
  if (msg.includes('fetch failed')) return true; // Node 的 fetch 失败通用文案，cause 才是真因
  if (code && NETWORK_CODES.has(code)) return true;
  if (causeName === 'ConnectTimeoutError' || causeName === 'ConnectError' || causeName === 'DNSLookupError') {
    return true;
  }
  return false;
}

/** 判断是否为用户主动中断（Ctrl+C 触发的 AbortSignal） */
function isAbort(err: any): boolean {
  return (
    err?.name === 'AbortError' ||
    err?.code === 'ABORT_ERR' ||
    err?.name === 'CanceledError' ||
    err?.cause?.name === 'AbortError'
  );
}

/**
 * 把任意 fetch 抛出的底层错误翻译成 `ModelRequestError`。
 * @param err 原始异常（fetch 抛出的 TypeError / undici 错误等）
 * @param op  上下文描述，如「调用 deepseek-chat」
 */
export function classifyFetchError(err: unknown, op = '请求模型服务'): ModelRequestError {
  const e = err as any;

  if (isAbort(e)) {
    return new ModelRequestError('abort', '请求已被中断（Ctrl+C）');
  }

  if (isNetworkFailure(e)) {
    const code: string | undefined = e?.code ?? e?.cause?.code;
    const where = code ? `（${code}）` : '（无法建立连接）';
    return new ModelRequestError(
      'network',
      `网络连接失败${where}：${op}时无法连接模型服务。请检查本机网络、代理设置、API 端点与密钥是否正确。`,
    );
  }

  const msg: string = e?.message ?? String(err);
  return new ModelRequestError('unknown', `${op}出错：${msg}`);
}

/** 便捷判断 */
export function isNetworkError(err: unknown): err is ModelRequestError {
  return err instanceof ModelRequestError && err.kind === 'network';
}
