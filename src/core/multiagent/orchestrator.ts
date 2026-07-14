// Phase 17：Multi-Agent 编排器（复用 runAgent 引擎）。
//
// 流程：Planner（纯推理，产出 JSON 计划，可声明每子任务的 role 与 dependsOn）
//      → Worker 扇出（依赖图拓扑调度，每个 Worker 在独立隔离 worktree 里跑 runAgent）
//      → Reviewer（纯推理，汇总各 Worker 结果给结论）
//
// 差异5（PaiCLI 对照 P2）：子任务支持 dependsOn 依赖图 + researcher/architect/worker 三角色，
// 调度由 src/core/multiagent/scheduler.ts 负责（环检测 + 拓扑就绪调度 + 前置结果注入）。
//
// 关键设计：
// - 子 Agent 不另写引擎，全部是 runAgent 的不同「角色配置」；
// - 隔离靠「每个 Worker 用各自 worktree 路径作为 cwd」实现（决策 11）；
// - 通过事件总线发射 agent:spawn/agent:done/agent:error，把子 Agent 运行态暴露给可观测层；
// - worktree 工厂可注入（测试用），默认走真实 git worktree / 目录拷贝。

import { runAgent } from '../agent/loop';
import type { ChatMessage, ChatModel } from '../chatmodel/types';
import type { ToolRegistry } from '../tools/registry';
import type { PermissionManager } from '../security/permission';
import type { EventBus } from '../events/bus';
import type { CompressOptions } from '../memory/compressor';
import { createWorktree, type Worktree } from './worktree';
import {
  buildPlannerSystemPrompt,
  buildWorkerSystemPrompt,
  buildReviewerSystemPrompt,
  resolveWorkerRole,
} from './prompts';
import { runScheduled } from './scheduler';
import type {
  AgentRole,
  MultiAgentPlan,
  MultiAgentResult,
  Subtask,
  WorkerResult,
} from './types';
import { z } from 'zod';

export interface MultiAgentHooks {
  onAgentSpawn?: (info: { role: AgentRole; id?: string; label: string }) => void;
  onAgentDone?: (info: { role: AgentRole; id?: string; label: string; ok: boolean }) => void;
  onText?: (role: AgentRole, id: string | undefined, chunk: string) => void;
}

export interface MultiAgentOptions {
  task: string;
  model: ChatModel;
  /** 工具注册表（内置 + MCP + 记忆 + RAG + Skill，与主线一致）；Worker 共享同一张表，靠 cwd 隔离 */
  tools: ToolRegistry;
  cwd: string;
  permission?: PermissionManager;
  bus?: EventBus;
  compress?: CompressOptions;
  signal?: AbortSignal;
  /** Worker 扇出并发上限（默认 3） */
  maxWorkers?: number;
  hooks?: MultiAgentHooks;
  /** 注入式 worktree 工厂（测试用），默认 createWorktree */
  worktreeFactory?: (baseCwd: string, id: string) => Promise<Worktree>;
  /** 调度/降级告警回调（如依赖成环降级、重复 id），REPL 用来打印一行提示 */
  onWarn?: (msg: string) => void;
}

/** 从 history 里取最后一条 assistant 文本（runAgent 回填后） */
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
 * 计划 JSON 的结构化 schema（差异3 / PaiCLI「zod 运行时校验」对齐项）。
 * LLM 返回的计划结构不可控，用 zod 做运行时校验而非裸 JSON.parse + 手工推断，
 * 畸形 JSON 会被 safeParse 捕获并走退化兜底，而不是静默成单子任务或崩。
 */
const SubtaskSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  role: z.enum(['researcher', 'architect', 'worker']).optional(),
  dependsOn: z.array(z.union([z.string(), z.number()])).optional(),
});
const PlanSchema = z.object({
  goal: z.string().optional(),
  subtasks: z.array(SubtaskSchema).optional(),
});

/** 从模型文本中解析出计划 JSON（兼容 ```json 围栏 或 裸 JSON） */
function parsePlan(text: string): MultiAgentPlan {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1]! : text.match(/\{[\s\S]*\}/)?.[0];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const result = PlanSchema.safeParse(parsed);
      if (result.success) {
        const data = result.data;
        const subtasks: Subtask[] = (data.subtasks ?? []).map((s, i) => ({
          id: String(s.id ?? `s${i + 1}`),
          title: String(s.title ?? ''),
          description: String(s.description ?? ''),
          role: s.role,
          dependsOn: (s.dependsOn ?? []).map(String),
        }));
        return { goal: String(data.goal ?? ''), subtasks };
      }
      // schema 不匹配（字段缺失/类型错）→ 仍按原逻辑退化，但已是结构化校验后的判定
    } catch {
      // 非 JSON（解析失败）→ 退化成单子任务
    }
  }
  return {
    goal: '',
    subtasks: [{ id: 's1', title: text.slice(0, 40), description: text }],
  };
}

function emitSpawn(bus: EventBus | undefined, hooks: MultiAgentHooks | undefined, role: AgentRole, label: string, id?: string) {
  bus?.emit({ type: 'agent:spawn', role, label, id });
  hooks?.onAgentSpawn?.({ role, label, id });
}
function emitDone(bus: EventBus | undefined, hooks: MultiAgentHooks | undefined, role: AgentRole, label: string, ok: boolean, id?: string) {
  bus?.emit({ type: 'agent:done', role, label, ok, id });
  hooks?.onAgentDone?.({ role, label, ok, id });
}
function emitError(bus: EventBus | undefined, role: AgentRole, label: string, error: string, id?: string) {
  bus?.emit({ type: 'agent:error', role, label, error, id });
}

/**
 * 运行一次 Multi-Agent 任务。
 * 返回计划、各 Worker 结果、评审结论。任何 Worker 失败都不阻断整体（其余继续、Reviewer 照常汇总）。
 */
export async function runMultiAgent(opts: MultiAgentOptions): Promise<MultiAgentResult> {
  const {
    task,
    model,
    tools,
    cwd,
    permission,
    bus,
    compress,
    signal,
    maxWorkers = 3,
    hooks,
    worktreeFactory = createWorktree,
    onWarn,
  } = opts;

  // ── 1) Planner：纯推理产出结构化计划 ──
  emitSpawn(bus, hooks, 'planner', 'Planner');
  let plan: MultiAgentPlan;
  try {
    const pres = await model.complete({
      messages: [
        { role: 'system', content: buildPlannerSystemPrompt() },
        { role: 'user', content: task },
      ],
      signal,
      onText: (c) => hooks?.onText?.('planner', undefined, c),
    });
    plan = parsePlan(pres.content ?? '');
    emitDone(bus, hooks, 'planner', 'Planner', true);
  } catch (e) {
    emitError(bus, 'planner', 'Planner', (e as Error).message);
    emitDone(bus, hooks, 'planner', 'Planner', false);
    return {
      plan: { goal: task, subtasks: [] },
      workers: [],
      review: `Planner 失败：${(e as Error).message}`,
      allOk: false,
      executionOrder: [],
    };
  }

  // ── 2) Worker 扇出：按依赖图拓扑调度，每个子任务在独立 worktree 里跑 runAgent ──
  const scheduled = await runScheduled(
    plan.subtasks,
    async (subtask, predecessors) => {
      const role = subtask.role ?? 'worker';
      const roleCfg = resolveWorkerRole(role);
      const label = `${roleCfg.label}[${subtask.id}]`;
      emitSpawn(bus, hooks, role, label, subtask.id);
      let wt: Worktree;
      try {
        wt = await worktreeFactory(cwd, subtask.id);
      } catch (e) {
        emitError(bus, role, label, (e as Error).message, subtask.id);
        emitDone(bus, hooks, role, label, false, subtask.id);
        return {
          subtask,
          cwd: cwd,
          output: '',
          ok: false,
          error: `创建隔离工作目录失败：${(e as Error).message}`,
          history: [],
        };
      }

      // 前置结果注入：依赖的子任务产出以文本形式喂给当前 Worker（worktree 隔离下的依赖传递）
      const depContext = predecessors.length
        ? '\n\n## 你依赖的前置子任务产出（已在其它隔离工作目录完成）：\n' +
          predecessors.map((p) => `- [${p.subtask.id}] ${p.subtask.title}：${p.output}`).join('\n')
        : '';
      try {
        const history = await runAgent(
          [
            { role: 'system', content: roleCfg.build(task, subtask, wt.path) + depContext },
            { role: 'user', content: `请执行子任务 [${subtask.id}] ${subtask.title}。${subtask.description}` },
          ],
          {
            model,
            tools,
            permission,
            bus,
            compress,
            cwd: wt.path,
            signal,
            planMode: roleCfg.planMode,
            onText: (c) => hooks?.onText?.(role, subtask.id, c),
          },
        );
        const output = lastAssistantText(history);
        emitDone(bus, hooks, role, label, true, subtask.id);
        return { subtask, cwd: wt.path, output, ok: true, history };
      } catch (e) {
        emitError(bus, role, label, (e as Error).message, subtask.id);
        emitDone(bus, hooks, role, label, false, subtask.id);
        return {
          subtask,
          cwd: wt.path,
          output: '',
          ok: false,
          error: (e as Error).message,
          history: [],
        };
      }
      // 注意：此处不自动 cleanup worktree——Worker 的改动需保留供用户 review / 合并
      // （Reviewer 也会提示用户逐一合并）。worktree 句柄的 cleanup 由调用方按需调用。
    },
    { maxWorkers, onWarn },
  );
  const workers = scheduled.workers;

  // ── 3) Reviewer：汇总各 Worker 结果给结论 ──
  emitSpawn(bus, hooks, 'reviewer', 'Reviewer');
  let review: string;
  try {
    const reports = workers
      .map(
        (w) =>
          `### [${w.subtask.id}] ${w.subtask.title}\n` +
          `工作目录：${w.cwd}\n` +
          `状态：${w.ok ? '成功' : '失败'}${w.error ? `（${w.error}）` : ''}\n` +
          `${w.output}`,
      )
      .join('\n\n');
    const rres = await model.complete({
      messages: [
        { role: 'system', content: buildReviewerSystemPrompt(task) },
        {
          role: 'user',
          content: `各子任务执行结果如下：\n\n${reports}\n\n请给出评审结论与最终汇总。`,
        },
      ],
      signal,
      onText: (c) => hooks?.onText?.('reviewer', undefined, c),
    });
    review = rres.content ?? '';
    emitDone(bus, hooks, 'reviewer', 'Reviewer', true);
  } catch (e) {
    emitError(bus, 'reviewer', 'Reviewer', (e as Error).message);
    emitDone(bus, hooks, 'reviewer', 'Reviewer', false);
    review = `Reviewer 失败：${(e as Error).message}`;
  }

  return {
    plan,
    workers,
    review,
    allOk: workers.length > 0 && workers.every((w) => w.ok),
    executionOrder: scheduled.executionOrder,
  };
}
