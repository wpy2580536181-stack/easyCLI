// Phase 17：Multi-Agent 模块统一导出
export { runMultiAgent, type MultiAgentOptions, type MultiAgentHooks } from './orchestrator';
export { runScheduled, type SchedulerDeps, type SchedulerResult } from './scheduler';
export { createWorktree, type Worktree } from './worktree';
export {
  computeChangedFiles,
  parseReviewVerdict,
  buildSupplementSubtasks,
  mergeWorktree,
} from './artifact';
export {
  buildPlannerSystemPrompt,
  buildWorkerSystemPrompt,
  buildReviewerSystemPrompt,
  buildPlannerReplanPrompt,
  buildResearcherSystemPrompt,
  buildArchitectSystemPrompt,
  resolveWorkerRole,
  type WorkerRoleConfig,
} from './prompts';
export type {
  AgentRole,
  WorkerRole,
  Subtask,
  MultiAgentPlan,
  WorkerResult,
  WorkerArtifact,
  ReviewVerdict,
  ReviewVerdictKind,
  ReviewFix,
  RoundSummary,
  WorktreeLifecycle,
  MultiAgentResult,
} from './types';
