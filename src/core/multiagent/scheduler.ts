// 差异5（PaiCLI 对照 P2）：依赖图拓扑调度器。
//
// 取代原 orchestrator 的 mapPool（无脑全并行）。本调度器按子任务的 dependsOn
// 构建 DAG，做**环检测**；无环则按拓扑就绪度调度（依赖全部完成的节点才开跑，
// 并发上限 maxWorkers），完成的节点会解锁下游；检测到环则**降级为全并行**并告警，
// 绝不因畸形计划而崩。
//
// 关键不变式：各 Worker 在隔离 worktree 运行、无法共享文件，依赖靠「前置结果文本」
// 注入下游（见 orchestrator 的 worker 闭包），而非文件系统合并。

import type { Subtask, WorkerResult } from './types';

export interface SchedulerDeps {
  /** Worker 并发上限 */
  maxWorkers: number;
  /** 降级/重复 id/未知依赖等告警回调（REPL 用来打印一行提示） */
  onWarn?: (msg: string) => void;
}

export interface SchedulerResult {
  /** 与输入 subtasks 一一对齐的 Worker 结果 */
  workers: WorkerResult[];
  /** 实际执行顺序（满足「依赖必先于下游」的拓扑序列） */
  executionOrder: string[];
  /** 是否因检测到环而降级为全并行 */
  degradedToParallel: boolean;
}

/**
 * 依赖有序执行：按 DAG 就绪度调度，每个 worker 拿到其 dependsOn 对应的前置结果。
 * @param worker (subtask, predecessors) => WorkerResult；predecessors 为已完成的依赖结果（按 id 排序）
 */
export async function runScheduled(
  subtasks: Subtask[],
  worker: (subtask: Subtask, predecessors: WorkerResult[]) => Promise<WorkerResult>,
  deps: SchedulerDeps,
): Promise<SchedulerResult> {
  const onWarn = deps.onWarn;
  if (subtasks.length === 0) {
    return { workers: [], executionOrder: [], degradedToParallel: false };
  }

  // ── 建索引 + 清洗依赖（去重 id、忽略未知/自环依赖）──
  const byId = new Map<string, Subtask>();
  for (const s of subtasks) {
    if (byId.has(s.id)) {
      onWarn?.(`子任务 id 重复：${s.id}，仅保留第一个`);
      continue;
    }
    byId.set(s.id, s);
  }
  const depsOf = new Map<string, string[]>();
  for (const s of subtasks) {
    const raw = s.dependsOn ?? [];
    const valid = raw.filter((d) => byId.has(d) && d !== s.id);
    if (valid.length !== raw.length) onWarn?.(`子任务 ${s.id} 的依赖含未知/自环 id，已忽略`);
    depsOf.set(s.id, valid);
  }

  // ── 环检测（Kahn 算法）──
  const indeg = new Map<string, number>();
  const succ = new Map<string, string[]>();
  for (const s of subtasks) {
    indeg.set(s.id, 0);
    succ.set(s.id, []);
  }
  for (const s of subtasks) {
    for (const d of depsOf.get(s.id)!) {
      indeg.set(s.id, (indeg.get(s.id) ?? 0) + 1);
      succ.get(d)!.push(s.id);
    }
  }
  const queue: string[] = [];
  for (const s of subtasks) if ((indeg.get(s.id) ?? 0) === 0) queue.push(s.id);
  let processed = 0;
  while (queue.length) {
    const id = queue.shift()!;
    processed++;
    for (const n of succ.get(id)!) {
      const nd = (indeg.get(n)! - 1);
      indeg.set(n, nd);
      if (nd === 0) queue.push(n);
    }
  }
  const hasCycle = processed < subtasks.length;

  // 完成回调：回填 done、记录顺序、解锁下游
  const done = new Map<string, WorkerResult>();
  const executionOrder: string[] = [];
  let finished = 0;
  const total = subtasks.length;
  // 初始就绪集合：无依赖的节点（在环分支不用，但在 settle 内被引用，故在此声明避免 TDZ）
  const ready = new Set<string>(
    subtasks.filter((s) => (depsOf.get(s.id)?.length ?? 0) === 0).map((s) => s.id),
  );

  const settle = (id: string, r: WorkerResult): void => {
    done.set(id, r);
    executionOrder.push(id);
    finished++;
    for (const n of succ.get(id)!) {
      const allDone = depsOf.get(n)!.every((d) => done.has(d));
      if (allDone) ready.add(n);
    }
  };

  if (hasCycle) {
    onWarn?.('检测到子任务依赖成环，已降级为全部并行执行（依赖约束被忽略）。');
    const workers = await runPool(subtasks, deps.maxWorkers, async (s) => {
      const r = await worker(s, []);
      settle(s.id, r);
      return r;
    });
    return { workers, executionOrder, degradedToParallel: true };
  }

  // ── 依赖有序调度（ready 集合 + 并发上限）──
  await new Promise<void>((resolveAll, rejectAll) => {
    const active = new Set<string>();
    const cap = Math.max(1, deps.maxWorkers);
    const pump = (): void => {
      while (active.size < cap && ready.size > 0) {
        const id = [...ready][0]!;
        ready.delete(id);
        active.add(id);
        const subtask = byId.get(id)!;
        const predecessors = depsOf.get(id)!.map((d) => done.get(d)!).filter(Boolean);
        worker(subtask, predecessors)
          .then((r) => {
            active.delete(id);
            settle(id, r);
            if (finished >= total) resolveAll();
            else pump();
          })
          .catch((e) => {
            // 单个失败不应卡死整体调度：构造失败结果继续，让 Reviewer 照常汇总
            active.delete(id);
            settle(id, {
              subtask: byId.get(id)!,
              cwd: '(调度异常)',
              output: '',
              artifact: { changedFiles: [], summary: '', findings: undefined },
              round: 0,
              ok: false,
              error: e instanceof Error ? e.message : String(e),
              history: [],
            });
            if (finished >= total) resolveAll();
            else pump();
          });
      }
    };
    pump();
    // 若首轮无任何 ready（理论不会，已排除环）则直接结束，避免悬挂
    if (active.size === 0 && ready.size === 0) resolveAll();
    // rejectAll 仅占位，实际错误已在 settle 中消化
    void rejectAll;
  });

  const workers = subtasks.map((s) => done.get(s.id)!);
  return { workers, executionOrder, degradedToParallel: false };
}

/** 有界并发执行（降级路径用） */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const exec = async (): Promise<void> => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  };
  const cap = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: cap }, () => exec()));
  return out;
}
