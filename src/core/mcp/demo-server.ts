// Phase 12：演示用 MCP 服务端入口。
// 把「内置工具」原样暴露为 MCP 工具（对端 McpClient 可直接消费），
// 并额外挂一个 resources 演示只读资源通道。既可用 stdio 被 CLI 当子进程拉起，
// 也可用 http 独立监听，供任意 MCP 客户端连。

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { getBuiltinTools } from '../tools/builtin';
import { createMcpServer, fromToolDefs } from './server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface StartMcpServerOptions {
  transport: 'stdio' | 'http';
  port?: number;
  cwd?: string;
}

/** 启动一个 MCP 服务端（stdio 或 http 传输）。stdio 会阻塞进程直到收到 exit/信号。 */
export async function startMcpServer(opts: StartMcpServerOptions): Promise<void> {
  const srv = createMcpServer({ name: 'easyCLI-demo', cwd: opts.cwd ?? process.cwd() });

  // 把内置工具暴露为 MCP 工具（与 Agent 执行同一份逻辑）
  fromToolDefs(srv, getBuiltinTools());

  // 演示 resources 能力：一个只读的「服务器时钟」资源
  srv.registerResource({
    uri: 'agent://clock',
    name: 'clock',
    description: '当前服务器时间（演示 resources 只读通道）',
    mimeType: 'text/plain',
    read: () => new Date().toISOString(),
  });

  if (opts.transport === 'http') {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: false,
    });
    await srv.server.connect(transport);

    const httpServer = http.createServer(async (req, res) => {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      await transport.handleRequest(req, res, body);
    });
    const port = await listen(httpServer, opts.port ?? 3000);
    // 注意：日志走 stderr，避免污染 stdout 协议通道（stdio 模式下尤其重要）
    console.error(`[mcp] HTTP 传输已启动：POST http://127.0.0.1:${port}/mcp`);
    registerShutdown(() => Promise.all([srv.server.close(), closeServer(httpServer)]));
  } else {
    const transport = new StdioServerTransport();
    await srv.server.connect(transport);
    console.error('[mcp] stdio 传输已启动，等待客户端握手…');
    registerShutdown(() => srv.server.close());
  }
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** SIGINT/SIGTERM 时优雅关闭（flush 后在途响应后退出） */
function registerShutdown(close: () => Promise<unknown>): void {
  const handler = () => {
    void close().then(
      () => process.exit(0),
      () => process.exit(0),
    );
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString('utf8')));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
