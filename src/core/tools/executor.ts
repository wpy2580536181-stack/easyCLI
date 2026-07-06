import type { AgentHooks } from '../agent/loop';
import type { EventBus } from '../events/bus';
import type { PermissionManager } from '../security/permission';
import type { ToolCall, ToolDef, ToolResult } from '../chatmodel/types';
import type { ToolRegistry } from './registry';

export interface ExecutorOptions {
  registry: ToolRegistry;
  /** 三级权限；不提供则全部放行（仅用于测试/脚本模式） */
  permission?: PermissionManager;
  /** 事件总线；提供则审计等订阅者能收到 tool:call / tool:result */
  bus?: EventBus;
  cwd: string;
  signal?: AbortSignal;
  /** 渲染钩子（REPL 用），与总线解耦 */
  hooks?: AgentHooks;
  /** 只读工具最大并发，默认 10 */
  maxReadOnlyConcurrency?: number;
}

interface Planned {
  index: number;
  call: ToolCall;
  tool: ToolDef | undefined;
  allowed: boolean;
  denyReason: string;
  readOnly: boolean;
}

function describe(call: ToolCall): string {
  const a = call.arguments as Record<string, unknown>;
  if (call.name === 'bash') return String(a.command ?? '');
  return String(a.path ?? a.pattern ?? '');
}

/**
 * 执行一批 tool_calls：
 * - 先按权限（三级 + HITL）逐个决策，被拒的产出「权限拒绝」结果；
 * - **只读工具并行执行**（Promise.all），**写/破坏性工具串行执行**（避免竞态）；
 * - 每个工具 emit `tool:call`/`tool:result` 到总线，并触发渲染钩子；
 * - 返回结果与入参顺序对齐，便于循环按 index 回填历史。
 */
export async function executeTools(
  calls: ToolCall[],
  opts: ExecutorOptions,
): Promise<ToolResult[]> {
  const results: ToolResult[] = new Array(calls.length);

  const planned: Planned[] = await Promise.all(
    calls.map(async (call, index) => {
      const tool = opts.registry.get(call.name);
      let allowed = true;
      let denyReason = '';
      if (opts.permission) {
        const ok = await opts.permission.resolve(call.name, describe(call));
        if (!ok) {
          allowed = false;
          denyReason = '权限拒绝';
        }
      }
      const readOnly = tool?.isReadOnly ?? false;
      return { index, call, tool, allowed, denyReason, readOnly };
    }),
  );

  const reads = planned.filter((p) => p.allowed && p.readOnly);
  const writes = planned.filter((p) => p.allowed && !p.readOnly);
  const denied = planned.filter((p) => !p.allowed);

  // 只读并行
  await Promise.all(reads.map((p) => runOne(p, opts).then((r) => (results[p.index] = r))));
  // 写/破坏性串行
  for (const p of writes) results[p.index] = await runOne(p, opts);
  // 被拒：同样 emit 事件（审计需要记录「曾尝试并已被拦截」），但不执行工具体
  for (const p of denied) results[p.index] = await runOne(p, opts);

  return results;
}

async function runOne(p: Planned, opts: ExecutorOptions): Promise<ToolResult> {
  opts.bus?.emit({ type: 'tool:call', call: p.call, tool: p.tool });
  opts.hooks?.onToolCall?.(p.call, p.tool);

  let res: ToolResult;
  if (!p.allowed) {
    res = { ok: false, output: p.denyReason };
  } else if (!p.tool || !p.tool.execute) {
    res = { ok: false, output: `未知或未实现工具: ${p.call.name}` };
  } else {
    try {
      res = await p.tool.execute(p.call.arguments, { cwd: opts.cwd, signal: opts.signal });
    } catch (e) {
      res = { ok: false, output: `工具执行异常: ${(e as Error).message}` };
    }
  }

  opts.bus?.emit({ type: 'tool:result', call: p.call, result: res });
  opts.hooks?.onToolResult?.(p.call, res);
  return res;
}
