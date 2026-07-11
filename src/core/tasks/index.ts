// Phase 24：Task System（任务系统）——对齐 Learn Claude Code s12。
//
// s12 核心：每个任务是一个 JSON 文件，持久化在 `.tasks/{id}.json`（跨会话 / 上下文压缩后可恢复）；
// 任务之间用 `blockedBy` 形成有向无环依赖图；`claim_task` 认领（依赖未完成则拒绝）、
// `complete_task` 标记完成并自动解锁下游。Task System 与 s05 的 TodoWrite 在 CC 里是两套并存系统：
//   - TodoWrite（本项目 Phase 21 todo_write）= 会话内执行清单（内存，进程退出即清空）；
//   - Task System（本文件）= 可持久化、有依赖图、可认领/解锁、跨会话保留的任务图。
//
// 复用同一 runAgent 引擎；多 Agent 场景下 `owner` + `claim_task` 防止重复认领
// （本项目的 Phase 17 /agent 编排器、Phase 23 subagent 已提供多 Agent 引擎，可在此基础上叠加本任务图）。

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDef } from '../chatmodel/types';
import { spawnSubagent, type SubagentDeps } from '../multiagent/subagent';

/**
 * 进程内异步互斥锁：把 claim 的「读-检查-写」包成原子临界区，防止并发认领时的 TOCTOU 重复认领
 * （对齐 s12 文件锁思想）。跨进程/跨 CLI 实例的强一致需要 proper-lockfile 之类的真实文件锁。
 */
class AsyncMutex {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const p = this.chain.then(fn, () => {}) as Promise<T>;
    this.chain = p.then(() => {}, () => {});
    return p;
  }
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

/** 一个任务：持久化为 `.tasks/{id}.json` 的单文件 */
export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  /** 认领者名字（多 Agent 场景）；未认领为 null */
  owner: string | null;
  /** 上游依赖：这些任务全部 completed 后才能 claim 本任务 */
  blockedBy: string[];
  /** 下游被阻塞者：本任务 completed 后可能被解锁（创建时由 blockedBy 反向维护） */
  blocks: string[];
  /** 进行时描述（可选），供 UI spinner 展示，对齐 CC 的 activeForm */
  activeForm?: string;
  /** 任意扩展键值对 */
  metadata?: Record<string, unknown>;
}

export interface CreateTaskInput {
  subject: string;
  description?: string;
  blockedBy?: string[];
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

export interface ClaimResult {
  ok: boolean;
  msg: string;
}
export interface CompleteResult {
  ok: boolean;
  msg: string;
  unblocked: string[];
}

const TASK_FILE = (id: string) => `${id}.json`;
const isTaskFile = (f: string) => f.endsWith('.json') && !f.startsWith('.');

/**
 * 文件持久化的任务存储。根目录下的 `.tasks/` 存放每个任务一个 JSON 文件，
 * 另有一个 `.highwatermark` 记录已分配过的最大 ID（即使任务被删，ID 也不重用 —— 对齐 CC 严谨设计）。
 */
export class TaskStore {
  private readonly dir: string;
  private readonly hwPath: string;
  /** 进程内互斥锁：保证 claim 临界区原子，避免并发认领重复 */
  private readonly lock = new AsyncMutex();

  constructor(rootDir: string) {
    this.dir = join(rootDir, '.tasks');
    this.hwPath = join(this.dir, '.highwatermark');
  }

  /** 懒创建 .tasks 目录（仅在首次写入时落盘，未使用时不在项目里留痕） */
  private ensure(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private readRaw(id: string): Task | null {
    const p = join(this.dir, TASK_FILE(id));
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as Task;
    } catch {
      return null;
    }
  }

  private writeRaw(task: Task): void {
    this.ensure();
    writeFileSync(join(this.dir, TASK_FILE(task.id)), JSON.stringify(task, null, 2), 'utf8');
  }

  /** 高水位标：返回下一个顺序 ID 字符串，并写回 +1（防 ID 重用） */
  nextId(): string {
    this.ensure();
    let n = 0;
    if (existsSync(this.hwPath)) n = parseInt(readFileSync(this.hwPath, 'utf8').trim(), 10) || 0;
    n += 1;
    writeFileSync(this.hwPath, String(n), 'utf8');
    return String(n);
  }

  /** 创建任务并持久化；自动把本任务 id 反向补到各上游依赖的 `blocks` 里 */
  createTask(input: CreateTaskInput): Task {
    this.ensure();
    const id = this.nextId();
    const task: Task = {
      id,
      subject: input.subject,
      description: input.description ?? '',
      status: 'pending',
      owner: null,
      blockedBy: input.blockedBy ?? [],
      blocks: [],
      ...(input.activeForm ? { activeForm: input.activeForm } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    for (const dep of task.blockedBy) {
      const dt = this.readRaw(dep);
      if (dt && !dt.blocks.includes(id)) {
        dt.blocks.push(id);
        this.writeRaw(dt);
      }
    }
    this.writeRaw(task);
    return task;
  }

  getTask(id: string): Task | null {
    return this.readRaw(id);
  }

  listTasks(): Task[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter(isTaskFile)
      .map((f) => this.readRaw(f.replace(/\.json$/, '')!))
      .filter((t): t is Task => t !== null)
      .sort((a, b) => Number(a.id) - Number(b.id));
  }

  /** 一个任务可开始的前提：所有 blockedBy 依赖都已 completed（缺失依赖视为 blocked） */
  canStart(id: string): boolean {
    const t = this.readRaw(id);
    if (!t) return false;
    for (const dep of t.blockedBy) {
      const d = this.readRaw(dep);
      if (!d || d.status !== 'completed') return false;
    }
    return true;
  }

  /** 认领：pending → in_progress 并记录 owner；依赖未完成或被他人认领则拒绝。原子临界区防并发重复认领。 */
  async claimTask(id: string, owner = 'agent'): Promise<ClaimResult> {
    return this.lock.run(() => {
      const t = this.readRaw(id);
      if (!t) return { ok: false, msg: `task ${id} 不存在` };
      if (t.status !== 'pending') return { ok: false, msg: `task ${id} is ${t.status}, cannot claim` };
      if (!this.canStart(id)) {
        const deps = t.blockedBy.filter((d) => {
          const dd = this.readRaw(d);
          return !dd || dd.status !== 'completed';
        });
        return { ok: false, msg: `Blocked by: ${deps.join(', ')}` };
      }
      t.owner = owner;
      t.status = 'in_progress';
      this.writeRaw(t);
      return { ok: true, msg: `Claimed ${id} (${t.subject})` };
    });
  }

  /** 完成：in_progress → completed，并算出刚被解锁的下游 pending 任务 */
  completeTask(id: string): CompleteResult {
    const t = this.readRaw(id);
    if (!t) return { ok: false, msg: `task ${id} 不存在`, unblocked: [] };
    t.status = 'completed';
    this.writeRaw(t);
    const unblocked = this.listTasks()
      .filter((x) => x.status === 'pending' && x.blockedBy.length > 0 && this.canStart(x.id))
      .map((x) => x.subject);
    const msg = `Completed ${id} (${t.subject})`;
    return {
      ok: true,
      msg: unblocked.length ? `${msg}\nUnblocked: ${unblocked.join(', ')}` : msg,
      unblocked,
    };
  }

  /** 删除任务并从上游依赖的 blocks 中移除（高水位标不回退，ID 不重用） */
  deleteTask(id: string): boolean {
    const p = join(this.dir, TASK_FILE(id));
    if (!existsSync(p)) return false;
    const t = this.readRaw(id);
    if (t) {
      for (const dep of t.blockedBy) {
        const dt = this.readRaw(dep);
        if (dt) {
          dt.blocks = dt.blocks.filter((b) => b !== id);
          this.writeRaw(dt);
        }
      }
    }
    rmSync(p);
    return true;
  }
}

/** 把任务清单渲染成带状态/依赖的多行文本（工具结果复用） */
export function renderTasks(tasks: Task[]): string {
  if (tasks.length === 0) return '(无任务)';
  const lines = tasks.map((t) => {
    const owner = t.owner ? ` @${t.owner}` : '';
    const dep = t.blockedBy.length ? `  ↩ ${t.blockedBy.join(',')}` : '';
    return `${t.id}\t[${t.status}]${owner}\t${t.subject}${dep}`;
  });
  return lines.join('\n');
}

/**
 * 任务系统工具集（Phase 24）。注册进主 Agent 工具表后，agent 即可在循环内
 * 把大目标拆成有依赖、可持久化、可认领/解锁的任务图（对齐 s12）。
 */
export function getTaskTools(store: TaskStore, subDeps?: SubagentDeps): ToolDef[] {
  const tools: ToolDef[] = [
    {
      name: 'task_create',
      description:
        '创建一个任务并持久化到 .tasks/{id}.json（跨会话/上下文压缩后可恢复）。可声明 blockedBy 依赖，' +
        '形成有向无环的任务图。适合「多步、任务间有先后、或需跨会话恢复进度」的场景。',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: '简短标题（祈使句，如「搭建数据库表」）' },
          description: { type: 'string', description: '详细描述（可选）' },
          blockedBy: {
            type: 'array',
            items: { type: 'string' },
            description: '依赖的任务 id 列表（这些任务全部完成才能 claim 本任务）',
          },
          activeForm: { type: 'string', description: '进行时描述（可选），如「正在建表」' },
        },
        required: ['subject'],
      },
      isReadOnly: false,
      isDestructive: false,
      execute: async (args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> => {
        const subject = typeof args.subject === 'string' ? args.subject.trim() : '';
        if (!subject) return { ok: false, output: '缺少参数 subject（任务标题）' };
        const blockedBy = Array.isArray(args.blockedBy)
          ? args.blockedBy.filter((x: unknown) => typeof x === 'string')
          : [];
        const t = store.createTask({
          subject,
          description: typeof args.description === 'string' ? args.description : '',
          blockedBy,
          activeForm: typeof args.activeForm === 'string' ? args.activeForm : undefined,
        });
        return { ok: true, output: JSON.stringify(t, null, 2) };
      },
    },
    {
      name: 'task_list',
      description: '列出所有任务（id / 状态 / owner / blockedBy），用于查看任务图全貌与当前可认领项。',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      isDestructive: false,
      execute: async (): Promise<{ ok: boolean; output: string }> => {
        return { ok: true, output: renderTasks(store.listTasks()) };
      },
    },
    {
      name: 'task_get',
      description: '读取单个任务的完整 JSON（含 description 与依赖细节）；跨会话恢复时用来拿完整上下文继续工作。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '任务 id' } },
        required: ['id'],
      },
      isReadOnly: true,
      isDestructive: false,
      execute: async (args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> => {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return { ok: false, output: '缺少参数 id' };
        const t = store.getTask(id);
        if (!t) return { ok: false, output: `task ${id} 不存在` };
        return { ok: true, output: JSON.stringify(t, null, 2) };
      },
    },
    {
      name: 'task_claim',
      description:
        '认领一个任务：状态 pending → in_progress 并记录 owner。依赖（blockedBy）未全部完成会被拒绝。' +
        '多 Agent 场景下用于防止重复认领——开始做某个任务前应先 claim。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 id' },
          owner: { type: 'string', description: '认领者名字（可选，默认 agent）' },
        },
        required: ['id'],
      },
      isReadOnly: false,
      isDestructive: false,
      execute: async (args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> => {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return { ok: false, output: '缺少参数 id' };
        const owner = typeof args.owner === 'string' ? args.owner : 'agent';
        const r = await store.claimTask(id, owner);
        return { ok: r.ok, output: r.msg };
      },
    },
    {
      name: 'task_complete',
      description:
        '标记任务完成（in_progress → completed），并自动解锁下游：列出因本任务完成而刚可开始的 pending 任务。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '任务 id' } },
        required: ['id'],
      },
      isReadOnly: false,
      isDestructive: false,
      execute: async (args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> => {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return { ok: false, output: '缺少参数 id' };
        const r = store.completeTask(id);
        return { ok: r.ok, output: r.msg };
      },
    },
  ];

  // task_run_parallel：仅当提供了 subagent 依赖（有引擎可派发子 Agent）时注册。
  // 它把「看板 + 并发认领」串成 s12 的并行处理：自动认领可开始任务、有界并发派子 Agent、完成解锁下游。
  if (subDeps) {
    tools.push({
      name: 'task_run_parallel',
      description:
        '并行执行看板上的任务（对齐 s12 多 Agent 并行处理）：自动从 .tasks/ 看板认领「当前可开始」' +
        '（pending 且 blockedBy 全部 completed）的任务，用有界并发（maxWorkers）派发子 Agent 去执行，' +
        '每完成一个就自动解锁下游被阻塞的任务，直到看板清空。仅在已用 task_create 建好任务图后调用。' +
        '琐碎任务无需并行；共享 cwd（文件系统副作用保留在主工作目录）。',
      inputSchema: {
        type: 'object',
        properties: {
          maxWorkers: {
            type: 'number',
            description: '并发上限（默认 3，范围 1-8）',
          },
        },
      },
      // 编排本身不改主目录（子 Agent 各自经权限 gate 写文件）；标 isReadOnly 以便非交互/Plan 模式也能触发。
      isReadOnly: true,
      isDestructive: false,
      execute: async (args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> => {
        const mwRaw = typeof args.maxWorkers === 'number' ? args.maxWorkers : 3;
        const mw = Math.max(1, Math.min(8, Math.floor(mwRaw)));
        const res = await runTasksInParallel({ store, ...subDeps, maxWorkers: mw });
        const lines = res.results.map((r) => `${r.id}\t[done]\t${r.subject}`);
        return {
          ok: true,
          output: `并行完成 ${res.done} 个任务：\n${lines.join('\n')}`,
        };
      },
    });
  }

  return tools;
}

/** 看板扇出调度器的依赖（在 SubagentDeps 基础上加 store 与并发参数） */
export interface ParallelTaskDeps extends SubagentDeps {
  store: TaskStore;
  maxWorkers?: number;
  /** 注入式任务执行器（默认用 spawnSubagent 派发子 Agent 执行）；测试可传假执行器 */
  executeTask?: (task: Task) => Promise<string>;
}

export interface ParallelTaskResult {
  done: number;
  results: Array<{ id: string; subject: string; ok: boolean; output: string }>;
}

/**
 * 看板扇出调度器（对齐 s12 并行处理）：从 .tasks/ 看板持续认领「可开始」的任务，
 * 用有界并发池派发子 Agent 执行，完成一个自动解锁下游，直到看板清空。
 * claim 走原子锁，多个 worker 不会重复认领同一任务。
 */
export async function runTasksInParallel(opts: ParallelTaskDeps): Promise<ParallelTaskResult> {
  const { store, model, permission, bus, cwd, tools, maxWorkers = 3 } = opts;
  const exec: (task: Task) => Promise<string> =
    opts.executeTask ??
    ((task: Task) =>
      spawnSubagent({
        model,
        permission,
        bus,
        cwd,
        tools,
        description: `任务 [${task.id}] ${task.subject}\n${task.description}`.trim(),
        // 并行 worker 只负责干活，不碰看板（防干扰调度器对任务状态的权威管理）
        stripAllTaskTools: true,
      }));
  const results: ParallelTaskResult['results'] = [];

  /** 认领下一个「可开始」的任务；当前无可认领则返回 null（原子锁保证不会两个 worker 抢同一任务） */
  async function claimNext(): Promise<Task | null> {
    const candidates = store.listTasks().filter((t) => t.status === 'pending' && store.canStart(t.id));
    for (const t of candidates) {
      const r = await store.claimTask(t.id, 'worker');
      if (r.ok) return t;
      // 被别的 worker 抢走 → 试下一个候选
    }
    return null;
  }

  async function worker(): Promise<void> {
    for (;;) {
      const t = await claimNext();
      if (!t) return;
      const output = await exec(t);
      await store.completeTask(t.id);
      results.push({ id: t.id, subject: t.subject, ok: true, output });
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, maxWorkers) }, () => worker()));
  return { done: results.length, results };
}
