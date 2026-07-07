// Phase 12：演示用 MCP 服务端入口。
// 把「内置工具」原样暴露为 MCP 工具（对端 McpClient 可直接消费），
// 并额外挂一个 resources 演示只读资源通道。既可用 stdio 被 CLI 当子进程拉起，
// 也可用 http 独立监听，供任意 MCP 客户端连。

import { getBuiltinTools } from '../tools/builtin';
import { McpServer, fromToolDefs } from './server';
import { StdioTransport } from './stdio';
import { HttpTransport } from './http';

export interface StartMcpServerOptions {
  transport: 'stdio' | 'http';
  port?: number;
  cwd?: string;
}

/** 启动一个 MCP 服务端（stdio 或 http 传输）。stdio 会阻塞进程直到收到 exit/信号。 */
export async function startMcpServer(opts: StartMcpServerOptions): Promise<void> {
  const server = new McpServer({ name: 'easyCLI-demo', cwd: opts.cwd ?? process.cwd() });

  // 把内置工具暴露为 MCP 工具（与 Agent 执行同一份逻辑）
  fromToolDefs(server, getBuiltinTools());

  // 演示 resources 能力：一个只读的「服务器时钟」资源
  server.registerResource({
    uri: 'agent://clock',
    name: 'clock',
    description: '当前服务器时间（演示 resources 只读通道）',
    mimeType: 'text/plain',
    read: () => new Date().toISOString(),
  });

  if (opts.transport === 'http') {
    const t = new HttpTransport({ server, port: opts.port });
    const port = await t.listen();
    // 注意：日志走 stderr，避免污染 stdout 协议通道（stdio 模式下尤其重要）
    console.error(`[mcp] HTTP 传输已启动：POST http://127.0.0.1:${port}/mcp`);
  } else {
    const t = new StdioTransport({ server });
    console.error('[mcp] stdio 传输已启动，等待客户端握手…');
    t.start();
  }
}
