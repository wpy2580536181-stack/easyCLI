import { describe, it, expect } from 'vitest';
import { runScheduled } from '../../src/core/multiagent/scheduler';
import type { Subtask, WorkerResult } from '../../src/core/multiagent/types';

function st(id: string, dependsOn?: string[]): Subtask {
  return { id, title: id, description: id, dependsOn };
}

function makeWorker(out?: Record<string, string>) {
  return async (s: Subtask, preds: WorkerResult[]): Promise<WorkerResult> => ({
    subtask: s,
    cwd: '/tmp',
    output: out?.[s.id] ?? s.id,
    ok: true,
    history: [],
    // 透出前置 id，便于断言「结果喂回」
    ...({ _preds: preds.map((p) => p.subtask.id) } as object),
  });
}

describe('runScheduled（依赖图拓扑调度器）', () => {
  it('无依赖：全部就绪、按输入顺序对齐返回、不降级', async () => {
    const res = await runScheduled(
      [st('a'), st('b'), st('c')],
      makeWorker(),
      { maxWorkers: 2 },
    );
    expect(res.degradedToParallel).toBe(false);
    expect(res.workers.map((w) => w.subtask.id)).toEqual(['a', 'b', 'c']);
    expect(new Set(res.executionOrder)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('有依赖：executionOrder 满足「依赖必先于下游」', async () => {
    const subtasks = [st('s4', ['s2', 's3']), st('s1'), st('s2', ['s1']), st('s3', ['s1'])];
    const res = await runScheduled(subtasks, makeWorker(), { maxWorkers: 3 });
    const idx = Object.fromEntries(res.executionOrder.map((id, i) => [id, i]));
    expect(idx['s1']!).toBeLessThan(idx['s2']!);
    expect(idx['s2']!).toBeLessThan(idx['s4']!);
    expect(idx['s1']!).toBeLessThan(idx['s3']!);
    expect(idx['s3']!).toBeLessThan(idx['s4']!);
    expect(res.degradedToParallel).toBe(false);
  });

  it('检测到环：降级为全并行并告警', async () => {
    const warns: string[] = [];
    const res = await runScheduled(
      [st('a', ['b']), st('b', ['a'])],
      makeWorker(),
      { maxWorkers: 2, onWarn: (m) => warns.push(m) },
    );
    expect(res.degradedToParallel).toBe(true);
    expect(res.executionOrder.sort()).toEqual(['a', 'b']);
    expect(warns.some((m) => m.includes('环'))).toBe(true);
  });

  it('前置结果注入：下游 Worker 拿到依赖的产出', async () => {
    const captured: Record<string, string[]> = {};
    const res = await runScheduled(
      [st('a'), st('b', ['a'])],
      async (s, preds) => {
        captured[s.id] = preds.map((p) => p.subtask.id);
        return { subtask: s, cwd: '/tmp', output: 'out-' + s.id, ok: true, history: [] };
      },
      { maxWorkers: 2 },
    );
    expect(captured['a']).toEqual([]);
    expect(captured['b']).toEqual(['a']);
    expect(res.workers[1]!.output).toBe('out-b');
  });

  it('并发上限被尊重（maxWorkers=2，3 个就绪任务）', async () => {
    const subtasks = [st('a'), st('b'), st('c')];
    let active = 0;
    let maxA = 0;
    await runScheduled(
      subtasks,
      async (s) => {
        active++;
        maxA = Math.max(maxA, active);
        await new Promise<void>((r) => setImmediate(() => r()));
        active--;
        return { subtask: s, cwd: '/tmp', output: s.id, ok: true, history: [] };
      },
      { maxWorkers: 2 },
    );
    expect(maxA).toBeLessThanOrEqual(2);
  });

  it('忽略未知依赖 id（只保留指向真实子任务的依赖）', async () => {
    const warns: string[] = [];
    const res = await runScheduled(
      [st('a'), st('b', ['a', 'ghost'])],
      makeWorker(),
      { maxWorkers: 2, onWarn: (m) => warns.push(m) },
    );
    expect(res.degradedToParallel).toBe(false);
    expect(warns.some((m) => m.includes('未知'))).toBe(true);
    const idx = Object.fromEntries(res.executionOrder.map((id, i) => [id, i]));
    expect(idx['a']!).toBeLessThan(idx['b']!);
  });
});
