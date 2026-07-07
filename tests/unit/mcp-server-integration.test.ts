import { describe, it, expect } from 'vitest';
import { McpClient, type McpServerSpec } from '../../src/core/mcp/client';
import { McpServer } from '../../src/core/mcp/server';
import { HttpTransport } from '../../src/core/mcp/http';
import type { ToolDef } from '../../src/core/chatmodel/types';

// 对端集成：用 Phase 5 的 McpClient 去连「本项目的 CLI 以 MCP 服务端模式启动」的子进程。
// 这正验证了「客户端(Phase5) ↔ 服务端(Phase12)」是协议对等的。
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
        expect(client.negotiatedProtocol).toBe('2024-11-05');

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

// HTTP 传输（Streamable HTTP）单独验证：直接起 HttpTransport，用 fetch 走协议。
function echoTool(): ToolDef {
  return {
    name: 'echo',
    description: '回显',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (args) => ({ ok: true, output: `echo:${String(args.text)}` }),
  };
}

describe('MCP Streamable HTTP 传输', () => {
  it(
    'POST /mcp：initialize 建会话 + tools/list + tools/call',
    async () => {
      const server = new McpServer({ name: 'http-srv' });
      server.registerTool(echoTool());
      const transport = new HttpTransport({ server, port: 0 });
      const port = await transport.listen();
      const base = `http://127.0.0.1:${port}/mcp`;

      try {
        // 1) initialize —— 应回 Mcp-Session-Id 头
        const initResp = await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2024-11-05', clientInfo: { name: 't', version: '1' } },
          }),
        });
        const sid = initResp.headers.get('mcp-session-id');
        expect(sid).toBeTruthy();
        const initJson = (await initResp.json()) as { result?: { protocolVersion?: string } };
        expect(initJson.result?.protocolVersion).toBe('2024-11-05');

        // 2) tools/list —— 必须带会话头，否则 400
        const noSid = await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        });
        expect(noSid.status).toBe(400);

        const listResp = await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'mcp-session-id': sid! },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        });
        const listJson = (await listResp.json()) as { result?: { tools?: Array<{ name: string }> } };
        expect(listJson.result?.tools?.some((t) => t.name === 'echo')).toBe(true);

        // 3) tools/call
        const callResp = await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'mcp-session-id': sid! },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'echo', arguments: { text: 'http-ok' } },
          }),
        });
        const callJson = (await callResp.json()) as {
          result?: { content?: Array<{ text: string }>; isError?: boolean };
        };
        expect(callJson.result?.isError).toBe(false);
        expect(callJson.result?.content?.[0]?.text).toBe('echo:http-ok');
      } finally {
        await transport.close();
      }
    },
    20_000,
  );
});
