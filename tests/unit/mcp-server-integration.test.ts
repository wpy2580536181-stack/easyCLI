import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpClient, type McpServerSpec } from '../../src/core/mcp/client';
import { createMcpServer } from '../../src/core/mcp/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDef } from '../../src/core/chatmodel/types';

// 对端集成：用 McpClient 去连「本项目的 CLI 以 MCP 服务端模式启动」的子进程。
// 这正验证了「客户端(基于 SDK Client) ↔ 服务端(基于 SDK Server)」是协议对等的。
const TSX = 'node_modules/.bin/tsx';
const CLI = 'src/cli/main.ts';

function cliServerSpec(): McpServerSpec {
  return {
    command: TSX,
    args: [CLI, '--mcp-serve', '--mcp-transport', 'stdio'],
    cwd: process.cwd(),
  };
}

describe('MCP 对端集成（McpClient ↔ CLI 服务端）', () => {
  it(
    '握手 + listTools + callTool(bash echo) 走通',
    async () => {
      const client = new McpClient(cliServerSpec(), { timeoutMs: 30_000, connectTimeoutMs: 20_000 });
      try {
        await client.connect();
        expect(client.getState()).toBe('ready');
        // 两端都是 SDK 1.x，协商出最新版（非手写版的固定 2024-11-05）
        expect(client.negotiatedProtocol).toBe(LATEST_PROTOCOL_VERSION);

        const tools = await client.listTools();
        const names = tools.map((t) => t.name);
        // 内置工具应已暴露为 MCP 工具
        expect(names).toContain('read_file');
        expect(names).toContain('bash');

        // 调一个无副作用的工具（echo），验证 execute 透传链路
        const r = await client.callTool('bash', { command: 'echo mcp-peer-ok' });
        expect(r.ok).toBe(true);
        expect(r.output).toContain('mcp-peer-ok');
      } finally {
        await client.disconnect();
      }
    },
    40_000,
  );
});

// HTTP 传输（Streamable HTTP）单独验证：SDK Server 起本地 HTTP，
// 用 SDK Client（StreamableHTTPClientTransport）走 initialize + list + call。
function echoTool(): ToolDef {
  return {
    name: 'echo',
    description: '回显',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (args) => ({ ok: true, output: `echo:${String(args.text)}` }),
  };
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

describe('MCP Streamable HTTP 传输（SDK Server ↔ SDK Client）', () => {
  it(
    'initialize 建会话 + tools/list + tools/call 走通',
    async () => {
      const srv = createMcpServer({ name: 'http-srv' });
      srv.registerTool(echoTool());
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: false,
      });
      await srv.server.connect(transport);

      const httpServer = http.createServer(async (req, res) => {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        await transport.handleRequest(req, res, body);
      });
      const port = await new Promise<number>((resolve) => {
        httpServer.listen(0, '127.0.0.1', () => {
          const addr = httpServer.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });
      const base = `http://127.0.0.1:${port}/mcp`;

      const client = new Client({ name: 't', version: '1' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(base)));

        const { tools } = await client.listTools();
        expect(tools.some((t) => t.name === 'echo')).toBe(true);

        const res = (await client.callTool({
          name: 'echo',
          arguments: { text: 'http-ok' },
        })) as unknown as { isError: boolean; content: Array<{ type: string; text?: string }> };
        expect(res.isError).toBe(false);
        expect((res.content[0] as { text?: string }).text).toBe('echo:http-ok');
      } finally {
        await client.close().catch(() => undefined);
        await srv.server.close().catch(() => undefined);
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    },
    20_000,
  );
});
