import { describe, it, expect } from 'vitest';
import { executeTools } from '../../src/core/tools/executor';
import { EventBus, type AgentEvent } from '../../src/core/events/bus';
import type { PermissionManager } from '../../src/core/security/permission';
import type { ToolCall, ToolDef, ToolResult } from '../../src/core/chatmodel/types';

/** 构造一个最小 ToolRegistry（仅 get/list），避免依赖真实注册表 */
function fakeRegistry(tools: ToolDef[]) {
  const map = new Map(tools.map((t) => [t.name, t]));
  return { get: (n: string) => map.get(n), list: () => tools } as unknown as import('../../src/core/tools/registry').ToolRegistry;
}

interface Tap {
  starts: string[];
  inflight: number;
  max: number;
  executed: string[];
}

/** 受控 mock 工具：记录并发、可配置只读，执行体延迟 15ms 以便观测并发 */
function makeTool(name: string, readOnly: boolean, tap: Tap): ToolDef {
  return {
    name,
    description: '',
    isReadOnly: readOnly,
    isDestructive: false,
    inputSchema: {},
    execute: async () => {
      tap.starts.push(name);
      tap.executed.push(name);
      tap.inflight++;
      tap.max = Math.max(tap.max, tap.inflight);
      await new Promise((r) => setTimeout(r, 15));
      tap.inflight--;
      return { ok: true, output: `done:${name}` } as ToolResult;
    },
  };
}

const call = (id: string, name: string): ToolCall => ({ id, name, arguments: {} });

describe('executeTools 并发与串行', () => {
  it('只读工具并行（max in-flight == 数量）', async () => {
    const tap: Tap = { starts: [], inflight: 0, max: 0, executed: [] };
    const reg = fakeRegistry([makeTool('r1', true, tap), makeTool('r2', true, tap)]);
    await executeTools([call('1', 'r1'), call('2', 'r2')], { registry: reg, cwd: '.' });
    expect(tap.max).toBe(2); // 两个 read 同时 in-flight
  });

  it('写/破坏性工具串行（max in-flight == 1）', async () => {
    const tap: Tap = { starts: [], inflight: 0, max: 0, executed: [] };
    const reg = fakeRegistry([makeTool('w1', false, tap), makeTool('w2', false, tap)]);
    await executeTools([call('1', 'w1'), call('2', 'w2')], { registry: reg, cwd: '.' });
    expect(tap.max).toBe(1); // 严格串行
    expect(tap.starts).toEqual(['w1', 'w2']); // 顺序确定
  });
});

describe('executeTools 结果与顺序', () => {
  it('返回结果按入参 index 对齐', async () => {
    const tap: Tap = { starts: [], inflight: 0, max: 0, executed: [] };
    const reg = fakeRegistry([
      makeTool('a', true, tap), // read
      makeTool('b', false, tap), // write
      makeTool('c', true, tap), // read
    ]);
    const res = await executeTools(
      [call('1', 'a'), call('2', 'b'), call('3', 'c')],
      { registry: reg, cwd: '.' },
    );
    expect(res.map((r) => r.output)).toEqual(['done:a', 'done:b', 'done:c']);
  });

  it('权限拒绝的工具不执行，返回「权限拒绝」', async () => {
    const tap: Tap = { starts: [], inflight: 0, max: 0, executed: [] };
    const reg = fakeRegistry([makeTool('w1', false, tap)]);
    const denyAll = { resolve: async () => false } as unknown as PermissionManager;
    const res = await executeTools([call('1', 'w1')], { registry: reg, cwd: '.', permission: denyAll });
    expect(tap.executed).not.toContain('w1');
    expect(res[0]!.ok).toBe(false);
    expect(res[0]!.output).toBe('权限拒绝');
  });
});

describe('executeTools 事件总线与钩子', () => {
  it('每次调用 emit tool:call / tool:result', async () => {
    const tap: Tap = { starts: [], inflight: 0, max: 0, executed: [] };
    const reg = fakeRegistry([makeTool('r1', true, tap)]);
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.on('tool:call', (e) => events.push(e));
    bus.on('tool:result', (e) => events.push(e));
    await executeTools([call('1', 'r1')], { registry: reg, cwd: '.', bus });
    expect(events.filter((e) => e.type === 'tool:call')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool:result')).toHaveLength(1);
  });

  it('触发 onToolCall / onToolResult 钩子', async () => {
    const tap: Tap = { starts: [], inflight: 0, max: 0, executed: [] };
    const reg = fakeRegistry([makeTool('r1', true, tap)]);
    const calls: string[] = [];
    const results: string[] = [];
    await executeTools([call('1', 'r1')], {
      registry: reg,
      cwd: '.',
      hooks: { onToolCall: (c) => calls.push(c.name), onToolResult: (_c, r) => results.push(r.output) },
    });
    expect(calls).toEqual(['r1']);
    expect(results).toEqual(['done:r1']);
  });
});

describe('executeTools 入参校验（P1 / 差异3）', () => {
  const schemaTool: ToolDef = {
    name: 'need_path',
    description: '',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    isReadOnly: true,
    execute: async (args) => ({ ok: true, output: `got:${String((args as Record<string, unknown>).path)}` }),
  };

  it('合法参数正常执行', async () => {
    const reg = fakeRegistry([schemaTool]);
    const res = await executeTools(
      [{ id: '1', name: 'need_path', arguments: { path: 'a.txt' } }],
      { registry: reg, cwd: '.' },
    );
    expect(res[0]!.ok).toBe(true);
    expect(res[0]!.output).toBe('got:a.txt');
  });

  it('缺失必填字段被入口拦截（不执行工具）', async () => {
    let executed = false;
    const t: ToolDef = {
      ...schemaTool,
      execute: async () => {
        executed = true;
        return { ok: true, output: 'x' };
      },
    };
    const reg = fakeRegistry([t]);
    const res = await executeTools(
      [{ id: '1', name: 'need_path', arguments: {} }],
      { registry: reg, cwd: '.' },
    );
    expect(executed).toBe(false);
    expect(res[0]!.ok).toBe(false);
    expect(res[0]!.output).toContain('工具入参校验失败');
  });

  it('空 schema 的工具跳过校验', async () => {
    const tap: Tap = { starts: [], inflight: 0, max: 0, executed: [] };
    const reg = fakeRegistry([makeTool('r1', true, tap)]);
    const res = await executeTools([call('1', 'r1')], { registry: reg, cwd: '.' });
    expect(res[0]!.ok).toBe(true);
  });
});
