// Phase 5：MCP 客户端（stdio + JSON-RPC 2.0），纯手写，不引官方 SDK。
//
// 设计要点：
// 1. 传输层：child_process.spawn 拉起 MCP Server，stdin/stdout 走「换行分隔的 JSON-RPC」；
//    这是 MCP stdio 约定的事实标准（每条消息一行 JSON，比 HTTP 的 Content-Length 头更轻）。
// 2. 连接状态机：disconnected → initializing → ready → closed，
//    未就绪时禁止 listTools/callTool，避免协议层级错乱。
// 3. 握手：initialize（协商 protocolVersion）→ 发送 notifications/initialized → ready。
// 4. 超时：initialize 用 connectTimeoutMs，tools/call 用 timeoutMs；静默/假死服务端必须能超时失败。
// 5. 工具归一化：MCP 工具转成统一 ToolDef，execute 内部转调 tools/call，
//    从而与内置工具走同一套执行器、权限、审计、事件总线（安全默认一致）。

import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolDef } from '../chatmodel/types';

export type McpState = 'disconnected' | 'initializing' | 'ready' | 'closed';

/** 一个 MCP Server 的启动规格（stdio：本地可执行命令） */
export interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpClientOptions {
  /** 单次请求（含 tools/call）超时，默认 30000ms */
  timeoutMs?: number;
  /** initialize 握手超时，默认 15000ms */
  connectTimeoutMs?: number;
}

/** MCP tools/list 返回的单条工具描述 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

// ── JSON-RPC 2.0 报文类型（手写，不依赖 SDK） ──────────────
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}
interface Pending {
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const SUPPORTED_PROTOCOL = '2024-11-05';

/**
 * 手写 MCP 客户端：通过 stdio 与单个 MCP Server 通信。
 * 对外暴露 connect / listTools / callTool / disconnect，
 * 内部维护请求-响应配对（按 id 匹配）与连接状态机。
 */
export class McpClient {
  private state: McpState = 'disconnected';
  private child: ChildProcess | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private stderrChunks: string[] = [];
  private closedByUs = false;

  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;

  constructor(
    private readonly spec: McpServerSpec,
    opts: McpClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
  }

  getState(): McpState {
    return this.state;
  }

  /** 已协商的协议版本（initialize 成功后才有意义） */
  negotiatedProtocol?: string;

  // ── 生命周期：connect ────────────────────────────────
  async connect(): Promise<void> {
    if (this.state !== 'disconnected') {
      throw new Error(`MCP 连接状态非法：当前为 ${this.state}，期望 disconnected`);
    }
    this.state = 'initializing';

    const child = spawn(this.spec.command, this.spec.args ?? [], {
      cwd: this.spec.cwd,
      env: { ...process.env, ...(this.spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.on('error', (err) => this.failAll(new Error(`子进程启动失败: ${err.message}`)));
    child.on('exit', (code, signal) => {
      if (!this.closedByUs) {
        this.failAll(
          new Error(`MCP 子进程意外退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`),
        );
      }
      this.state = 'closed';
    });
    child.stderr?.on('data', (d: Buffer) => {
      this.stderrChunks.push(d.toString('utf8'));
      if (this.stderrChunks.length > 50) this.stderrChunks.shift();
    });

    // 关键：先挂好 stdout 解析，再发第一条请求，防止丢消息
    child.stdout?.on('data', (d: Buffer) => this.onStdout(d.toString('utf8')));

    try {
      const init = (await this.request(
        'initialize',
        {
          protocolVersion: SUPPORTED_PROTOCOL,
          capabilities: {},
          clientInfo: { name: 'easyCLI', version: '0.5.0' },
        },
        this.connectTimeoutMs,
      )) as { protocolVersion?: string; capabilities?: Record<string, unknown> };

      this.negotiatedProtocol = init.protocolVersion;
      // 发送 initialized 通知（无 id，不期待响应），正式进入 ready
      this.notify('notifications/initialized', {});
      this.state = 'ready';
    } catch (e) {
      this.state = 'closed';
      this.killChild();
      throw e;
    }
  }

  // ── tools/list ───────────────────────────────────────
  async listTools(): Promise<McpTool[]> {
    this.requireReady();
    const resp = (await this.request('tools/list', {}, this.timeoutMs)) as {
      tools?: McpTool[];
    };
    return resp.tools ?? [];
  }

  // ── tools/call ───────────────────────────────────────
  /** 调用一个 MCP 工具，返回统一 ToolResult（ok/output）。MCP 错误侧转为 ok:false 的结果。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> {
    this.requireReady();
    const resp = (await this.request(
      'tools/call',
      { name, arguments: args },
      this.timeoutMs,
    )) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
      structuredContent?: unknown;
    };

    const blocks = resp.content ?? [];
    const text = blocks
      .map((c) => (c.type === 'text' ? (c.text ?? '') : JSON.stringify(c)))
      .join('\n');
    return { ok: !resp.isError, output: text };
  }

  // ── 生命周期：disconnect ─────────────────────────────
  async disconnect(): Promise<void> {
    if (this.state === 'closed' || this.state === 'disconnected') {
      this.state = 'closed';
      return;
    }
    this.closedByUs = true;
    // 仅当子进程还活着才发 shutdown；connect 超时后子进程可能已被 kill（child 置空），直接跳过快路径
    if (this.child && !this.child.killed) {
      try {
        // shutdown 期待响应，但给短超时，避免服务端卡住时 hang
        await this.request('shutdown', {}, 2000).catch(() => undefined);
      } catch {
        /* 服务端正不正常回 shutdown 都继续退出流程 */
      }
    }
    this.notify('exit', {});
    this.killChild();
    // 让任何在途请求立即失败，而不是卡到各自超时
    this.failAll(new Error('MCP 连接已关闭'));
    this.state = 'closed';
  }

  // ── 内部：请求/通知/响应分发 ────────────────────────
  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时（${method}，>${timeoutMs}ms 无响应）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write(msg);
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(obj: unknown): void {
    try {
      this.child?.stdin?.write(JSON.stringify(obj) + '\n');
    } catch {
      /* 进程已退出时写 stdin 可能抛 EPIPE，忽略 */
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // 跳过非法行，不中断连接
      }
      // 通知（无 id）由服务端发来（如进度/日志），此处无需处理
      if (msg.id === undefined) continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`MCP 错误 ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  }

  private requireReady(): void {
    if (this.state !== 'ready') {
      throw new Error(`MCP 未就绪：当前为 ${this.state}，需先 connect 成功`);
    }
  }

  private failAll(err: Error): void {
    // 把最近 stderr 一并带出，便于排错（如服务端启动即报错）
    const tail = this.stderrChunks.slice(-3).join('').trim();
    const enriched = tail ? new Error(`${err.message}（server stderr: ${tail.slice(-300)}）`) : err;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(enriched);
    }
    this.pending.clear();
  }

  private killChild(): void {
    try {
      this.child?.stdin?.end();
    } catch {
      /* ignore */
    }
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
    this.child = undefined;
  }
}

/**
 * 把 MCP 工具列表转成统一的 ToolDef，注册进同一张 ToolRegistry。
 * execute 内部转调 client.callTool，使 MCP 工具复用执行器/权限/审计/总线。
 * isReadOnly 取自 annotations.readOnlyHint（缺省 false → 默认走 ask 权限，安全保守）。
 */
export function mcpToolsToToolDefs(client: McpClient, tools: McpTool[]): ToolDef[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    isReadOnly: t.annotations?.readOnlyHint ?? false,
    isDestructive: t.annotations?.destructiveHint ?? false,
    execute: (args: Record<string, unknown>) => client.callTool(t.name, args),
  }));
}

interface Registrar {
  registerAll(tools: ToolDef[]): void;
}

/**
 * 批量连接多个 MCP Server，把它们的工具转成 ToolDef 并注册进同一注册表。
 * 单个 Server 连接失败不影响其余（容错），返回成功连上的客户端列表供退出时清理。
 */
export async function connectMcpServers(
  specs: McpServerSpec[],
  registry: Registrar,
  opts: McpClientOptions = {},
  onWarn: (msg: string) => void = () => undefined,
): Promise<McpClient[]> {
  const clients: McpClient[] = [];
  for (const spec of specs) {
    const client = new McpClient(spec, opts);
    try {
      await client.connect();
      const mcpTools = await client.listTools();
      registry.registerAll(mcpToolsToToolDefs(client, mcpTools));
      clients.push(client);
      onWarn(`已连接 MCP 服务器 ${spec.command}: ${mcpTools.length} 个工具`);
    } catch (e) {
      onWarn(`⚠ MCP 连接失败（${spec.command}）: ${(e as Error).message}`);
      await client.disconnect().catch(() => undefined);
    }
  }
  return clients;
}
