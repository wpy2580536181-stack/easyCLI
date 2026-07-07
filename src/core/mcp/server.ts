// Phase 12：MCP 服务端（与 Phase 5 的 McpClient 对端；纯手写，不引官方 SDK）。
//
// 设计要点（与客户端对称）：
// 1. 传输无关：McpServer 只负责「协议层」——解析 JSON-RPC 请求、dispatch、产出响应。
//    真正的字节收发交给 StdioTransport / HttpTransport（见同目录）。
// 2. 协议握手：initialize 协商 protocolVersion 并回 capabilities（tools/resources），
//    之后客户端发 notifications/initialized（无 id，服务端不回包），正式进入 ready。
// 3. 方法分发：ping / tools/list / tools/call / resources/list / resources/read / shutdown，
//    其余未知方法回 -32601 Method not found；未初始化就调用业务方法回 -32600。
// 4. 工具桥接：fromToolDefs 把内置 ToolDef 注册进服务端，tools/call 转调 ToolDef.execute
//    （与 Agent 侧执行同一份逻辑，无需重写），再以 MCP 收口格式 {content:[{type,text}], isError} 返回。
//
// 为何不引 @modelcontextprotocol/sdk：本项目定位「从零手搓学习」，手写能看清 JSON-RPC
// 的配对、协议版本协商、content/isError 收口等关键细节（也是面试高频考点）。

import type { ToolContext, ToolDef, ToolResult } from '../chatmodel/types';

/** 本服务端声明支持（并协商）的协议版本，须与客户端 SUPPORTED_PROTOCOL 对齐 */
export const SUPPORTED_PROTOCOL = '2024-11-05';

// ── JSON-RPC 2.0 报文类型（服务端视角：id 允许 number | string） ──
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: unknown;
}
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** 标准 JSON-RPC 错误码（节选） */
export const JsonRpcError = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** 协议层错误：携带标准 JSON-RPC 错误码，在 handleMessage 里被收口为 error 响应 */
export class McpError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

/** 一个可被 MCP 读取的资源（演示 resources 能力；与 tools 解耦，走只读通道） */
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  /** 读资源内容，返回纯文本（二进制资源不在本学习项目范围内） */
  read: () => Promise<string> | string;
}

export interface McpServerOptions {
  name?: string;
  version?: string;
  /** tools/call 执行内置工具时透传给 ToolContext 的工作目录 */
  cwd?: string;
}

/**
 * 传输无关的手写 MCP 服务端。
 * 对外暴露 registerTool(s)/registerResource(s) 与 handleMessage，
 * 后者是协议分发的唯一入口，由传输层（stdio/http）调用。
 */
export class McpServer {
  private readonly tools = new Map<string, ToolDef>();
  private readonly resources = new Map<string, McpResource>();
  private readonly name: string;
  private readonly version: string;
  private readonly cwd: string;

  /** 已协商的协议版本（initialize 成功后才有意义） */
  negotiatedProtocol?: string;
  /** 对端客户端信息（initialize 时带回，便于审计/排错） */
  clientInfo?: { name: string; version: string };
  private initialized = false;

  constructor(opts: McpServerOptions = {}) {
    this.name = opts.name ?? 'easyCLI-mcp';
    this.version = opts.version ?? '0.12.0';
    this.cwd = opts.cwd ?? process.cwd();
  }

  // ── 注册能力 ──────────────────────────────────────────
  registerTool(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }
  registerTools(tools: ToolDef[]): void {
    for (const t of tools) this.registerTool(t);
  }
  registerResource(resource: McpResource): void {
    this.resources.set(resource.uri, resource);
  }
  registerResources(resources: McpResource[]): void {
    for (const r of resources) this.registerResource(r);
  }

  /**
   * 协议分发核心：输入一条解析好的 JSON-RPC 请求，产出响应。
   * 通知（无 id，如 notifications/initialized、exit）返回 null（不回包）。
   * 异常统一收口：McpError → 其 code；其余 → -32603 Internal error。
   */
  async handleMessage(msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (msg.id === undefined) return null; // 通知不回包
    try {
      const result = await this.dispatch(msg.method, msg.params);
      return { jsonrpc: '2.0', id: msg.id, result };
    } catch (e) {
      if (e instanceof McpError) {
        return { jsonrpc: '2.0', id: msg.id, error: { code: e.code, message: e.message } };
      }
      return {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: JsonRpcError.InternalError, message: (e as Error).message },
      };
    }
  }

  // ── 方法分发 ──────────────────────────────────────────
  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.onInitialize(params);
      case 'ping':
        return {};
      case 'tools/list':
        this.requireReady();
        return this.onToolsList();
      case 'tools/call':
        this.requireReady();
        return this.onToolsCall(params);
      case 'resources/list':
        this.requireReady();
        return {
          resources: [...this.resources.values()].map((r) => ({
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
          })),
        };
      case 'resources/read':
        this.requireReady();
        return this.onResourcesRead(params);
      case 'shutdown':
        // 标记连接退出；真正终止由传输层（收到 exit 通知/信号）负责
        this.initialized = false;
        return {};
      default:
        throw new McpError(JsonRpcError.MethodNotFound, `方法不支持: ${method}`);
    }
  }

  private onInitialize(params: unknown): unknown {
    const p = (params ?? {}) as {
      protocolVersion?: string;
      clientInfo?: { name: string; version: string };
      capabilities?: unknown;
    };
    // 协商：服务端声明支持的最高（也是唯一）协议版本 2024-11-05。
    // 真实实现会按「取 min(客户端请求, 服务端支持)」选择，这里锁定单版本。
    this.negotiatedProtocol = SUPPORTED_PROTOCOL;
    this.clientInfo = p.clientInfo;
    this.initialized = true; // 握手完成，允许业务方法

    // capabilities 动态生成：仅当确实注册了对应能力才声明，避免对端误判
    const capabilities: Record<string, unknown> = {};
    if (this.tools.size > 0) capabilities.tools = {};
    if (this.resources.size > 0) capabilities.resources = {};

    return {
      protocolVersion: SUPPORTED_PROTOCOL,
      capabilities,
      serverInfo: { name: this.name, version: this.version },
    };
  }

  private onToolsList(): unknown {
    const tools = [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      // MCP 用 inputSchema（客户端侧 McpTool 也是这个字段名），与 OpenAI 的 parameters 区分
      inputSchema: t.inputSchema,
      annotations: {
        title: t.name,
        readOnlyHint: t.isReadOnly ?? false,
        destructiveHint: t.isDestructive ?? false,
      },
    }));
    return { tools };
  }

  private async onToolsCall(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const name = p.name;
    if (!name) throw new McpError(JsonRpcError.InvalidParams, '缺少参数 name');
    const tool = this.tools.get(name);
    if (!tool) throw new McpError(JsonRpcError.MethodNotFound, `未知工具: ${name}`);

    const args = p.arguments ?? {};
    const ctx: ToolContext = { cwd: this.cwd };
    // tools/call 是「一次请求一次响应」的同步协议：await 执行结果，
    // 若工具抛异常，按 isError 收口（区别于 JSON-RPC 协议级错误 -32603）。
    try {
      const result: ToolResult = (await tool.execute?.(args, ctx)) ?? {
        ok: false,
        output: '工具未提供 execute',
      };
      return {
        content: [{ type: 'text', text: result.output }],
        isError: !result.ok,
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `工具执行异常: ${(e as Error).message}` }],
        isError: true,
      };
    }
  }

  private async onResourcesRead(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { uri?: string };
    const uri = p.uri;
    if (!uri) throw new McpError(JsonRpcError.InvalidParams, '缺少参数 uri');
    const r = this.resources.get(uri);
    if (!r) throw new McpError(JsonRpcError.InvalidParams, `未知资源: ${uri}`);
    const text = await r.read();
    return {
      contents: [{ uri: r.uri, mimeType: r.mimeType, text }],
    };
  }

  private requireReady(): void {
    if (!this.initialized) {
      throw new McpError(JsonRpcError.InvalidRequest, '连接未初始化，请先调用 initialize');
    }
  }
}

/**
 * 把内置 ToolDef 列表批量注册进 McpServer。
 * 与客户端侧 mcpToolsToToolDefs（MCP → ToolDef）方向相反，是 ToolDef → MCP 的桥；
 * 二者对称，便于演示「同一份工具定义，既能作为客户端消费，也能作为服务端暴露」。
 */
export function fromToolDefs(server: McpServer, tools: ToolDef[]): void {
  server.registerTools(tools.filter((t) => typeof t.execute === 'function'));
}
