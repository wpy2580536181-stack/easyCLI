import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskStore, runTasksInParallel, getTaskTools, type Task } from '../../src/core/tasks';
import { createToolRegistry } from '../../src/core/tools/registry';
import type { ToolDef } from '../../src/core/chatmodel/types';
import type { SubagentDeps } from '../../src/core/multiagent/subagent';

// 进程内无需真实模型/权限；并发安全的断言不依赖 LLM。
const baseDeps = {
  model: {} as SubagentDeps['model'],
  permission: {} as SubagentDeps['permission'],
  bus: undefined,
  cwd: '',
  tools: createToolRegistry(),
} as unknown as SubagentDeps;

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tasktest-'));
  baseDeps.cwd = tmp;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('Phase 25 原子 claim + 看板扇出', () => {
  it('并发 claimTask 同一任务：恰好一个成功（原子锁防重复认领）', async () => {
    const store = new TaskStore(tmp);
    store.createTask({ subject: 'A' });
    const [r1, r2] = await Promise.all([store.claimTask('1'), store.claimTask('1')]);
    expect(r1.ok !== r2.ok).toBe(true); // 一个成功、一个失败
    expect(store.getTask('1')!.status).toBe('in_progress');
    expect(store.getTask('1')!.owner).toBe('agent');
  });

  it('runTasksInParallel 按依赖图并发执行并清空看板', async () => {
    const store = new TaskStore(tmp);
    const a = store.createTask({ subject: 'A' });
    const b = store.createTask({ subject: 'B', blockedBy: [a.id] });
    const c = store.createTask({ subject: 'C', blockedBy: [a.id] });

    const order: string[] = [];
    const exec = async (t: Task): Promise<string> => {
      order.push(t.id);
      return `done ${t.id}`;
    };

    const res = await runTasksInParallel({ store, ...baseDeps, maxWorkers: 2, executeTask: exec });

    expect(res.done).toBe(3);
    expect(store.listTasks().every((t) => t.status === 'completed')).toBe(true);
    // 依赖保证：根任务 A 必须先于其下游 B、C 执行
    expect(order.indexOf(a.id)).toBeLessThan(order.indexOf(b.id));
    expect(order.indexOf(a.id)).toBeLessThan(order.indexOf(c.id));
    // 无重复认领：每个任务恰好执行一次
    expect(new Set(order).size).toBe(3);
  });

  it('runTasksInParallel 串行链也能跑完（maxWorkers=1）', async () => {
    const store = new TaskStore(tmp);
    const a = store.createTask({ subject: 'A' });
    const b = store.createTask({ subject: 'B', blockedBy: [a.id] });
    const c = store.createTask({ subject: 'C', blockedBy: [b.id] });
    const order: string[] = [];
    const exec = async (t: Task): Promise<string> => {
      order.push(t.id);
      return `done ${t.id}`;
    };
    const res = await runTasksInParallel({ store, ...baseDeps, maxWorkers: 1, executeTask: exec });
    expect(res.done).toBe(3);
    expect(order).toEqual([a.id, b.id, c.id]);
  });

  it('getTaskTools 仅在有 subDeps 时注册 task_run_parallel', () => {
    const store = new TaskStore(tmp);
    const without: ToolDef[] = getTaskTools(store);
    expect(without.some((t) => t.name === 'task_run_parallel')).toBe(false);
    const withDeps: ToolDef[] = getTaskTools(store, baseDeps);
    expect(withDeps.some((t) => t.name === 'task_run_parallel')).toBe(true);
  });
});
