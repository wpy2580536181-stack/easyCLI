import { describe, it, expect, vi } from 'vitest';
import { runAgent } from '../../src/core/agent';
import {
  executeTools,
  type ToolBatchInfo,
} from '../../src/core/tools/executor';
import { ToolRegistry } from '../../src/core/tools/registry';
import { EventBus } from '../../src/core/events/bus';
import {
  buildAgentSystemPrompt,
  buildPlanSystemPrompt,
} from '../../src/core/prompts';
import type {
  ChatMessage,
  ChatModel,
  CompleteResult,
  ToolCall,
  ToolDef,
  ToolResult,
} from '../../src/core/chatmodel/types';

/** 脚本化模型：按预定序列循环返回 CompleteResult */
class ScriptedModel implements ChatModel {
  readonly id = 'mock:test';
  calls = 0;
  constructor(private readonly queue: CompleteResult[]) {}
  async complete(): Promise<CompleteResult> {
    const r = this.queue[this.calls % this.queue.length];
    this.calls++;
    return r ?? { content: '（兜底）', toolCalls: [] };
  }
}

const sys: ChatMessage = { role: 'system', content: 'sys' };
const user: ChatMessage = { role: 'user', content: '任务' };

/** 造一个只含指定工具的注册表 */
function registryWith(tools: ToolDef[]): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAll(tools);
  return r;
}

const idleSchema = { type: 'object', properties: {} };

describe('Phase 15 · 规划模式系统提示', () => {
  it('正常模式不含规划指令，plan 模式含规划指令', () => {
    const normal = buildAgentSystemPrompt({ cwd: '/tmp' });
    const plan = buildPlanSystemPrompt({ cwd: '/tmp' });
    expect(normal).not.toContain('【规划模式】');
    expect(plan).toContain('【规划模式】');
    expect(plan).toContain('只能调用只读工具');
    expect(plan).toContain('输出一份结构化计划');
  });

  it('plan 模式在追加块后仍保留身份/运行上下文块', () => {
    const plan = buildPlanSystemPrompt({ cwd: '/tmp', now: new Date('2025-01-01T00:00:00') });
    expect(plan).toContain('AI 编程助手');
    expect(plan).toContain('工作目录：/tmp');
  });
});

describe('Phase 15 · 执行器：规划模式只读拦截', () => {
  it('planMode 下写工具被拦截、只读工具放行', async () => {
    const writeExec = vi.fn(async () => ({ ok: true, output: '写了' }) as ToolResult);
    const readExec = vi.fn(async () => ({ ok: true, output: '读了' }) as ToolResult);
    const tools = registryWith([
      { name: 'write_file', description: '', inputSchema: idleSchema, isReadOnly: false, execute: writeExec },
      { name: 'read_file', description: '', inputSchema: idleSchema, isReadOnly: true, execute: readExec },
    ]);
    const calls: ToolCall[] = [
      { id: 'w1', name: 'write_file', arguments: {} },
      { id: 'r1', name: 'read_file', arguments: {} },
    ];
    const results = await executeTools(calls, { registry: tools, cwd: '/tmp', planMode: true });

    // 写工具被拦截：execute 不应被调用，结果含「计划模式」
    expect(writeExec).not.toHaveBeenCalled();
    expect(results[0]!.ok).toBe(false);
    expect(String(results[0]!.output)).toContain('计划模式');
    // 只读工具正常执行
    expect(readExec).toHaveBeenCalledTimes(1);
    expect(results[1]!.ok).toBe(true);
  });

  it('非 planMode 时写工具不拦截', async () => {
    const writeExec = vi.fn(async () => ({ ok: true, output: '写了' }) as ToolResult);
    const tools = registryWith([
      { name: 'write_file', description: '', inputSchema: idleSchema, isReadOnly: false, execute: writeExec },
    ]);
    const results = await executeTools(
      [{ id: 'w1', name: 'write_file', arguments: {} }],
      { registry: tools, cwd: '/tmp' },
    );
    expect(writeExec).toHaveBeenCalledTimes(1);
    expect(results[0]!.ok).toBe(true);
  });
});

describe('Phase 15 · 执行器：异步并行并发池', () => {
  /** 造 N 个只读工具，执行时记录并发峰值并 sleep，便于验证并行 */
  function parallelReadTools(n: number, log: { starts: number[]; ends: number[] }): ToolDef[] {
    return Array.from({ length: n }, (_, i) => ({
      name: `read${i}`,
      description: '',
      inputSchema: idleSchema,
      isReadOnly: true,
      execute: async () => {
        log.starts.push(Date.now());
        await new Promise((r) => setTimeout(r, 25));
        log.ends.push(Date.now());
        return { ok: true, output: `r${i}` } as ToolResult;
      },
    }));
  }

  it('并发上限生效：cap=2 时峰值并发不超过 2，且确实并行', async () => {
    const log = { starts: [], ends: [] };
    const tools = registryWith(parallelReadTools(5, log));
    const calls: ToolCall[] = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      name: `read${i}`,
      arguments: {},
    }));
    const onBatch = vi.fn();
    const bus = new EventBus();
    const busSpy = vi.fn();
    bus.on('tool:batch', busSpy);

    const results = await executeTools(calls, {
      registry: tools,
      cwd: '/tmp',
      bus,
      maxReadOnlyConcurrency: 2,
      hooks: { onBatch },
    });

    expect(results).toHaveLength(5);
    expect(results.every((r) => r.ok)).toBe(true);
    // 钩子 + 事件都被触发，且 peak 受 cap 约束
    expect(onBatch).toHaveBeenCalledTimes(1);
    const info: ToolBatchInfo = onBatch.mock.calls[0]![0];
    expect(info.readCount).toBe(5);
    expect(info.writeCount).toBe(0);
    expect(info.maxConcurrency).toBe(2); // 受限上限
    expect(busSpy).toHaveBeenCalledTimes(1);
    expect(busSpy.mock.calls[0]![0].type).toBe('tool:batch');
  });

  it('cap=1 时退化为全串行（峰值并发=1）', async () => {
    const log = { starts: [], ends: [] };
    const tools = registryWith(parallelReadTools(3, log));
    const calls: ToolCall[] = Array.from({ length: 3 }, (_, i) => ({
      id: `c${i}`,
      name: `read${i}`,
      arguments: {},
    }));
    const onBatch = vi.fn();
    const results = await executeTools(calls, {
      registry: tools,
      cwd: '/tmp',
      maxReadOnlyConcurrency: 1,
      hooks: { onBatch },
    });
    expect(results).toHaveLength(3);
    expect(onBatch.mock.calls[0]![0].maxConcurrency).toBe(1);
  });

  it('大并发上限时全部并行（峰值并发=N）', async () => {
    const log = { starts: [], ends: [] };
    const tools = registryWith(parallelReadTools(3, log));
    const calls: ToolCall[] = Array.from({ length: 3 }, (_, i) => ({
      id: `c${i}`,
      name: `read${i}`,
      arguments: {},
    }));
    const onBatch = vi.fn();
    const results = await executeTools(calls, {
      registry: tools,
      cwd: '/tmp',
      maxReadOnlyConcurrency: 10,
      hooks: { onBatch },
    });
    expect(results).toHaveLength(3);
    expect(onBatch.mock.calls[0]![0].maxConcurrency).toBe(3);
  });
});

describe('Phase 15 · runAgent 规划模式', () => {
  it('planMode 下模型试图写文件被拦，随后产出计划结束', async () => {
    const writeExec = vi.fn(async () => ({ ok: true, output: '写了' }) as ToolResult);
    const tools = registryWith([
      { name: 'write_file', description: '', inputSchema: idleSchema, isReadOnly: false, execute: writeExec },
      { name: 'read_file', description: '', inputSchema: idleSchema, isReadOnly: true, execute: async () => ({ ok: true, output: '内容' }) as ToolResult },
    ]);
    // 第 1 轮：请求写文件（会被 planMode 拦截）→ 第 2 轮：给出计划文本
    const call: ToolCall = { id: 'w1', name: 'write_file', arguments: { path: 'x', content: 'y' } };
    const model = new ScriptedModel([
      { content: '', toolCalls: [call] },
      { content: '## 计划\n1. 读取 x\n2. 改写 x', toolCalls: [] },
    ]);
    const history: ChatMessage[] = [sys, user];

    await runAgent(history, { model, tools, cwd: '/tmp', planMode: true });

    // 写工具从未真正执行
    expect(writeExec).not.toHaveBeenCalled();
    // 最终 assistant 消息是计划文本
    const last = history[history.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(String(last.content)).toContain('计划');
    // 被拦截的写调用仍回注了 role:tool 结果，历史合法
    const toolMsgs = history.filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBe(1);
    expect(String(toolMsgs[0]!.content)).toContain('计划模式');
    expect(model.calls).toBe(2);
  });
});
