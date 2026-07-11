import type { ToolDef } from '../chatmodel/types';

// Phase 21：任务规划（TodoWrite）。
//
// 设计参照 "Learn Claude Code · s05 TodoWrite"：给模型一份**可见、带状态**的任务清单，
// 让它在动手之前先把复杂任务拆成有序步骤，并在执行中逐项更新状态。
//
// 关键洞察（来自文章）：todo_write **不增加任何执行能力**，只增加**规划能力**——
// 它不读文件、不跑命令，只把「计划」变成可追踪的结构化状态，
// 对抗「对话越长、系统提示影响力被稀释、做到一半即兴发挥漏项」的问题。
//
// 与本项目已有「Plan 模式（Phase 15）」的区别：
//   - Plan 模式 = 只读 gate + 提示模型输出一段 Markdown 计划**文本**（一次性、不可追踪）；
//   - todo_write = 一张**跨轮持久**的任务表，可增删改状态，正常执行模式下也能用。
// 二者正交，可叠加：Plan 模式产出计划文本，todo_write 把计划落成可勾选清单。
//
// 存储选择：会话内内存（TodoStore），进程退出即清空——与文章教学版一致，
// 也符合「任务清单是当前任务的工作记忆，而非跨会话事实（那是 memory 的职责）」。

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  /** 任务内容（祈使句，如「运行测试并修复失败」） */
  content: string;
  status: TodoStatus;
  /** 进行时描述（可选，如「正在运行测试」）——供 UI spinner 展示，对齐 CC 的 activeForm */
  activeForm?: string;
}

/**
 * 会话内任务表：todo_write 每次调用整表覆盖（replace 语义，与文章一致），
 * 便于模型「重画整张清单」而不必增量 patch。REPL 可读取 list() 做 /todos 展示。
 */
export class TodoStore {
  private items: TodoItem[] = [];

  /** 整表覆盖 */
  set(items: TodoItem[]): void {
    this.items = items;
  }

  /** 只读快照 */
  list(): TodoItem[] {
    return [...this.items];
  }

  clear(): void {
    this.items = [];
  }
}

const STATUS_ICON: Record<TodoStatus, string> = {
  pending: ' ',
  in_progress: '▸',
  completed: '✓',
};

/** 把任务清单渲染成带图标与进度的多行文本（工具结果 + 终端展示复用同一份） */
export function renderTodos(items: TodoItem[]): string {
  if (items.length === 0) return '（任务清单为空）';
  const lines = items.map((t) => `  [${STATUS_ICON[t.status]}] ${t.content}`);
  const done = items.filter((t) => t.status === 'completed').length;
  lines.push(`进度：${done}/${items.length} 已完成`);
  return lines.join('\n');
}

/** 把模型传入的原始 todos 规范化为 TodoItem[]（丢弃空内容、非法状态回落 pending） */
function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const content = typeof o.content === 'string' ? o.content.trim() : '';
    if (!content) continue;
    const st = o.status;
    const status: TodoStatus =
      st === 'in_progress' || st === 'completed' ? st : 'pending';
    const item: TodoItem = { content, status };
    if (typeof o.activeForm === 'string' && o.activeForm.trim()) {
      item.activeForm = o.activeForm.trim();
    }
    out.push(item);
  }
  return out;
}

/**
 * 任务规划工具（Phase 21）。
 * todo_write 标 isReadOnly=true：它对代码库无任何副作用（只改会话内任务表），
 * 因此可免 HITL 自动执行、并行安全，且**在 Plan 模式下也不被写 gate 拦截**——
 * 规划态同样需要维护任务清单。
 */
export function getPlanningTools(store: TodoStore): ToolDef[] {
  return [
    {
      name: 'todo_write',
      description:
        '创建并维护一份可追踪的任务清单（TODO），用于把复杂的多步任务拆成有状态的步骤。' +
        '面对需要多步、跨多个文件、或先探索再执行的任务时，应先调用它列出全部步骤（初始 status=pending）；' +
        '开始某一步前把该步置为 in_progress、完成后立刻置 completed；每次调用需传入完整清单（整表覆盖）。' +
        '始终保持同一时刻至多一个 in_progress。简单的单步任务无需使用本工具。它不执行任何实际操作，只维护计划。',
      inputSchema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '完整的任务清单（整表覆盖旧清单）',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '任务内容，用祈使句，如「运行测试并修复失败」' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: '任务状态',
                },
                activeForm: { type: 'string', description: '进行时描述（可选），如「正在运行测试」' },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
      isReadOnly: true,
      isDestructive: false,
      execute: async (args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> => {
        if (!Array.isArray(args.todos)) {
          return { ok: false, output: '缺少参数 todos（应为数组）' };
        }
        const items = normalizeTodos(args.todos);
        if (items.length === 0) {
          return { ok: false, output: 'todos 为空或格式不正确（每项需含非空 content 与 status）' };
        }
        // 软校验：多于一个 in_progress 时给出提示（不拒绝，尊重模型意图，但引导其收敛）
        const running = items.filter((t) => t.status === 'in_progress').length;
        store.set(items);
        const warn =
          running > 1
            ? `\n⚠ 检测到 ${running} 个 in_progress，建议同一时刻只保留一个正在进行的任务。`
            : '';
        return { ok: true, output: `已更新任务清单（${items.length} 项）：\n${renderTodos(items)}${warn}` };
      },
    },
  ];
}
