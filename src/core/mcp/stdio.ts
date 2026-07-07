// Phase 12：MCP stdio 传输层（与 McpClient 的 stdio 约定完全一致）。
//
// 约定：每条 JSON-RPC 消息占一行（换行分隔），stdout 输出的也是单行 JSON。
// 比 HTTP 的 Content-Length 头更轻量，是 MCP stdio 的事实标准。
// 注意：stdout 是「协议通道」，任何调试日志都必须走 stderr，否则会污染 JSON-RPC 流。
//
// 退出语义（易踩坑点，本项目实测踩过）：
// 1. 收到 exit 通知 / stdin 关闭(EOF) 时，必须先等「在途的 handleMessage 响应」写完，
//    再用 stdout.end(cb) 触发 process.exit——否则 process.exit 会截断最后一条响应
//    （实测曾抛 ERR_STREAM_WRITE_AFTER_END，或静默丢包）。
// 2. 绝不能把「stdin 关闭(EOF)」直接接 hardExit：EOF 常与 exit 通知/父进程断开同期到达，
//    硬杀会抢在在途 bash 等慢调用之前，导致响应丢失。故 EOF 也走优雅停机。

import { createInterface, type Interface } from 'node:readline';
import type { McpServer, JsonRpcRequest, JsonRpcResponse } from './server';

export interface StdioTransportOptions {
  server: McpServer;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** stdio 传输：从 stdin 逐行读 JSON-RPC，dispatch 后把响应写回 stdout。 */
export class StdioTransport {
  private rl?: Interface;
  private closed = false;
  private readonly server: McpServer;
  private readonly stdin: NodeJS.ReadableStream;
  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: NodeJS.WritableStream;
  /** 在途的「请求处理 + 写回」任务，用于退出前等待全部刷出 */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(opts: StdioTransportOptions) {
    this.server = opts.server;
    this.stdin = opts.stdin ?? process.stdin;
    this.stdout = opts.stdout ?? process.stdout;
    this.stderr = opts.stderr ?? process.stderr;
  }

  start(): void {
    // crlfDelay: Infinity 让跨多行的 CRLF 不被截断；terminal:false 关闭 TTY 特性
    this.rl = createInterface({ input: this.stdin, crlfDelay: Infinity, terminal: false });
    this.rl.on('line', (line) => void this.onLine(line));
    // stdin 关闭(EOF) → 优雅停机（而非硬杀，避免截断在途响应）
    this.rl.on('close', () => void this.shutdown());

    // 进程级信号：优雅停机（外部强杀也先尽量刷出缓冲）
    process.on('SIGINT', () => void this.shutdown());
    process.on('SIGTERM', () => void this.shutdown());
  }

  private async onLine(line: string): Promise<void> {
    const text = line.trim();
    if (!text) return;

    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(text) as JsonRpcRequest;
    } catch {
      // 单行 JSON 解析失败——无 id 无法回包，按 MCP 建议忽略（不中断连接）
      this.stderr.write('[mcp] 忽略无法解析的行\n');
      return;
    }

    // 通知（无 id）：exit 需优雅停机；其余忽略
    if (msg.id === undefined) {
      if (msg.method === 'exit') void this.shutdown();
      return;
    }

    // 把「请求处理 + 写回」作为一个整体任务，纳入在途集合，便于退出前等待
    const task = (async () => {
      const resp: JsonRpcResponse | null = await this.server.handleMessage(msg);
      if (resp) this.write(resp);
    })();
    this.inFlight.add(task);
    await task;
    this.inFlight.delete(task);
  }

  private write(obj: unknown): void {
    if (this.closed) return; // 已停机则丢弃后续写入（理论上不会发生）
    try {
      this.stdout.write(JSON.stringify(obj) + '\n');
    } catch {
      /* stdout 已关闭时忽略 */
    }
  }

  /** 优雅停机：停读新输入 → 等所有在途响应写完 → 刷出 stdout → 退出 */
  private async shutdown(): Promise<void> {
    if (this.closed) return; // 幂等
    try {
      this.rl?.pause();
    } catch {
      /* ignore */
    }
    // 关键：先等所有在途任务（含其 write）完成，才能安全结束 stdout
    await Promise.allSettled([...this.inFlight]);

    // end(cb)：把缓冲中全部响应刷到内核后再退出，杜绝 process.exit 截断最后一条响应
    this.closed = true;
    try {
      this.stdout.end(() => process.exit(0));
    } catch {
      process.exit(0);
    }
    // 兜底：若 1s 内未退出（极端情况，如 stdout 卡住），强制退出
    const t = setTimeout(() => process.exit(0), 1000);
    if (typeof t.unref === 'function') t.unref();
  }
}
