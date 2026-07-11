// Phase 23：Subagent（task 工具）——对齐 Learn Claude Code s06。
//
// s06 核心：主 Agent 在 ReAct 循环里调用 `task` 工具，spawn 一个子 Agent。
// 子 Agent 拥有**全新的 messages[]**（上下文隔离，不继承主对话历史），在自己的循环里
// 用工具完成任务，结束后**只把结论文本回传**给主 Agent（中间过程全部丢弃）。
// 子 Agent 的工具集**不含 task**（防递归 spawn）。
//
// 与本项目 Phase 17 `/agent` 编排器的区别（两者复用同一 runAgent 引擎）：
// - `/agent`：用户显式命令触发，走 Planner → 并发 Worker（隔离 worktree）→ Reviewer 全流程；
// - `task` 工具：主 Agent **自主**在循环内派发一个子 Agent，共享主 cwd（文件系统副作用
//   保留在主工作目录，对齐 s06「开一个新终端」的比喻），仅 messages[] 隔离。无 Planner/Reviewer。

import { runAgent } from '../agent/loop';
import type { ChatMessage, ChatModel, ToolDef } from '../chatmodel/types';
import { createToolRegistry, ToolRegistry } from '../tools/registry';
import type { PermissionManager } from '../security/permission';
import type { EventBus } from '../events/bus';
import { buildWorkerSystemPrompt } from './prompts';

/** 子 Agent 循环的安全轮次上限（对齐 s06 的 30 轮） */
const SUBAGENT_MAX_ITERATIONS = 30;

/** 主 Agent 工具依赖：task 工具的执行闭包需要这些去 spawn 子 Agent */
export interface SubagentDeps {
  model: ChatModel;
  permission: PermissionManager;
  bus?: EventBus;
  /** 主工作目录（子 Agent 共享，文件系统副作用保留于此 —— 对齐 s06） */
  cwd: string;
  /** 主工具注册表（含 task 本身）；spawn 时剔除 task 防递归 */
  tools: ToolRegistry;
}

/**
 * 把主注册表裁剪成「子 Agent 工具集」。
 * 默认剔除 task + task_run_parallel（防递归 spawn / 防递归扇出）；
 * stripAllTaskTools=true 时额外剔除整个 task* 家族（并行 worker 只干活、不碰看板）。
 */
export function buildSubagentTools(registry: ToolRegistry, stripAllTaskTools = false): ToolRegistry {
  const sub = createToolRegistry();
  for (const t of registry.list()) {
    if (t.name === 'task' || t.name === 'task_run_parallel') continue;
    if (stripAllTaskTools && t.name.startsWith('task')) continue;
    sub.register(t);
  }
  return sub;
}

/** 取最后一条 assistant 文本（子 Agent 只回传结论） */
function lastAssistantText(history: ChatMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role === 'assistant') {
      return typeof m.content === 'string'
        ? m.content
        : m.content
            .map((b) => (b.type === 'text' ? b.text : ''))
            .join('');
    }
  }
  return '';
}

/**
 * 派发一个子 Agent：在共享 cwd 里跑自己的 runAgent 循环（全新 messages[]），只回传结论。
 * @param description 派给子 Agent 的自包含子任务描述
 * @returns 子 Agent 的最终结论文本（空则回退提示）
 */
export async function spawnSubagent(
  opts: SubagentDeps & { description: string; stripAllTaskTools?: boolean },
): Promise<string> {
  const { description, model, permission, bus, cwd, tools, stripAllTaskTools } = opts;
  const desc = description.trim();
  if (!desc) return '(子任务描述为空，未派发子 Agent)';

  // 建构子 Agent 工具集：剔除 task / task_run_parallel 防递归；可选剔除整个 task* 家族
  const subTools = buildSubagentTools(tools, stripAllTaskTools);

  const history = await runAgent(
    [
      {
        role: 'system',
        content:
          buildWorkerSystemPrompt(desc, { id: 'sub', title: desc, description: '' }, cwd) +
          '\n\n重要：你是一个被派发的子 Agent，拥有独立的对话上下文（看不到父 Agent 的历史）。' +
          '请直接完成任务，不要再次委派、也不要尝试调用 task 工具（你并没有该工具）。',
      },
      { role: 'user', content: `请执行以下子任务：\n${desc}` },
    ],
    {
      model,
      tools: subTools,
      permission,
      bus,
      cwd,
      // s06 安全限制：子 Agent 循环轮次上限
      maxIterations: SUBAGENT_MAX_ITERATIONS,
      // 子 Agent 内部不做规划 nag（避免噪音）
      todoReminderEveryRounds: 0,
    },
  );

  return lastAssistantText(history);
}

/** 导出 task 工具定义，注册进主 Agent 工具集后即可在循环内自主派发子 Agent */
export function getSubagentTools(deps: SubagentDeps): ToolDef[] {
  return [
    {
      name: 'task',
      description:
        '派发一个子 Agent（subagent）去独立处理一个明确的子任务。子 Agent 拥有全新的上下文（不继承当前对话历史），' +
        '在自己的循环里用工具完成任务，只把「最终结论」回传给你（中间过程不回传，不污染主对话）。' +
        '适合：需要探索 / 调研 / 生成代码，但会拉长主对话上下文、或希望隔离噪音的子任务。' +
        '子 Agent 无法再派发子 Agent（递归受限）。请传入清晰、自包含的 description 描述要它做什么。' +
        '琐碎的单步操作无需派发子 Agent。',
      inputSchema: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: '派发给子 Agent 的子任务描述（清晰、自包含，让它拿到就能执行）',
          },
        },
        required: ['description'],
      },
      // 编排动作本身不改主目录（文件系统副作用由子 Agent 在其循环里各自经权限 gate）；
      // 标 isReadOnly=true 使主 Agent 在非交互 / Plan 模式下也能自主派发。
      isReadOnly: true,
      isDestructive: false,
      execute: async (args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> => {
        const description = typeof args.description === 'string' ? args.description.trim() : '';
        if (!description) return { ok: false, output: '缺少参数 description（子任务描述）' };
        const conclusion = await spawnSubagent({ ...deps, description });
        return { ok: true, output: conclusion || '(子 Agent 未返回结论)' };
      },
    },
  ];
}
