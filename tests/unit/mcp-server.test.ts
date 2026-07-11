import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, fromToolDefs, type McpServer } from '../../src/core/mcp/server';
import type { ToolDef } from '../../src/core/chatmodel/types';

// ── 构造测试用的 ToolDef（不依赖真实 IO，纯内存） ──
function echoTool(): ToolDef {
  return {
    name: 'echo',
    description: '回显文本',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    isReadOnly: true,
    execute: async (args) => ({ ok: true, output: `echo:${String(args.text)}` }),
  };
}
function failTool(): ToolDef {
  return {
    name: 'boom',
    description: '业务失败（ok:false）',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ ok: false, output: '业务失败' }),
  };
}
function throwTool(): ToolDef {
  return {
    name: 'throw',
    description: '执行抛异常',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      throw new Error('炸了');
    },
  };
}

/** 用 SDK InMemoryTransport 把 Server 与 Client 连成一对，便于在内存里跑协议测试 */
async function linkPair(server: McpServer): Promise<Client> {
  const [tServer, tClient] = InMemoryTransport.createLinkedPair();
  await server.server.connect(tServer);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(tClient);
  return client;
}

/** callTool 返回结果的局部类型（SDK 的索引签名会把 content 推成 unknown，这里收窄） */
type CallToolRes = { isError: boolean; content: Array<{ type: string; text?: string }> };

/** 断言一个会失败的调用抛出指定 code 的 McpError */
async function expectMcpError(p: Promise<unknown>, code: ErrorCode): Promise<void> {
  try {
    await p;
    throw new Error(`预期抛出 McpError(${code})，但调用成功`);
  } catch (e) {
    expect(e).toBeInstanceOf(McpError);
    expect((e as McpError).code).toBe(code);
  }
}

describe('McpServer（SDK 低层 Server）协议行为', () => {
  it('initialize 协商协议版本并声明 capabilities（tools/resources）', async () => {
    const srv = createMcpServer({ name: 'srv', version: '9.9.9' });
    srv.registerTool(echoTool());
    const client = await linkPair(srv);
    // initialize 完成后，服务端信息已交换（证明握手 + 能力协商成功）
    expect(client.getServerVersion()).toBeDefined();
    expect(client.getServerVersion()?.name).toBe('srv');
    // listTools 能拿到注册的工具，证明 capabilities/握手链路通
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('echo');
  });

  it('tools/list 返回已注册工具（含 inputSchema 与 annotations）', async () => {
    const srv = createMcpServer();
    srv.registerTool(echoTool());
    const client = await linkPair(srv);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('echo');
    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object' });
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
  });

  it('tools/call 转调 execute，正常结果收口为 content/isError:false', async () => {
    const srv = createMcpServer();
    srv.registerTool(echoTool());
    const client = await linkPair(srv);
    const res = (await client.callTool({ name: 'echo', arguments: { text: 'hi' } })) as CallToolRes;
    expect(res.isError).toBe(false);
    expect(res.content[0]?.type).toBe('text');
    expect((res.content[0] as { text?: string }).text).toBe('echo:hi');
  });

  it('tools/call 业务失败（ok:false）→ isError:true', async () => {
    const srv = createMcpServer();
    srv.registerTool(failTool());
    const client = await linkPair(srv);
    const res = (await client.callTool({ name: 'boom', arguments: {} })) as CallToolRes;
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text?: string }).text).toBe('业务失败');
  });

  it('tools/call 执行抛异常 → isError:true（区别于协议级错误）', async () => {
    const srv = createMcpServer();
    srv.registerTool(throwTool());
    const client = await linkPair(srv);
    const res = (await client.callTool({ name: 'throw', arguments: {} })) as CallToolRes;
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text?: string }).text).toContain('炸了');
  });

  it('tools/call 未知工具 → -32601 Method Not Found（协议级错误）', async () => {
    const srv = createMcpServer();
    const client = await linkPair(srv);
    await expectMcpError(client.callTool({ name: 'nope', arguments: {} }), ErrorCode.MethodNotFound);
  });

  it('tools/call 缺 name → -32602 Invalid Params（协议级错误）', async () => {
    const srv = createMcpServer();
    const client = await linkPair(srv);
    await expectMcpError(client.callTool({ name: '', arguments: {} }), ErrorCode.InvalidParams);
  });

  it('resources/list 与 resources/read', async () => {
    const srv = createMcpServer();
    srv.registerResource({ uri: 'agent://x', name: 'x', mimeType: 'text/plain', read: () => 'payload' });
    const client = await linkPair(srv);
    const list = await client.listResources();
    expect(list.resources[0]?.uri).toBe('agent://x');

    const read = await client.readResource({ uri: 'agent://x' });
    const c0 = read.contents[0] as { uri?: string; text?: string };
    expect(c0.text).toBe('payload');
    expect(c0.uri).toBe('agent://x');
  });

  it('resources/read 未知 uri → -32602 Invalid Params', async () => {
    const srv = createMcpServer();
    const client = await linkPair(srv);
    await expectMcpError(client.readResource({ uri: 'missing' }), ErrorCode.InvalidParams);
  });

  it('ping 正常返回', async () => {
    const srv = createMcpServer();
    const client = await linkPair(srv);
    // SDK 1.29 的 ping() resolve 为 EmptyResult({})，断言「不抛错」即可
    await client.ping();
  });
});

describe('fromToolDefs 桥接', () => {
  it('只注册带 execute 的工具', async () => {
    const srv = createMcpServer();
    const withExec = echoTool();
    const noExec: ToolDef = { name: 'noexec', description: 'x', inputSchema: {} };
    fromToolDefs(srv, [withExec, noExec]);
    const client = await linkPair(srv);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
  });
});

describe('McpError（SDK 类型）', () => {
  it('携带 code 与 message', () => {
    const e = new McpError(-32601, '未知');
    expect(e.code).toBe(-32601);
    // SDK 的 McpError 会在 message 前加「MCP error <code>: 」前缀
    expect(e.message).toBe('MCP error -32601: 未知');
    expect(e).toBeInstanceOf(Error);
  });
});
