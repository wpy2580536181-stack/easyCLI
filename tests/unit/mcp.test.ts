import { describe, it, expect, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { McpClient, mcpToolsToToolDefs, type McpClient as McpClientType } from '../../src/core/mcp/client';
import { createToolRegistry } from '../../src/core/tools/registry';
import { EventBus } from '../../src/core/events/bus';
import { PermissionManager } from '../../src/core/security/permission';
import { runAgent } from '../../src/core/agent';
import type { ChatMessage, ChatModel, CompleteResult, ToolCall } from '../../src/core/chatmodel/types';

const FAKE = fileURLToPath(new URL('../fixtures/fake-mcp-server.mjs', import.meta.url));
const SILENT = fileURLToPath(new URL('../fixtures/silent-mcp-server.mjs', import.meta.url));
const LAZY = fileURLToPath(new URL('../fixtures/lazy-mcp-server.mjs', import.meta.url));

// 测试结束后统一清理，避免子进程泄漏
const live: McpClientType[] = [];
afterEach(async () => {
  await Promise.allSettled(live.map((c) => c.disconnect()));
  live.length = 0;
});

function spawnClient(fixture: string, opts = {}): McpClient {
  const c = new McpClient({ command: 'node', args: [fixture] }, opts);
  live.push(c);
  return c;
}

describe('McpClient：连接 + 握手 + 状态机', () => {
  it('connect 成功后置为 ready，并协商 protocolVersion', async () => {
    const c = spawnClient(FAKE);
    expect(c.getState()).toBe('disconnected');
    await c.connect();
    expect(c.getState()).toBe('ready');
    expect(c.negotiatedProtocol).toBe('2024-11-05');
  });

  it('未 connect 时 callTool 抛错（状态机前置校验）', async () => {
    const c = spawnClient(FAKE);
    await expect(c.callTool('mcp_echo', { text: 'x' })).rejects.toThrow(/未就绪/);
  });

  it('重复 connect 抛错（状态机非法迁移）', async () => {
    const c = spawnClient(FAKE);
    await c.connect();
    await expect(c.connect()).rejects.toThrow(/状态非法/);
  });

  it('面对静默服务端，connect 在超时内失败且不 hang，子进程被回收', async () => {
    const start = Date.now();
    const c = spawnClient(SILENT, { connectTimeoutMs: 400 });
    await expect(c.connect()).rejects.toThrow(/超时/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000); // 远小于默认 15s，证明走的是短超时
    expect(c.getState()).toBe('closed');
  });
});

describe('McpClient：tools/list + tools/call', () => {
  it('listTools 返回两个工具且 schema 齐全', async () => {
    const c = spawnClient(FAKE);
    await c.connect();
    const tools = await c.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['mcp_add', 'mcp_echo']);
    const echo = tools.find((t) => t.name === 'mcp_echo')!;
    expect(echo.description).toContain('回显');
    expect((echo.inputSchema.properties as Record<string, unknown>).text).toBeDefined();
  });

  it('callTool mcp_echo / mcp_add 返回正确结果', async () => {
    const c = spawnClient(FAKE);
    await c.connect();
    const r1 = await c.callTool('mcp_echo', { text: 'hi' });
    expect(r1).toEqual({ ok: true, output: 'echo: hi' });

    const r2 = await c.callTool('mcp_add', { a: 2, b: 3 });
    expect(r2.ok).toBe(true);
    expect(r2.output).toBe('sum: 5');
  });

  it('MCP 层业务报错（isError）映射为 ok:false 的结果', async () => {
    const c = spawnClient(FAKE);
    await c.connect();
    const r = await c.callTool('mcp_fail', {});
    expect(r.ok).toBe(false);
    expect(r.output).toBe('故意失败');
  });

  it('未知工具触发协议错误（-32601）并归一化为「MCP 错误」文案', async () => {
    const c = spawnClient(FAKE);
    await c.connect();
    await expect(c.callTool('mcp_unknown', {})).rejects.toThrow(/MCP 错误 -32601/);
  });

  it('disconnect 后状态为 closed 且子进程被终止', async () => {
    const c = spawnClient(FAKE);
    await c.connect();
    await c.disconnect();
    expect(c.getState()).toBe('closed');
  });

  it('disconnect 时让在途 callTool 立即失败，不卡到超时', async () => {
    const c = spawnClient(LAZY, { timeoutMs: 30_000 });
    await c.connect();
    // 发起一个会「卡死」的调用，但不 await。
    // 注意：必须先挂上 .rejects 处理器，再 disconnect——否则 pending 在 disconnect
    // 中途 reject 时还没人接管，会被 Node 当成未处理 rejection。
    const pending = c.callTool('mcp_echo', { text: 'x' });
    const assertion = expect(pending).rejects.toThrow(/连接已关闭/);
    const start = Date.now();
    await c.disconnect(); // 关闭应让在途请求立即失败
    // SDK 在断开时 abort 在途请求，门面归一化为「连接已关闭」
    await assertion;
    expect(Date.now() - start).toBeLessThan(10_000); // 远小于 timeoutMs(30s)
  });
});

describe('MCP 工具 → 统一 ToolDef 适配器', () => {
  it('mcpToolsToToolDefs 生成可执行 ToolDef，execute 透传回服务端', async () => {
    const c = spawnClient(FAKE);
    await c.connect();
    const defs = mcpToolsToToolDefs(c, await c.listTools());
    const echo = defs.find((d) => d.name === 'mcp_echo')!;
    const res = await echo.execute!({ text: '桥接' }, { cwd: process.cwd() });
    expect(res).toEqual({ ok: true, output: 'echo: 桥接' });
    // 缺省 annotations → isReadOnly 为 false（保守默认）
    expect(echo.isReadOnly).toBe(false);
  });
});

describe('垂直集成：MCP 工具经执行器/权限/总线跑通一轮', () => {
  class ScriptedModel implements ChatModel {
    readonly id = 'mock:test';
    calls = 0;
    constructor(private readonly queue: CompleteResult[]) {}
    async complete(): Promise<CompleteResult> {
      const r = this.queue[this.calls % this.queue.length]!;
      this.calls++;
      return r;
    }
  }

  it('Agent 调用 MCP 工具 → 执行 → 结果回注历史', async () => {
    const c = spawnClient(FAKE);
    await c.connect();
    const tools = createToolRegistry();
    tools.registerAll(mcpToolsToToolDefs(c, await c.listTools()));

    const bus = new EventBus();
    const calls: string[] = [];
    bus.on('tool:call', (e) => calls.push((e.call as ToolCall).name));
    bus.on('tool:result', (e) => calls.push('result:' + (e.call as ToolCall).name));

    // MCP 工具 isReadOnly=false → 默认 ask；注入放行 resolver 模拟交互预批准
    const permission = new PermissionManager({ registry: tools });
    permission.setResolver(() => 'allow');

    const call: ToolCall = { id: 'm1', name: 'mcp_echo', arguments: { text: '世界' } };
    const model = new ScriptedModel([
      { content: '我去调用 MCP', toolCalls: [call] },
      { content: '完成', toolCalls: [] },
    ]);
    const history: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '用 mcp 回显' },
    ];

    await runAgent(history, { model, tools, permission, bus, cwd: process.cwd() });

    // 历史中应出现 tool 结果，且内容来自真实 MCP Server
    const toolMsg = history[3]!;
    expect(toolMsg.role).toBe('tool');
    expect(String(toolMsg.content)).toContain('echo: 世界');
    // 总线收到 MCP 工具的 call/result 事件（审计可见）
    expect(calls).toContain('mcp_echo');
    expect(calls.some((x) => x.startsWith('result:mcp_echo'))).toBe(true);
  });

  it('无 resolver 时 MCP 写类工具默认被拒（安全默认一致）', async () => {
    const c = spawnClient(FAKE);
    await c.connect();
    const tools = createToolRegistry();
    tools.registerAll(mcpToolsToToolDefs(c, await c.listTools()));
    const permission = new PermissionManager({ registry: tools }); // 无 resolver → ask 默认 deny

    const call: ToolCall = { id: 'm2', name: 'mcp_echo', arguments: { text: 'x' } };
    const model = new ScriptedModel([
      { content: '', toolCalls: [call] },
      { content: '完成', toolCalls: [] },
    ]);
    const history: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '用 mcp' },
    ];

    await runAgent(history, { model, tools, permission, cwd: process.cwd() });
    expect(String(history[3]!.content)).toContain('权限拒绝');
  });
});
