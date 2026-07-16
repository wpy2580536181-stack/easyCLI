// Phase 17：Multi-Agent 核心类型。
//
// 设计：复用 Phase 1 的 runAgent 引擎作为「子 Agent 运行时」，本模块只负责
// 「编排」——把高层任务拆解给 Planner，再并发派发给若干 Worker（各自隔离 worktree），
// 最后交给 Reviewer 汇总。所有子 Agent 都是同一个 runAgent 循环的不同「角色配置」。

import type { ChatMessage } from '../chatmodel/types';

/** 子 Agent 角色（含差异5 补全的 researcher/architect，用于事件总线与可观测层区分） */
export type AgentRole = 'planner' | 'worker' | 'reviewer' | 'researcher' | 'architect';

/** Worker 子任务的角色（researcher/architect 走只读 gate，worker 默认可写） */
export type WorkerRole = 'researcher' | 'architect' | 'worker';

/** 结构化产物：Worker 跑完后程序化提取 + 模型补充（重构：摆脱纯文本依赖） */
export interface WorkerArtifact {
  /** 程序化 diff 计算（git worktree 走 git diff；copy 兜底走目录比对），100% 可靠 */
  changedFiles: string[];
  /** 模型产出的最终结论文本（= 现有 output，向后兼容字段保留） */
  summary: string;
  /** researcher/architect 的关键发现/接口定义（可选，结构化传递） */
  findings?: string[];
}

/** Reviewer 结构化评审结论的种类 */
export type ReviewVerdictKind = 'pass' | 'needs-fix' | 'fail';

/** 单条修正指令：指向某个 WorkerResult，附自包含指令 */
export interface ReviewFix {
  /** 需要修正的子任务 id（指回某轮产出的 WorkerResult） */
  targetId: string;
  /** 给该 Worker 的修正指令（自包含、可独立执行） */
  instruction: string;
}

/** Reviewer 结构化评审结论（解析失败退化为纯文本结论） */
export interface ReviewVerdict {
  verdict: ReviewVerdictKind;
  fixes: ReviewFix[];
  summary: string;
}

/** 单轮执行快照（用于结果回执与可观测） */
export interface RoundSummary {
  round: number;
  plan: MultiAgentPlan;
  workers: WorkerResult[];
  verdict: ReviewVerdict | null;
  executionOrder: string[];
}

/** worktree 生命周期策略（默认 keep，向后兼容） */
export type WorktreeLifecycle = 'keep' | 'auto-cleanup-success' | 'auto-merge';

/** 一个被拆解出来的子任务 */
export interface Subtask {
  id: string;
  title: string;
  description: string;
  /** 该子任务派发的角色（默认 worker）；researcher/architect 会改用对应系统提示并启用只读 gate */
  role?: WorkerRole;
  /** 依赖的前置子任务 id 列表（差异5：依赖图）；满足后才调度执行 */
  dependsOn?: string[];
}

/** Planner 产出的结构化计划 */
export interface MultiAgentPlan {
  goal: string;
  subtasks: Subtask[];
}

/** 单个 Worker 的执行结果 */
export interface WorkerResult {
  subtask: Subtask;
  /** 该子 Agent 运行所在的隔离工作目录（worktree 实际路径） */
  cwd: string;
  /** 子 Agent 最终产出的文本 */
  output: string;
  /** 结构化产物（changedFiles 程序化计算 + 结论摘要），重构后必填 */
  artifact: WorkerArtifact;
  /** 来自第几轮（重规划时区分补充子任务） */
  round: number;
  /** 是否成功完成 */
  ok: boolean;
  /** 失败时的错误说明 */
  error?: string;
  /** 完整 history（含工具调用/结果），供审计与调试 */
  history: ChatMessage[];
}

/** 一次 Multi-Agent 运行的总结果 */
export interface MultiAgentResult {
  plan: MultiAgentPlan;
  workers: WorkerResult[];
  /** Reviewer 给出的评审结论 + 最终汇总 */
  review: string;
  /** 是否所有子任务都成功 */
  allOk: boolean;
  /** 实际拓扑执行顺序（差异5：依赖图调度后的子任务 id 序列；满足「依赖必先于下游」） */
  executionOrder: string[];
  /** 多轮回路快照（每轮计划/Worker/verdict）；单轮时长度为 1 */
  rounds: RoundSummary[];
  /** 最终裁定（解析失败退化为 'pass'）；多轮收敛后取末轮 */
  verdict: ReviewVerdictKind | null;
  /** 是否发生过 auto-merge */
  merged: boolean;
}
