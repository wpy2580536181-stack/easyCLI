// Phase 17：Multi-Agent 核心类型。
//
// 设计：复用 Phase 1 的 runAgent 引擎作为「子 Agent 运行时」，本模块只负责
// 「编排」——把高层任务拆解给 Planner，再并发派发给若干 Worker（各自隔离 worktree），
// 最后交给 Reviewer 汇总。所有子 Agent 都是同一个 runAgent 循环的不同「角色配置」。

import type { ChatMessage } from '../chatmodel/types';

/** 子 Agent 角色 */
export type AgentRole = 'planner' | 'worker' | 'reviewer';

/** 一个被拆解出来的子任务 */
export interface Subtask {
  id: string;
  title: string;
  description: string;
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
}
