import { describe, it, expect } from 'vitest';
import {
  McpServer,
  McpError,
  JsonRpcError,
  fromToolDefs,
  SUPPORTED_PROTOCOL,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '../../src/core/mcp/server';
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

function req(method: string, params?: unknown, id = 1): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

// 类型化的结果断言辅助
type InitR = { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string; version: string } };
type ListR = { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown> }> };
type CallR = { content: Array<{ type: string; text: string }>; isError: boolean };
type ResListR = { resources: Array<{ uri: string; name: string }> };
type ResReadR = { contents: Array<{ uri: string; text: string }> };

async function init(server: McpServer): Promise<void> {
  const r = (await server.handleMessage(
    req('initialize', { protocolVersion: SUPPORTED_PROTOCOL, clientInfo: { name: 't', version: '1' } }),
  )) as JsonRpcResponse;
  expect(r.error).toBeUndefined();
}

describe('McpServer 协议分发', () => {
  it('initialize 回协议版本 / capabilities / serverInfo，并置 negotiatedProtocol', async () => {
    const s = new McpServer({ name: 'srv', version: '9.9.9' });
    const r = (await s.handleMessage(
      req('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 't', version: '1' } }),
    )) as JsonRpcResponse;
    expect(r.error).toBeUndefined();
    const res = r.result as InitR;
    expect(res.protocolVersion).toBe(SUPPORTED_PROTOCOL);
    expect(res.serverInfo).toEqual({ name: 'srv', version: '9.9.9' });
    expect(res.capabilities).toEqual({}); // 未注册能力时为空对象
    expect(s.negotiatedProtocol).toBe(SUPPORTED_PROTOCOL);
    expect(s.clientInfo).toEqual({ name: 't', version: '1' });
  });

  it('未初始化就调用业务方法 → -32600 Invalid Request', async () => {
    const s = new McpServer();
    s.registerTool(echoTool());
    const r = (await s.handleMessage(req('tools/list'))) as JsonRpcResponse;
    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe(JsonRpcError.InvalidRequest);
  });

  it('ping → 空对象', async () => {
    const s = new McpServer();
    await init(s);
    const r = (await s.handleMessage(req('ping'))) as JsonRpcResponse;
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual({});
  });

  it('tools/list 返回已注册工具（含 inputSchema 与 annotations）', async () => {
    const s = new McpServer();
    s.registerTool(echoTool());
    await init(s);
    const r = (await s.handleMessage(req('tools/list'))) as JsonRpcResponse;
    const res = r.result as ListR;
    expect(res.tools).toHaveLength(1);
    expect(res.tools[0]?.name).toBe('echo');
    expect(res.tools[0]?.inputSchema).toMatchObject({ type: 'object' });
    expect(res.tools[0]?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('tools/call 转调 execute，正常结果收口为 content/isError:false', async () => {
    const s = new McpServer();
    s.registerTool(echoTool());
    await init(s);
    const r = (await s.handleMessage(
      req('tools/call', { name: 'echo', arguments: { text: 'hi' } }),
    )) as JsonRpcResponse;
    const res = r.result as CallR;
    expect(res.isError).toBe(false);
    expect(res.content[0]?.text).toBe('echo:hi');
  });

  it('tools/call 业务失败（ok:false）→ isError:true', async () => {
    const s = new McpServer();
    s.registerTool(failTool());
    await init(s);
    const r = (await s.handleMessage(req('tools/call', { name: 'boom', arguments: {} }))) as JsonRpcResponse;
    const res = r.result as CallR;
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe('业务失败');
  });

  it('tools/call 执行抛异常 → isError:true（区别于协议级 -32603）', async () => {
    const s = new McpServer();
    s.registerTool(throwTool());
    await init(s);
    const r = (await s.handleMessage(req('tools/call', { name: 'throw', arguments: {} }))) as JsonRpcResponse;
    const res = r.result as CallR;
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('炸了');
  });

  it('tools/call 未知工具 → -32601 Method Not Found', async () => {
    const s = new McpServer();
    await init(s);
    const r = (await s.handleMessage(req('tools/call', { name: 'nope', arguments: {} }))) as JsonRpcResponse;
    expect(r.error?.code).toBe(JsonRpcError.MethodNotFound);
  });

  it('tools/call 缺 name → -32602 Invalid Params', async () => {
    const s = new McpServer();
    await init(s);
    const r = (await s.handleMessage(req('tools/call', { arguments: {} }))) as JsonRpcResponse;
    expect(r.error?.code).toBe(JsonRpcError.InvalidParams);
  });

  it('resources/list 与 resources/read', async () => {
    const s = new McpServer();
    s.registerResource({ uri: 'agent://x', name: 'x', mimeType: 'text/plain', read: () => 'payload' });
    await init(s);
    const list = (await s.handleMessage(req('resources/list'))) as JsonRpcResponse;
    expect((list.result as ResListR).resources[0]?.uri).toBe('agent://x');

    const read = (await s.handleMessage(req('resources/read', { uri: 'agent://x' }))) as JsonRpcResponse;
    const rc = read.result as ResReadR;
    expect(rc.contents[0]?.text).toBe('payload');
    expect(rc.contents[0]?.uri).toBe('agent://x');
  });

  it('resources/read 未知 uri → -32602', async () => {
    const s = new McpServer();
    await init(s);
    const r = (await s.handleMessage(req('resources/read', { uri: 'missing' }))) as JsonRpcResponse;
    expect(r.error?.code).toBe(JsonRpcError.InvalidParams);
  });

  it('未知方法 → -32601', async () => {
    const s = new McpServer();
    await init(s);
    const r = (await s.handleMessage(req('frobnicate'))) as JsonRpcResponse;
    expect(r.error?.code).toBe(JsonRpcError.MethodNotFound);
  });

  it('shutdown 后连接复位，再次 tools/list → -32600', async () => {
    const s = new McpServer();
    s.registerTool(echoTool());
    await init(s);
    const shut = (await s.handleMessage(req('shutdown'))) as JsonRpcResponse;
    expect(shut.result).toEqual({});
    const after = (await s.handleMessage(req('tools/list'))) as JsonRpcResponse;
    expect(after.error?.code).toBe(JsonRpcError.InvalidRequest);
  });

  it('通知（无 id）返回 null，不回包', async () => {
    const s = new McpServer();
    const r = await s.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(r).toBeNull();
  });
});

describe('fromToolDefs 桥接', () => {
  it('只注册带 execute 的工具', () => {
    const s = new McpServer();
    const withExec = echoTool();
    const noExec: ToolDef = { name: 'noexec', description: 'x', inputSchema: {} };
    fromToolDefs(s, [withExec, noExec]);
    // 无法直接读私有 tools，借 tools/list 验证
    return (async () => {
      await init(s);
      const r = (await s.handleMessage(req('tools/list'))) as JsonRpcResponse;
      const res = r.result as ListR;
      expect(res.tools.map((t) => t.name)).toEqual(['echo']);
    })();
  });
});

describe('McpError', () => {
  it('携带 code 与 message', () => {
    const e = new McpError(-32601, '未知');
    expect(e.code).toBe(-32601);
    expect(e.message).toBe('未知');
    expect(e).toBeInstanceOf(Error);
  });
});
