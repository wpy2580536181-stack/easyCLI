// 差异6（PaiCLI 对照 P2）：独立的 Plan-and-Execute 单 Agent 流程。
//
// 与 Phase 15 的「Plan 模式（一次性计划文本 + 只读 gate）」和 Phase 21 的「todo_write
// 清单」正交：本模块提供端到端的「产出有序步骤 → 逐步执行 → 结果喂回下一步 → 综合结论」
// 单 Agent 流程，适用于「需要深度、按顺序、前一步产物驱动后一步」的复杂任务。
//
// 复用 Phase 1 的 runAgent 作每步执行引擎（不另写循环），复用 TodoStore 同步进度。
// 关键不变式：每一步系统提示里注入「之前所有步骤的产出」，使模型能基于前序结果继续，
// 而非每步从零开始、易发散。

import { runAgent } from './loop';
import type { ChatMessage, ChatModel } from '../chatmodel/types';
import type { ToolRegistry } from '../tools/registry';
import type { PermissionManager } from '../security/permission';
import type { EventBus } from '../events/bus';
import type { CompressOptions } from '../memory/compressor';
import { TodoStore } from '../tools/planning';
import { z } from 'zod';

const StepSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  description: z.string().optional(),
  verification: z.string().optional(),
});
const SequentialPlanSchema = z.object({
  goal: z.string().optional(),
  steps: z.array(StepSchema).optional(),
});

export interface PlanStep {
  id: string;
  description: string;
  verification?: string;
}

export interface SequentialPlan {
  goal: string;
  steps: PlanStep[];
}

export interface StepResult {
  id: string;
  description: string;
  output: string;
  ok: boolean;
  error?: string;
}

export interface PlanExecuteHooks {
  onStepStart?: (step: PlanStep, index: number, total: number) => void;
  onStepDone?: (result: StepResult, index: number, total: number) => void;
  onText?: (chunk: string) => void;
}

export interface PlanExecuteOptions {
  task: string;
  model: ChatModel;
  tools: ToolRegistry;
  cwd: string;
  permission?: PermissionManager;
  bus?: EventBus;
  compress?: CompressOptions;
  signal?: AbortSignal;
  /** 每步 runAgent 的最大轮次（默认沿用 runAgent 的 10） */
  maxIterations?: number;
  /** 是否执行 Synthesis 阶段（默认 true） */
  synthesize?: boolean;
  hooks?: PlanExecuteHooks;
  /** 注入式任务表（默认新建），用于把进度同步到 REPL /todos */
  todoStore?: TodoStore;
}

export interface PlanExecuteResult {
  plan: SequentialPlan;
  steps: StepResult[];
  /** Synthesis 阶段给的最终结论（synthesize=false 时为空串） */
  synthesis: string;
  allOk: boolean;
}

const PLAN_SYSTEM_PROMPT =
  '你是一个任务规划专家。请把用户的高层任务拆解成一组**有序、可逐步执行**的步骤。\n' +
  '只输出一个 JSON 代码块，结构如下：\n' +
  '```json\n' +
  '{\n' +
  '  "goal": "一句话概括总目标",\n' +
  '  "steps": [\n' +
  '    { "id": "step1", "description": "这一步要做什么", "verification": "如何验证这一步完成（可选）" }\n' +
  '  ]\n' +
  '}\n' +
  '```\n' +
  '要求：steps 必须**按执行顺序排列**（后一步可能依赖前一步的产出）；每个 description 足够清晰，让执行者能直接动手；' +
  '不要输出 JSON 以外的解释文字。';

const STEP_SYSTEM_PROMPT =
  '你是一个执行工程师，正在按顺序完成一个复杂任务。请专注于当前这一步，' +
  '直接用工具（read_file / write_file / edit_file / list_dir / glob / grep / bash 等）落地它，' +
  '完成后用简洁中文说明「你做了什么、产出了什么」。';

const SYNTH_SYSTEM_PROMPT =
  '你是一个总结专家。下面是一组按顺序执行的步骤各自的产出，请综合给出**最终结论**：' +
  '任务是否达成、关键成果是什么、下一步建议。用中文、要点清晰。';

/** 从模型文本解析有序计划（兼容 ```json 围栏 或 裸 JSON）；畸形则退化成单步 */
function parsePlan(text: string): SequentialPlan {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1]! : text.match(/\{[\s\S]*\}/)?.[0];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const result = SequentialPlanSchema.safeParse(parsed);
      if (result.success) {
        const data = result.data;
        const steps: PlanStep[] = (data.steps ?? []).map((s, i) => ({
          id: String(s.id ?? `step${i + 1}`),
          description: String(s.description ?? ''),
          verification: s.verification ? String(s.verification) : undefined,
        }));
        if (steps.length > 0) return { goal: String(data.goal ?? ''), steps };
      }
    } catch {
      // 解析失败 → 退化单步
    }
  }
  return { goal: '', steps: [{ id: 'step1', description: text }] };
}

/** 取 history 里最后一条 assistant 文本 */
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
 * 运行一次 Plan-and-Execute：Plan 阶段产出有序步骤 → Execute 阶段逐步执行（前序结果喂回）
 * → 可选 Synthesis 阶段综合结论。任何步骤失败都不阻断后续（失败步 ok=false 继续）。
 */
export async function runPlanAndExecute(opts: PlanExecuteOptions): Promise<PlanExecuteResult> {
  const {
    task,
    model,
    tools,
    cwd,
    permission,
    bus,
    compress,
    signal,
    maxIterations,
    synthesize = true,
    hooks,
    todoStore,
  } = opts;

  // ── 1) Plan 阶段：产出有序步骤 ──
  const planRes = await model.complete({
    messages: [
      { role: 'system', content: PLAN_SYSTEM_PROMPT },
      { role: 'user', content: task },
    ],
    signal,
    onText: hooks?.onText,
  });
  const plan = parsePlan(planRes.content ?? '');

  // 同步到 TodoStore：首步 in_progress，其余 pending
  if (todoStore) {
    todoStore.set(
      plan.steps.map((s, i) => ({
        content: s.description,
        status: i === 0 ? 'in_progress' : 'pending',
        activeForm: `执行：${s.description}`,
      })),
    );
  }

  // ── 2) Execute 阶段：逐步执行，前序产出喂回 ──
  const results: StepResult[] = [];
  const priorOutputs: string[] = [];
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;
    hooks?.onStepStart?.(step, i, plan.steps.length);

    // 进度：当前步 in_progress
    if (todoStore) {
      const items = todoStore.list();
      todoStore.set(items.map((it, idx) => (idx === i ? { ...it, status: 'in_progress' } : it)));
    }

    // 前置结果注入（worktree 隔离下的「结果喂回」）
    const depContext = priorOutputs.length
      ? '\n\n## 之前步骤的产出（按顺序，供你参考与衔接）：\n' +
        priorOutputs.map((o, k) => `### 步骤 ${k + 1} 产出\n${o}`).join('\n')
      : '';

    let output = '';
    let ok = true;
    let error: string | undefined;
    try {
      const history = await runAgent(
        [
          { role: 'system', content: STEP_SYSTEM_PROMPT + depContext },
          {
            role: 'user',
            content:
              `当前步骤（${i + 1}/${plan.steps.length}）：${step.description}` +
              (step.verification ? `\n验收标准：${step.verification}` : ''),
          },
        ],
        {
          model,
          tools,
          permission,
          bus,
          compress,
          cwd,
          signal,
          maxIterations,
          onText: hooks?.onText,
        },
      );
      output = lastAssistantText(history);
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
    }

    const stepResult: StepResult = { id: step.id, description: step.description, output, ok, error };
    results.push(stepResult);
    priorOutputs.push(output);
    hooks?.onStepDone?.(stepResult, i, plan.steps.length);

    // 进度：当前步 completed
    if (todoStore) {
      const items = todoStore.list();
      todoStore.set(items.map((it, idx) => (idx === i ? { ...it, status: 'completed' } : it)));
    }
  }

  // ── 3) Synthesis 阶段：综合各步产出给结论 ──
  let synthesis = '';
  if (synthesize) {
    const stepReports = results
      .map((r, k) => `### 步骤 ${k + 1}（${r.description}）\n${r.output}`)
      .join('\n\n');
    const sres = await model.complete({
      messages: [
        { role: 'system', content: SYNTH_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `总任务：${task}\n\n各步骤产出：\n\n${stepReports}\n\n请给出最终结论。`,
        },
      ],
      signal,
      onText: hooks?.onText,
    });
    synthesis = sres.content ?? '';
  }

  return {
    plan,
    steps: results,
    synthesis,
    allOk: results.length > 0 && results.every((r) => r.ok),
  };
}
