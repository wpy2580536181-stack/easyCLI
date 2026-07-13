// Phase 5：MCP 客户端 —— 基于官方 @modelcontextprotocol/sdk 的 Client 实现。
//
// 设计要点：
// 1. 传输层：底层用 SDK 的 Transport 抽象，支持两种传输：
//    - stdio：StdioClientTransport 拉起本地 MCP Server 子进程（默认）；
//    - http ：StreamableHTTPClientTransport 连接远程 Streamable HTTP 端点
//      （如 https://host/mcp，无需本地进程，直接接入云端/远程 MCP 生态）。
//    JSON-RPC 配对、请求/响应 id 匹配、协议版本协商等全部由 SDK 负责。
// 2. 门面（facade）：McpClient 在 SDK Client 之上保留「连接状态机」与对外方法
//    （connect/listTools/callTool/disconnect），以最小化调用方与测试改动。
// 3. 超时：connectTimeoutMs 用于握手、timeoutMs 用于 tools/call，超时即失败不 hang。
// 4. 工具归一化：mcpToolsToToolDefs 把 MCP 工具转成统一 ToolDef，execute 内部转调
//    client.callTool，从而与内置工具走同一套执行器、权限、审计、事件总线。

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolDef } from '../chatmodel/types';

export type McpState = 'disconnected' | 'initializing' | 'ready' | 'closed';

/** 一个 MCP Server 的启动规格（stdio：本地命令；http：远程地址） */
export interface McpServerSpec {
  /** 传输方式：stdio(默认，本地子进程) | http(远程 Streamable HTTP) */
  transport?: 'stdio' | 'http';
  /** stdio：本地可执行命令 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** http：远程服务地址，如 https://host/mcp */
  url?: string;
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

interface Registrar {
  registerAll(tools: ToolDef[]): void;
}

/**
 * MCP 客户端门面：内部持有一个 SDK Client + StdioClientTransport，
 * 对外暴露 connect / listTools / callTool / disconnect，并维护连接状态机。
 */
export class McpClient {
  private state: McpState = 'disconnected';
  private sdk: Client;
  private transport?: StdioClientTransport | StreamableHTTPClientTransport;
  private readonly inFlight = new Set<AbortController>();

  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;

  /** 已协商的协议版本（initialize 成功后才有意义） */
  negotiatedProtocol?: string;

  constructor(
    private readonly spec: McpServerSpec,
    opts: McpClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
    this.sdk = new Client({ name: 'easyCLI', version: '0.5.0' });
  }

  getState(): McpState {
    return this.state;
  }

  // ── 生命周期：connect ────────────────────────────────
  async connect(): Promise<void> {
    if (this.state !== 'disconnected') {
      throw new Error(`MCP 连接状态非法：当前为 ${this.state}，期望 disconnected`);
    }
    this.state = 'initializing';

    // 按传输类型选择底层 Transport：stdio（本地子进程）或 http（远程 Streamable HTTP）
    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    if (this.spec.transport === 'http') {
      if (!this.spec.url) {
        this.state = 'closed';
        throw new Error('HTTP 传输的 MCP 服务必须提供 url');
      }
      transport = new StreamableHTTPClientTransport(new URL(this.spec.url));
    } else {
      if (!this.spec.command) {
        this.state = 'closed';
        throw new Error('stdio 传输的 MCP 服务必须提供 command');
      }
      transport = new StdioClientTransport({
        command: this.spec.command,
        args: this.spec.args ?? [],
        env: { ...process.env, ...(this.spec.env ?? {}) } as Record<string, string>,
        cwd: this.spec.cwd,
      });
    }
    this.transport = transport;

    // SDK 在 initialize 协商成功后会调用 transport.setProtocolVersion(negotiated)。
    // 但 Stdio / InMemory 传输默认未实现该方法，协商版本会被丢弃。这里补一个拦截器，
    // 把协商出的协议版本捕获到门面，作为 negotiatedProtocol 对外暴露（替代手写版的固定值）。
    const negotiated: { version?: string } = {};
    const t = transport as unknown as { setProtocolVersion?: (v: string) => void };
    const origSetProtocolVersion = t.setProtocolVersion?.bind(transport);
    t.setProtocolVersion = (v: string): void => {
      negotiated.version = v;
      origSetProtocolVersion?.(v);
    };

    const connectPromise = this.sdk.connect(transport);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`MCP 连接超时（>${this.connectTimeoutMs}ms 无响应）`)),
        this.connectTimeoutMs,
      ),
    );

    try {
      await Promise.race([connectPromise, timeout]);
      // 协商出的协议版本（如 fake 服务端为 2024-11-05，SDK 服务端为最新版）
      this.negotiatedProtocol = negotiated.version;
      this.state = 'ready';
    } catch (e) {
      this.state = 'closed';
      // 静默/假死服务端必须被回收，避免子进程泄漏
      await transport.close().catch(() => undefined);
      connectPromise.catch(() => undefined); // 防止 connect 后续 reject 成未处理异常
      throw e;
    }
  }

  // ── tools/list ───────────────────────────────────────
  async listTools(): Promise<McpTool[]> {
    this.requireReady();
    const { tools } = await this.sdk.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as Record<string, unknown>,
      annotations: t.annotations as McpTool['annotations'],
    }));
  }

  // ── tools/call ───────────────────────────────────────
  /** 调用一个 MCP 工具，返回统一 ToolResult（ok/output）。MCP 错误侧转为 ok:false 的结果。 */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; output: string }> {
    this.requireReady();
    const ac = new AbortController();
    this.inFlight.add(ac);
    try {
      const result = await this.withTimeout(
        this.sdk.callTool({ name, arguments: args }, undefined, { signal: ac.signal }),
        this.timeoutMs,
        'MCP 请求超时',
      );
      const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
      const text = blocks
        .map((c) => (c.type === 'text' ? (c.text ?? '') : JSON.stringify(c)))
        .join('\n');
      return { ok: !result.isError, output: text };
    } catch (e) {
      throw this.normalizeError(e);
    } finally {
      this.inFlight.delete(ac);
    }
  }

  // ── 生命周期：disconnect ─────────────────────────────
  async disconnect(): Promise<void> {
    if (this.state === 'closed' || this.state === 'disconnected') {
      this.state = 'closed';
      return;
    }
    this.state = 'closed';
    // 让任何在途请求立即失败，而不是卡到各自超时
    for (const ac of this.inFlight) ac.abort();
    this.inFlight.clear();
    await this.sdk.close().catch(() => undefined);
  }

  // ── 内部：超时 / 错误归一化 / 前置校验 ────────────────
  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${label}（>${ms}ms 无响应）`)), ms);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }

  private normalizeError(e: unknown): Error {
    const err = e as { code?: unknown; name?: string; message?: string };
    // 连接关闭 / 中断（含我们主动 disconnect 时 abort 在途请求）→ 旧文案「连接已关闭」。
    // SDK 在断开时会把中断包装成 code=-32001 的 McpError（message 含 AbortError）。
    const aborted =
      err.name === 'AbortError' ||
      (typeof err.message === 'string' && /abort/i.test(err.message)) ||
      err.code === -32001;
    if (aborted) {
      return new Error('MCP 连接已关闭');
    }
    // SDK 协议错误带数字 code：统一收口为「MCP 错误 <code>: <msg>」，
    // 并剥掉 SDK 自带的前缀「MCP error <code>: 」避免重复。
    const code = err.code;
    if (typeof code === 'number') {
      const detail =
        typeof err.message === 'string'
          ? err.message.replace(/^MCP error -?\d+:\s*/i, '')
          : String(e);
      return new Error(`MCP 错误 ${code}: ${detail}`);
    }
    return e instanceof Error ? e : new Error(String(e));
  }

  private requireReady(): void {
    if (this.state !== 'ready') {
      throw new Error(`MCP 未就绪：当前为 ${this.state}，需先 connect 成功`);
    }
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
      const label =
        spec.transport === 'http' ? spec.url ?? '(http)' : spec.command ?? '(stdio)';
      onWarn(`已连接 MCP 服务器 ${label}: ${mcpTools.length} 个工具`);
    } catch (e) {
      const label =
        spec.transport === 'http' ? spec.url ?? '(http)' : spec.command ?? '(stdio)';
      onWarn(`⚠ MCP 连接失败（${label}）: ${(e as Error).message}`);
      await client.disconnect().catch(() => undefined);
    }
  }
  return clients;
}
