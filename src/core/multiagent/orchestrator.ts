// Phase 17：Multi-Agent 编排器（复用 runAgent 引擎）。
//
// 流程（重构后，支持多轮纠偏回路）：
//   首轮 Planner（纯推理 → JSON 计划）
//     → Worker 扇出（依赖图拓扑调度，每个 Worker 在独立隔离 worktree 跑 runAgent）
//     → Reviewer（结构化 verdict）
//     → verdict=needs-fix 且未达 maxReplan → 重规划（补充子任务）→ 再来一轮
//   收敛：verdict=pass / fail，或 round>=maxReplan → 退出。
//   finally：按 worktreeLifecycle 统一处理隔离工作目录（keep / cleanup / merge）。
//
// 关键设计：
// - 子 Agent 不另写引擎，全部是 runAgent 的不同「角色配置」；
// - 隔离靠「每个 Worker 用各自 worktree 路径作为 cwd」实现（决策 11）；
// - Worker 间依赖传递用「程序化 diff 出的 changedFiles + 结论」结构化注入（摆脱纯文本截断）；
// - 通过事件总线发射 agent:spawn/agent:done/agent:error，把子 Agent 运行态暴露给可观测层；
// - worktree 工厂可注入（测试用），默认走真实 git worktree / 目录拷贝；
// - 默认 maxReplan=0、worktreeLifecycle='keep' → 行为等同改造前的单次流水线（向后兼容）。

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
  buildPlannerReplanPrompt,
  resolveWorkerRole,
} from './prompts';
import { runScheduled } from './scheduler';
import {
  computeChangedFiles,
  parseReviewVerdict,
  buildSupplementSubtasks,
  mergeWorktree,
} from './artifact';
import type {
  AgentRole,
  MultiAgentPlan,
  MultiAgentResult,
  Subtask,
  WorkerResult,
  WorkerArtifact,
  ReviewVerdict,
  ReviewVerdictKind,
  RoundSummary,
  WorktreeLifecycle,
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
  /** 多轮纠偏回路上限（默认 0 = 关闭，行为等同改造前单次流水线） */
  maxReplan?: number;
  /** worktree 生命周期策略（默认 'keep'，向后兼容：不自动清理） */
  worktreeLifecycle?: WorktreeLifecycle;
  /** 可注入的子 Agent 运行器（测试用，默认 runAgent） */
  agentRunner?: typeof runAgent;
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

/** 构造空 artifact（Worker 创建失败等异常路径用） */
function emptyArtifact(): WorkerArtifact {
  return { changedFiles: [], summary: '', findings: undefined };
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
 * 运行一次 Multi-Agent 任务（支持多轮纠偏 + 结构化产物 + worktree 生命周期）。
 * 返回计划、各轮 Worker 结果、评审结论与每轮快照。任何 Worker 失败都不阻断整体。
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
    maxReplan = 0,
    worktreeLifecycle = 'keep',
    agentRunner,
  } = opts;

  const runAgentImpl = agentRunner ?? runAgent;
  const lifecycle = worktreeLifecycle;

  // 跨轮累积状态
  const createdWorktrees: Worktree[] = [];
  const worktreeResults: { wt: Worktree; ok: boolean; path: string }[] = [];
  const allWorkers: WorkerResult[] = [];
  const executionOrder: string[] = [];
  const rounds: RoundSummary[] = [];
  let finalReview = '';
  let lastVerdict: ReviewVerdictKind | null = null;
  let merged = false;
  let result: MultiAgentResult | null = null;

  /** 调一次 Planner（首轮或重规划），返回结构化计划 */
  async function runPlanner(systemPrompt: string, userContent: string): Promise<MultiAgentPlan> {
    const pres = await model.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      signal,
      onText: (c) => hooks?.onText?.('planner', undefined, c),
    });
    return parsePlan(pres.content ?? '');
  }

  /** 构造某轮的 Worker 闭包（捕获 round，以便注入跨轮依赖与标记产物归属） */
  const makeWorker =
    (round: number) =>
    async (subtask: Subtask, predecessors: WorkerResult[]): Promise<WorkerResult> => {
      const role = (subtask.role ?? 'worker') as AgentRole;
      const roleCfg = resolveWorkerRole(subtask.role);
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
          artifact: emptyArtifact(),
          round,
          ok: false,
          error: `创建隔离工作目录失败：${(e as Error).message}`,
          history: [],
        };
      }
      createdWorktrees.push(wt);

      // 依赖产出注入：同轮 predecessors + 跨轮已完成的同 id 依赖
      // （按 changedFiles 精确传递，摆脱纯文本截断/摘要损失）
      const priorById = new Map(allWorkers.map((w) => [w.subtask.id, w]));
      const depSources = [
        ...predecessors,
        ...(subtask.dependsOn ?? []).map((id) => priorById.get(id)).filter((w): w is WorkerResult => !!w),
      ].filter((w, i, arr) => arr.findIndex((x) => x.subtask.id === w.subtask.id) === i);
      const depContext = depSources.length
        ? '\n\n## 你依赖的前置子任务产出（已在其它隔离工作目录完成）：\n' +
          depSources
            .map(
              (p) =>
                `- [${p.subtask.id}] ${p.subtask.title}\n  改动文件：${p.artifact.changedFiles.join(', ') || '(无)'}\n  ${p.artifact.summary ?? p.output}`,
            )
            .join('\n')
        : '';

      let output = '';
      let ok = false;
      let history: ChatMessage[] = [];
      let error: string | undefined;
      try {
        history = await runAgentImpl(
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
        output = lastAssistantText(history);
        ok = true;
        emitDone(bus, hooks, role, label, true, subtask.id);
      } catch (e) {
        emitError(bus, role, label, (e as Error).message, subtask.id);
        emitDone(bus, hooks, role, label, false, subtask.id);
        error = (e as Error).message;
      }
      const changedFiles = await computeChangedFiles(wt, cwd).catch(() => [] as string[]);
      const artifact: WorkerArtifact = { changedFiles, summary: output };
      worktreeResults.push({ wt, ok, path: wt.path });
      return { subtask, cwd: wt.path, output, artifact, round, ok, error, history };
    };

  try {
    // ── 1) Planner：纯推理产出结构化计划（首轮） ──
    emitSpawn(bus, hooks, 'planner', 'Planner');
    let plan: MultiAgentPlan;
    try {
      plan = await runPlanner(buildPlannerSystemPrompt(), task);
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
        rounds: [],
        verdict: null,
        merged: false,
      };
    }
    const initialPlan = plan;

    // ── 多轮主循环：Planner/重规划 → Workers → Reviewer → (needs-fix ? 重规划 : 收敛) ──
    for (let round = 0; round <= maxReplan; round++) {
      // ② Workers（拓扑调度；首轮用 plan，重规划轮用补充子任务 plan）
      const scheduled = await runScheduled(plan.subtasks, makeWorker(round), { maxWorkers, onWarn });
      allWorkers.push(...scheduled.workers);
      executionOrder.push(...scheduled.executionOrder);

      // ③ Reviewer（结构化 verdict）
      emitSpawn(bus, hooks, 'reviewer', 'Reviewer');
      let reviewText = '';
      try {
        const reports = scheduled.workers
          .map(
            (w) =>
              `### [${w.subtask.id}] ${w.subtask.title}\n` +
              `工作目录：${w.cwd}\n` +
              `状态：${w.ok ? '成功' : '失败'}${w.error ? `（${w.error}）` : ''}\n` +
              `改动文件：${w.artifact.changedFiles.join(', ') || '(无)'}\n` +
              `${w.output}`,
          )
          .join('\n\n');
        const rres = await model.complete({
          messages: [
            { role: 'system', content: buildReviewerSystemPrompt(task) },
            {
              role: 'user',
              content: `各子任务执行结果如下：\n\n${reports}\n\n请给出评审结论与最终汇总（优先 JSON）。`,
            },
          ],
          signal,
          onText: (c) => hooks?.onText?.('reviewer', undefined, c),
        });
        reviewText = rres.content ?? '';
        emitDone(bus, hooks, 'reviewer', 'Reviewer', true);
      } catch (e) {
        emitError(bus, 'reviewer', 'Reviewer', (e as Error).message);
        emitDone(bus, hooks, 'reviewer', 'Reviewer', false);
        reviewText = `Reviewer 失败：${(e as Error).message}`;
      }

      // 解析 verdict；解析失败 → 退化为 pass + 原文本 summary（向后兼容当前纯文本行为）
      const verdict: ReviewVerdict =
        parseReviewVerdict(reviewText) ?? { verdict: 'pass', fixes: [], summary: reviewText };
      rounds.push({ round, plan, workers: scheduled.workers, verdict, executionOrder: scheduled.executionOrder });

      finalReview = reviewText;
      // 收敛条件：通过 / 硬失败 / 已达重规划上限
      if (verdict.verdict === 'pass' || verdict.verdict === 'fail' || round === maxReplan) {
        lastVerdict = verdict.verdict;
        break;
      }

      // needs-fix → 收集 fixes，重规划下一轮
      emitSpawn(bus, hooks, 'planner', 'Planner(重规划)');
      try {
        const fixReports = verdict.fixes
          .map((f) => {
            const w = allWorkers.find((x) => x.subtask.id === f.targetId);
            return `- 目标 [${f.targetId}] ${w?.subtask.title ?? ''}：${f.instruction}\n  原产出：${w?.output ?? '(无)'}`;
          })
          .join('\n');
        plan = await runPlanner(
          buildPlannerReplanPrompt(),
          `总任务：${task}\n\n上一轮待修正项：\n${fixReports}\n\n请产出补充子任务（JSON 计划），其 dependsOn 指回对应目标。`,
        );
        emitDone(bus, hooks, 'planner', 'Planner(重规划)', true);
      } catch (e) {
        emitError(bus, 'planner', 'Planner(重规划)', (e as Error).message);
        emitDone(bus, hooks, 'planner', 'Planner(重规划)', false);
        // 重规划模型失败 → 用 fixes 兜底生成补充子任务（仍走 DAG 调度）
        plan = { goal: '修正上一轮未通过项', subtasks: buildSupplementSubtasks(verdict.fixes, allWorkers, round + 1) };
      }
    }

    result = {
      plan: initialPlan,
      workers: allWorkers,
      review: finalReview,
      allOk: allWorkers.length > 0 && allWorkers.every((w) => w.ok),
      executionOrder,
      rounds,
      verdict: lastVerdict,
      merged: false,
    };
  } finally {
    // worktree 生命周期：统一在 finally 处理，确保异常路径也不泄漏
    for (const wr of worktreeResults) {
      if (lifecycle === 'keep') continue; // 默认：不清理
      if (!wr.ok) continue; // 失败一律保留供 review
      if (lifecycle === 'auto-merge') {
        try {
          await mergeWorktree(wr.wt, cwd);
          merged = true;
          wr.wt.cleanup();
        } catch {
          // 合并冲突/失败 → 转 keep + 告警，绝不丢改动
          onWarn?.(`合并冲突或失败，已保留 worktree：${wr.path}`);
        }
      } else {
        // auto-cleanup-success
        wr.wt.cleanup();
      }
    }
    if (result) result.merged = merged;
  }

  return result!;
}
