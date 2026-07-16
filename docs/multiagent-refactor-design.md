# Multi-Agent 体系重构设计文档

> 目标：在**不重写 `runAgent` 引擎、不破坏现有 4 种编排形态**的前提下，补齐当前体系的 4 个核心短板：
> ① 动态重规划（replanning）　② Reviewer→Worker 纠偏回路（feedback loop）
> ③ 结构化产物消息（摆脱纯文本依赖）　④ worktree 生命周期自动管理。
>
> 设计原则：**最小改动、向后兼容、靠角色配置差异表达行为**（与现有"单引擎 + 角色即配置"架构一致）。

---

## 0. 背景与现状

当前 `runMultiAgent`（`src/core/multiagent/orchestrator.ts`）是一次性流水线：

```
Planner(纯推理 → JSON 计划) → Worker 扇出(runScheduled 拓扑调度) → Reviewer(纯推理 → 文本结论)
```

已确认的现状短板（来自架构分析）：

1. **Worker 间无法真正协作** — 隔离 worktree，依赖仅以"文本注入"传递，大产出会摘要损失；合并未自动化，需人工 review。
2. **静态计划、不能重规划** — Planner 只在开头跑一次，执行中失败/新事实无法触发 replanning。
3. **Reviewer 无纠偏回路** — 只给结论，发现问题也无法把任务打回 Worker 修正。
4. **通信带宽窄** — 全靠 `lastAssistantText()` 取"最后一条 assistant 文本"，结构化产物（改动文件、diff、指标）无处传递。
5. **worktree 生命周期靠调用方** — orchestrator 故意不 cleanup（留待 review），临时目录/git worktree 会堆积。
6. **并发无全局 token/rate 协调**（本方案不解决，列为已知遗留）。

关键代码落点（已逐文件核对）：

| 关注点 | 文件 | 现状 |
|--------|------|------|
| 主流程 | `orchestrator.ts` `runMultiAgent` | 一次性三阶段，无回路；`wt` 句柄是闭包局部变量，外部拿不到 |
| 调度 | `scheduler.ts` `runScheduled` | 静态 DAG + Kahn 环检测 + 就绪调度；支持 `predecessors` 注入，天然可承接"补充子任务" |
| 角色提示 | `prompts.ts` | Planner/Worker/Reviewer 手写提示，Reviewer 仅要纯文本结论 |
| 类型 | `types.ts` | `WorkerResult.output: string`；无 artifact / verdict 概念 |
| 隔离 | `worktree.ts` `Worktree.cleanup()` | 已实现 cleanup，但 orchestrator 不调用 |
| 副产物提取 | — | 无；`changedFiles` 必须程序化计算 |

---

## 1. 改造后整体控制流

```
                 ┌─────────────────────────────────────────────┐
                 │  多轮循环 (round = 0 .. maxReplan)            │
                 ▼                                               │
   task → ① Planner(拆解/重规划) → ② Workers(拓扑并发 DAG)        │
                       ↑                    │                    │
                       │                    ▼                    │
                       │            ③ Reviewer(结构化 verdict)   │
                       │                    │                    │
                       │            ┌───────┴───────┐            │
                       │       pass/达上限?         needs-fix    │
                       │            │                │           │
                       │            │         收集 fixes→重规划   │
                       │            ▼                └───────────┘
                       │        输出最终结论                      
                       └──────────────┘                         
                                    │
                             finally：worktree 生命周期
                      (成功→cleanup/merge · 失败→保留)
```

- 首轮 Planner 用原始 `task`；重规划轮用"上一轮失败项 + Reviewer 的 fix 指令"喂回 Planner，产出**补充子任务**（其 `dependsOn` 指回原任务，复用现有 DAG 调度）。
- 收敛条件：`verdict==='pass'` **或** `round >= maxReplan`（默认 1，硬上限，绝不死循环）。

---

## 2. 类型设计（`src/core/multiagent/types.ts` 草案）

```ts
/** 结构化产物：Worker 跑完后程序化提取 + 模型补充 */
export interface WorkerArtifact {
  /** 程序化 diff 计算（git worktree 走 git diff；copy 兜底走目录比对），100% 可靠 */
  changedFiles: string[];
  /** 模型产出的最终结论文本（= 现有 output，向后兼容字段保留） */
  summary: string;
  /** researcher/architect 的关键发现/接口定义（可选，结构化传递） */
  findings?: string[];
}

/** Reviewer 结构化评审结论（zod 校验；解析失败退化为纯文本结论） */
export type ReviewVerdictKind = 'pass' | 'needs-fix' | 'fail';
export interface ReviewFix {
  /** 需要修正的子任务 id（指回某轮产出的 WorkerResult） */
  targetId: string;
  /** 给该 Worker 的修正指令（自包含、可独立执行） */
  instruction: string;
}
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
  verdict: ReviewVerdict | null; // 解析失败为 null
  executionOrder: string[];
}

/** worktree 生命周期策略 */
export type WorktreeLifecycle = 'keep' | 'auto-cleanup-success' | 'auto-merge';

/** 扩展 WorkerResult：保留 output 向后兼容，新增 artifact */
export interface WorkerResult {
  subtask: Subtask;
  cwd: string;
  output: string;          // 保留：= artifact.summary
  artifact: WorkerArtifact; // 新增
  ok: boolean;
  error?: string;
  history: ChatMessage[];
  /** 来自第几轮（重规划时区分补充子任务） */
  round: number;
}

/** 扩展 MultiAgentResult */
export interface MultiAgentResult {
  plan: MultiAgentPlan;
  workers: WorkerResult[];
  review: string;          // 保留：最终 Reviewer 文本（或末轮 summary）
  allOk: boolean;
  executionOrder: string[];
  rounds: RoundSummary[];  // 新增：每轮快照
  verdict: ReviewVerdictKind | null; // 新增：最终裁定
  merged: boolean;         // 新增：是否发生过 auto-merge
}
```

---

## 3. 模块 A：结构化产物消息（基础能力）

**新增文件 `src/core/multiagent/artifact.ts`**：

```ts
import type { Worktree } from './worktree';

/**
 * 程序化计算某 Worker 相对基线的改动文件清单。
 * - git worktree：git diff --name-only（对比创建时的 HEAD，最可靠）
 * - copy 兜底：递归比对 baseCwd 与 wt.path 的文件集合差异
 */
export async function computeChangedFiles(wt: Worktree, baseCwd: string): Promise<string[]> {
  if (wt.kind === 'git') {
    try {
      const out = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: wt.path, encoding: 'utf8' });
      return out.split('\n').map(s => s.trim()).filter(Boolean);
    } catch { /* 落到目录比对 */ }
  }
  return diffDirs(baseCwd, wt.path); // 递归比对实现略
}
```

**`orchestrator.ts` 改造**：Worker 闭包里跑完 `runAgent` 后，调用 `computeChangedFiles` 构造 `artifact`；`depContext` 注入时把上游 `changedFiles` 一并带入：

```ts
const depContext = predecessors.length
  ? '\n\n## 你依赖的前置子任务的产出与改动文件：\n' +
    predecessors.map(p =>
      `- [${p.subtask.id}] ${p.subtask.title}\n  改动文件：${p.artifact.changedFiles.join(', ') || '(无)'}\n  ${p.artifact.summary}`
    ).join('\n')
  : '';
```

**`prompts.ts` Worker/Researcher/Architect 提示**：增加一句"完成后请明确列出你改动/新建的文件路径，便于下游衔接"。

> 收益：下游 Worker 拿到的是**精确文件清单 + 结论**，不再因 `lastAssistantText` 截断/摘要而丢信息。

---

## 4. 模块 B+C：Reviewer verdict + 纠偏回路 + 动态重规划

### 4.1 Reviewer 改为结构化输出（`prompts.ts`）

`buildReviewerSystemPrompt` 改写：要求输出可解析 JSON（沿用现有 `PlanSchema` 风格 + zod 兜底）：

```
请只输出一个 JSON 代码块：
{
  "verdict": "pass" | "needs-fix" | "fail",
  "fixes": [ { "targetId": "s2", "instruction": "修复 X 处的空指针，并补充单测" } ],
  "summary": "总体结论..."
}
- verdict=pass：无需修正；needs-fix：有可修正项（填 fixes）；fail：存在不可自动修复的硬失败。
- 仅当 needs-fix 时才填 fixes；targetId 必须是上面出现过的子任务 id。
```

### 4.2 解析（`artifact.ts` 或 `orchestrator.ts` 内）

```ts
const ReviewVerdictSchema = z.object({
  verdict: z.enum(['pass', 'needs-fix', 'fail']).optional(),
  fixes: z.array(z.object({ targetId: z.union([z.string(), z.number()]), instruction: z.string() })).optional(),
  summary: z.string().optional(),
});
function parseReviewVerdict(text: string): ReviewVerdict | null {
  // 兼容 ```json 围栏/裸 JSON；safeParse 失败返回 null（→ 退化纯文本结论，向后兼容）
}
```

### 4.3 多轮主循环（`orchestrator.ts` `runMultiAgent` 重构）

伪代码（结构，非逐行）：

```ts
const rounds: RoundSummary[] = [];
let plan = initialPlan; // 首轮由 Planner 产出
let allWorkers: WorkerResult[] = [];
let lastVerdict: ReviewVerdictKind | null = null;

for (let round = 0; round <= maxReplan; round++) {
  // ② Workers（拓扑调度；首轮用 plan，重规划轮用补充子任务 plan）
  const scheduled = await runScheduled(plan.subtasks, workerClosure, { maxWorkers, onWarn });
  allWorkers.push(...scheduled.workers);

  // ③ Reviewer（结构化）
  const verdict = parseReviewVerdict(reviewerText) ?? { verdict: 'pass', fixes: [], summary: reviewerText };
  rounds.push({ round, plan, workers: scheduled.workers, verdict, executionOrder: scheduled.executionOrder });

  if (verdict.verdict === 'pass' || round === maxReplan) {
    lastVerdict = verdict.verdict;
    break;
  }
  // needs-fix → 收集 fixes，重规划下一轮
  plan = await replan(plan, verdict.fixes, allWorkers, model, ...); // 见 4.4
}

// finally：worktree 生命周期（见模块 D）
```

### 4.4 重规划（`replan`）

把 `verdict.fixes` 转为补充子任务（`id` 用 `re{n}-{targetId}`，`dependsOn: [targetId]`），调用 Planner 的"重规划模式"提示（接收原始 task + 失败/待修正项 + 已有产物摘要），产出新的 `subtasks`。旧 worktree **保留**供对照，新子任务新建 worktree。失败子任务的旧 `WorkerResult` 仍在 `allWorkers` 中（其 `ok=false`），最终 `allOk` 计入。

---

## 5. 模块 D：worktree 生命周期自动管理

**关键改动**：orchestrator 把所有已建 `Worktree` 句柄收集到 `createdWorktrees: Worktree[]`（目前 `wt` 是闭包局部变量，外部拿不到——需在 worker 闭包内 `createdWorktrees.push(wt)`）。在 `runMultiAgent` 外包 `try/finally` 统一处理。

```ts
const lifecycle: WorktreeLifecycle = opts.worktreeLifecycle ?? 'keep';
let merged = false;
try {
  // ...多轮主循环...
  return buildResult(...);
} finally {
  for (const wt of createdWorktrees) {
    const ok = /* 该 wt 对应 WorkerResult.ok */;
    if (lifecycle === 'keep') continue;                 // 默认：不清理
    if (!ok) continue;                                  // 失败一律保留供 review
    if (lifecycle === 'auto-merge') {
      try { await mergeWorktree(wt, baseCwd); merged = true; wt.cleanup(); }
      catch { onWarn?.('合并冲突，已保留 worktree：' + wt.path); } // 转 keep，不丢改动
    } else { // auto-cleanup-success
      wt.cleanup();
    }
  }
}
```

`mergeWorktree`（`artifact.ts` 或 `worktree.ts` 新增）：`git checkout baseBranch && git merge --no-ff <wt HEAD>`，冲突抛错由上面 catch 转 keep。

> 默认 `'keep'` → **行为完全向后兼容**，不影响现有任何调用方与 `/agent` 现有行为。

---

## 6. 改动文件清单（函数级）

| 文件 | 改动点 |
|------|--------|
| `src/core/multiagent/types.ts` | 新增 `WorkerArtifact` / `ReviewVerdict` / `ReviewFix` / `RoundSummary` / `WorktreeLifecycle`；`WorkerResult` 增加 `artifact` + `round`；`MultiAgentResult` 增加 `rounds` + `verdict` + `merged` |
| `src/core/multiagent/artifact.ts` | **新增**：`computeChangedFiles` / `diffDirs` / `parseReviewVerdict` / `mergeWorktree` |
| `src/core/multiagent/prompts.ts` | `buildReviewerSystemPrompt` 改结构化 JSON；新增 `buildPlannerReplanPrompt(fixes, prev)`；Worker/Researcher/Architect 提示加"列出改动文件"要求 |
| `src/core/multiagent/orchestrator.ts` | `runMultiAgent` 重构为多轮循环；收集 `createdWorktrees`；`finally` 生命周期；`MultiAgentOptions` 加 `maxReplan?` / `worktreeLifecycle?`；`worker` 闭包产出 `artifact` |
| `src/core/multiagent/scheduler.ts` | 基本不变；确认"补充子任务"（`dependsOn` 指回原 id）能被正确纳入 DAG 与 `predecessors` 注入（现有逻辑已支持） |
| `src/cli/repl.ts` | `/agent` 新增 `--max-replan <n>`（默认 1）、`--worktree-mode <keep|auto-cleanup-success|auto-merge>`（默认 keep）；透传选项；结果展示增加轮次/verdict/合并状态 |
| `tests/unit/multiagent-artifact.test.ts` | **新增**：`computeChangedFiles`（git+copy 两条路径）、`parseReviewVerdict`（正常/畸形/空） |
| `tests/unit/multiagent-orchestrator.test.ts` | **新增/扩展**：多轮收敛（pass 提前退出、maxReplan 上限）、needs-fix 触发重规划、lifecycle 三策略（成功 cleanup / 失败保留 / merge 冲突转 keep）、现有单轮行为零回归 |

---

## 7. 测试计划

1. **artifact.diff**：在临时 git 仓库改一个文件 → `computeChangedFiles` 返回该路径；copy 模式用目录比对验证。
2. **verdict 解析**：合法 JSON → 正确 `ReviewVerdict`；畸形/非 JSON → 返回 `null`（驱动退化分支）。
3. **重规划收敛**：用 mock model 让首轮 `needs-fix`，次轮 `pass` → 断言 `rounds.length===2` 且 `verdict==='pass'`；强制永不 `pass` → 断言 `rounds.length===maxReplan+1` 后停止（无死循环）。
4. **lifecycle**：
   - `keep` → worktree 句柄 `cleanup` 不被调用；
   - `auto-cleanup-success` → 成功 wt 调 cleanup、失败 wt 不调；
   - `auto-merge` 冲突 → `cleanup` 不调、路径被报告、`merged=false`。
5. **回归**：现有 `tests/unit/` 全绿（433+ 基线）；`output` 字段语义不变，调用方无感。

---

## 8. 风险与降级

| 风险 | 降级/对策 |
|------|-----------|
| Reviewer 结构化 JSON 解析失败 | `parseReviewVerdict` 返回 `null` → 当作 `verdict:'pass'` + 原文本 summary，**完全退化**到当前行为 |
| copy 模式无 git diff | `diffDirs` 递归比对兜底，仍给出 `changedFiles` |
| auto-merge 冲突 | catch 转 `keep` + `onWarn` 报告路径，**绝不丢改动** |
| 重规划死循环 | `maxReplan` 硬上限（默认 1，可调），`round` 计数强制退出 |
| 补充子任务 `dependsOn` 指向失败项 | 现有 `scheduler` 已清洗未知/自环依赖，缺失依赖会被忽略并告警 |

---

## 9. 实施阶段与里程碑

- **A. 基础能力**：`artifact.ts`（diff + verdict 解析）、`types.ts` 扩展、orchestrator 收集 `createdWorktrees` + 产出 `artifact` + `depContext` 注入 `changedFiles`。→ 可独立验证，不引入回路。
- **B. 纠偏 + 重规划**：Reviewer 结构化提示 + `parseReviewVerdict` 接入、`replan`、`runMultiAgent` 多轮主循环、`RoundSummary`/`verdict` 回执。
- **C. 生命周期**：`finally` 统一处理 + `WorktreeLifecycle` 三策略 + `mergeWorktree`。
- **D. 接入与测试**：`/agent` CLI 选项、`tests/unit` 新增用例、全量回归（vitest + typecheck + lint）。

每阶段结束跑 `pnpm test && pnpm typecheck && pnpm lint` 保绿。

---

## 10. 向后兼容性总结

- `MultiAgentResult.output` / `review` / `allOk` / `executionOrder` **字段语义不变** → 现有调用方（REPL、测试）无感。
- 新增字段均为可选或带默认值；`worktreeLifecycle` 默认 `'keep'` → 不自动清理，行为等同当前。
- `runScheduled` 调度逻辑不变，仅消费"补充子任务"这一已有支持的输入形态。
- 不支持动态重规划/纠偏的旧调用方仍可正常工作（默认 `maxReplan=0`? → 见注）。

> **实现注**：`maxReplan` 默认值建议设为 `0` 以**默认关闭多轮回路**（即行为 100% 等同改造前），由 `/agent --max-replan N` 显式开启。这样"先写设计文档"评审通过后，默认路径零行为变化，风险最低。最终值以评审决定为准。

---

## 11. Subagent 并行执行策略（评审补充）

用户评审确认：subagent 应在「任务间无直接依赖」时并行执行。经核对源码，该能力**当前已具备**，本方案将其明确为设计约定并补强冲突防护（不新增执行器代码）。

### 11.1 现有并行通道（已存在，无需新建）
- **`task` 工具（Subagent 层）**：`subagent.ts` 中 `task` 标记 `isReadOnly: true`；`executor.ts:134` 对所有只读工具走 `mapWithConcurrency` 有界并发池（默认上限 10）并行。故主 Agent 在同一轮 ReAct 循环返回多个 `task` tool_call 时，子 Agent 已并发派发。
- **`task_run_parallel`（Task System 层）**：`tasks/index.ts` 从看板（`.tasks/{id}.json`）取「pending 且 `blockedBy` 全完成」的任务，用 `Promise.all` + `maxWorkers` 有界并发派发 `spawnSubagent`（`stripAllTaskTools: true`）。这是显式的「无依赖即并行」批量通道。
- **Multi-Agent Worker 层**：见模块 1–4，DAG 拓扑调度对无 `dependsOn` 的 Worker 并发（`maxWorkers` 默认 3），且每 Worker 在隔离 worktree，无写冲突。

### 11.2 「无直接依赖才并行」的语义约定
- **Subagent（`task`）层**：executor 不感知任务语义依赖，依赖判断在模型侧——模型认为无依赖则同一轮批量发多个 `task` → 自动并行；认为有依赖则先等前一个结论返回再发下一个 → 自然串行。即「无直接依赖则并行」由模型分批表达，无需新增调度代码。
- **Task System 层**：依赖由看板任务的 `blockedBy` 字段显式声明，调度器只取依赖已满足的任务并发，天然实现「无依赖才并行」。

### 11.3 冲突防护约定（新增提示层）
subagent 与 Multi-Agent Worker 的关键差异：**subagent 共享主 cwd（非隔离），并行写同一文件会相互覆盖**。补充约定：
- 在 `buildWorkerSystemPrompt`（subagent 路径）强化提示：「若派发的子任务之间无依赖且写不同文件，可并行；若会写同一文件或彼此依赖，应串行派发，或改用 `/agent`（隔离 worktree）」。
- 本重构的 Multi-Agent Worker 层因隔离 worktree 天然无此冲突，仍是「需写同一代码库且相互独立的子任务」的首选并行通道。

### 11.4 与本次重构的关系
本补充**不新增执行器代码**，仅：① 把「无依赖并行」明确为 subagent 设计约定；② 在提示词层补冲突防护；③ 明确 Subagent 并行 与 Multi-Agent Worker 隔离并发是正交互补的两套机制——前者共享 cwd、适合轻量独立探索/调研；后者隔离 cwd、适合需落盘的并行实现。
