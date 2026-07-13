import type { AgentHooks } from '../agent/loop';
import type { EventBus } from '../events/bus';
import type { PermissionManager } from '../security/permission';
import type { ToolCall, ToolDef, ToolResult } from '../chatmodel/types';
import type { ToolRegistry } from './registry';
import { validateArgs } from './schema-validate';

/** 一批工具调用执行完毕后的并发画像（Phase 15 异步并行可观测） */
export interface ToolBatchInfo {
  /** 本批只读工具数量 */
  readCount: number;
  /** 本批写/破坏性工具数量 */
  writeCount: number;
  /** 只读工具执行期间的峰值并发数（受 maxReadOnlyConcurrency 限制） */
  maxConcurrency: number;
}

export interface ExecutorOptions {
  registry: ToolRegistry;
  /** 三级权限；不提供则全部放行（仅用于测试/脚本模式） */
  permission?: PermissionManager;
  /** 事件总线；提供则审计等订阅者能收到 tool:call / tool:result / tool:batch */
  bus?: EventBus;
  cwd: string;
  signal?: AbortSignal;
  /** 渲染钩子（REPL 用），与总线解耦 */
  hooks?: AgentHooks;
  /** 只读工具最大并发，默认 10（Phase 15 异步并行池上限） */
  maxReadOnlyConcurrency?: number;
  /**
   * 规划模式（Phase 15）：开启后，任何非只读工具一律被拦截为「权限拒绝」，
   * 保证规划阶段只做只读探测、绝不落下任何改动。
   */
  planMode?: boolean;
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
 * 有界并发 map（Phase 15 异步并行核心）。
 * 同时最多 `limit` 个 worker 在跑；返回结果与入参顺序对齐，并记录运行期间峰值并发数。
 * worker 不抛（runOne 内部已吞异常），故池子不会因单任务失败而中断。
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<{ results: R[]; maxConcurrency: number }> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let active = 0;
  let maxActive = 0;

  const take = (): Promise<void> => {
    if (cursor >= items.length) return Promise.resolve();
    const i = cursor++;
    active++;
    if (active > maxActive) maxActive = active;
    return Promise.resolve(worker(items[i]!))
      .then((r) => {
        results[i] = r;
      })
      .catch(() => {
        /* worker 失败不应中断池（runOne 已保证不抛，这里双保险） */
      })
      .finally(() => {
        active--;
        return take();
      });
  };

  const cap = Math.max(1, Math.min(limit, items.length || 1));
  const runners: Promise<void>[] = [];
  for (let k = 0; k < cap; k++) runners.push(take());
  await Promise.all(runners);
  return { results, maxConcurrency: maxActive };
}

/**
 * 执行一批 tool_calls：
 * - 先按权限（三级 + HITL）逐个决策，被拒的产出「权限拒绝」结果；
 * - **规划模式**下，任何非只读工具直接升级为「权限拒绝」（硬 gate，不依赖模型自觉）；
 * - **只读工具受并发池约束并行执行**（默认上限 10），**写/破坏性工具串行执行**（避免竞态）；
 * - 每批结束 emit `tool:call`/`tool:result` 与 `tool:batch`（并发画像）到总线，并触发渲染钩子；
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
      // 规划模式硬 gate：非只读工具一律拦截（即使权限允许也禁止，避免落下改动）
      if (opts.planMode && !readOnly) {
        allowed = false;
        denyReason = '计划模式：仅允许只读工具（写/破坏性操作被禁止）';
      }
      return { index, call, tool, allowed, denyReason, readOnly };
    }),
  );

  const reads = planned.filter((p) => p.allowed && p.readOnly);
  const writes = planned.filter((p) => p.allowed && !p.readOnly);
  const denied = planned.filter((p) => !p.allowed);

  // 只读并行（受 maxReadOnlyConcurrency 限制的有界并发池）
  const cap = opts.maxReadOnlyConcurrency ?? 10;
  const { results: readResults, maxConcurrency } = await mapWithConcurrency(
    reads,
    cap,
    (p) => runOne(p, opts),
  );
  for (let i = 0; i < reads.length; i++) results[reads[i]!.index] = readResults[i]!;
  // 写/破坏性串行
  for (const p of writes) results[p.index] = await runOne(p, opts);
  // 被拒：同样 emit 事件（审计需要记录「曾尝试并已被拦截」），但不执行工具体
  for (const p of denied) results[p.index] = await runOne(p, opts);

  // Phase 15：本批并发画像——emit 事件 + 触发钩子，供可观测层/UI 展示
  if (reads.length > 0 || writes.length > 0) {
    const info: ToolBatchInfo = {
      readCount: reads.length,
      writeCount: writes.length,
      maxConcurrency,
    };
    opts.bus?.emit({ type: 'tool:batch', ...info });
    opts.hooks?.onBatch?.(info);
  }

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
    // 入口处按工具 inputSchema 校验实参：非法参数在执行前即拦截，避免「跑一半才报错」。
    // 仅当 schema 非空才校验；校验器对未知关键字 fail-open，绝不误拒合法调用。
    const schema = p.tool.inputSchema;
    let preErr: string | undefined;
    if (schema && typeof schema === 'object' && Object.keys(schema).length > 0) {
      const v = validateArgs(schema as Record<string, unknown>, p.call.arguments);
      if (!v.ok) preErr = `工具入参校验失败: ${v.error}`;
    }
    if (preErr) {
      res = { ok: false, output: preErr };
    } else {
      try {
        res = await p.tool.execute(p.call.arguments, { cwd: opts.cwd, signal: opts.signal });
      } catch (e) {
        res = { ok: false, output: `工具执行异常: ${(e as Error).message}` };
      }
    }
  }

  opts.bus?.emit({ type: 'tool:result', call: p.call, result: res });
  opts.hooks?.onToolResult?.(p.call, res);
  return res;
}
