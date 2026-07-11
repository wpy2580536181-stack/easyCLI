// Phase 12：MCP 服务端（基于官方 @modelcontextprotocol/sdk 低层 Server 实现）。
//
// 设计要点（与手写版对齐，但协议层/传输层交由 SDK 负责）：
// 1. 协议与传输解耦：Server 只注册「请求处理器」，真正字节收发交给 SDK 的
//    StdioServerTransport / StreamableHTTPServerTransport（见 demo-server.ts）。
// 2. 工具桥接：createMcpServer + fromToolDefs 把内置 ToolDef 注册进服务端，
//    tools/call 转调 ToolDef.execute（与 Agent 侧执行同一份逻辑），
//    再以 MCP 收口格式 {content:[{type,text}], isError} 返回。
// 3. 资源：registerResource 挂只读资源（如 agent://clock），
//    resources/list / resources/read 由 SDK 路由到对应处理器。
// 4. initialize / ping 由 SDK Server 自动处理（含多版本协议协商，取 min(客户端,服务端)）。
// 5. 协议版本协商、JSON-RPC 配对、错误码模型等底层细节由 SDK 保证，本项目不再手写。

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolDef } from '../chatmodel/types';

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
 * 对外的「MCP 服务端」门面：持有工具/资源表 + 底层 SDK Server 实例。
 * 调用方（demo-server / 测试）只与本门面交互，不直接碰 SDK Server。
 */
export interface McpServer {
  registerTool(tool: ToolDef): void;
  registerTools(tools: ToolDef[]): void;
  registerResource(resource: McpResource): void;
  registerResources(resources: McpResource[]): void;
  /** 底层 SDK Server 实例，供 createServer 时 connect 传输层使用 */
  readonly server: Server;
}

/**
 * 构造一个 MCP 服务端门面。
 * 在底层 SDK Server 上注册 tools/list、tools/call、resources/list、resources/read
 * 四个请求处理器，处理器从本门面维护的 tools/resources 表读取并执行。
 */
export function createMcpServer(opts: McpServerOptions = {}): McpServer {
  const name = opts.name ?? 'easyCLI-mcp';
  const version = opts.version ?? '0.12.0';
  const cwd = opts.cwd ?? process.cwd();

  const tools = new Map<string, ToolDef>();
  const resources = new Map<string, McpResource>();

  // 声明能力：tools + resources（即便当前未注册，也允许对端后续调用时返回空列表）
  const server = new Server(
    { name, version },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [...tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: {
          title: t.name,
          readOnlyHint: t.isReadOnly ?? false,
          destructiveHint: t.isDestructive ?? false,
        },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params?.name;
    if (!name) throw new McpError(ErrorCode.InvalidParams, '缺少参数 name');
    const tool = tools.get(name);
    if (!tool) throw new McpError(ErrorCode.MethodNotFound, `未知工具: ${name}`);

    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
    const ctx: ToolContext = { cwd };
    // tools/call 是「一次请求一次响应」：await 执行结果，
    // 若工具抛异常，按 isError 收口（区别于协议级 -32603）。
    try {
      const result = (await tool.execute?.(args, ctx)) ?? {
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
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [...resources.values()].map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params?.uri;
    if (!uri) throw new McpError(ErrorCode.InvalidParams, '缺少参数 uri');
    const r = resources.get(uri);
    if (!r) throw new McpError(ErrorCode.InvalidParams, `未知资源: ${uri}`);
    const text = await r.read();
    return {
      contents: [{ uri: r.uri, mimeType: r.mimeType, text }],
    };
  });

  return {
    registerTool: (tool) => {
      tools.set(tool.name, tool);
    },
    registerTools: (ts) => {
      for (const t of ts) tools.set(t.name, t);
    },
    registerResource: (r) => {
      resources.set(r.uri, r);
    },
    registerResources: (rs) => {
      for (const r of rs) resources.set(r.uri, r);
    },
    server,
  };
}

/**
 * 把内置 ToolDef 列表批量注册进 McpServer。
 * 与客户端侧 mcpToolsToToolDefs（MCP → ToolDef）方向相反，是 ToolDef → MCP 的桥；
 * 二者对称，便于演示「同一份工具定义，既能作为客户端消费，也能作为服务端暴露」。
 */
export function fromToolDefs(server: McpServer, tools: ToolDef[]): void {
  server.registerTools(tools.filter((t) => typeof t.execute === 'function'));
}
