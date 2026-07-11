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

  /** 认领：pending → in_progress 并记录 owner；依赖未完成或被他人认领则拒绝 */
  claimTask(id: string, owner = 'agent'): ClaimResult {
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
export function getTaskTools(store: TaskStore): ToolDef[] {
  return [
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
        const r = store.claimTask(id, owner);
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
}
