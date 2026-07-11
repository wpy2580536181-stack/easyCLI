# Phase 25 — 看板并行处理（Task System 扇出，对齐 s12）

## 背景

Phase 24 落地了 s12 的任务系统（`.tasks/` 持久化、依赖图、`claim`/`complete`、解锁下游），
但只能**顺序**驱动：单个 agent 按 DAG 逐步 `claim → 执行 → complete`。文章 s12 的「并行处理」
要求**多个 agent 并发认领共享看板上的可开始任务**，真正同时推进独立任务。

当时（对照 s12）确认的两块缺口：
1. `claimTask` 非原子 —— 并发认领会重复认领（TOCTOU）；
2. 没有「看板 × 并发」的扇出调度器 —— `task` 工具串行派发、`/agent` 预分配不读看板。

本 Phase 补齐这两点，让 s12 的并行处理真正可用。

## 设计

### 1) 原子 claim（防并发重复认领）

`TaskStore` 增加进程内异步互斥锁 `AsyncMutex`，把 `claimTask` 的「读-检查-写」包成原子临界区：

```ts
async claimTask(id, owner = 'agent'): Promise<ClaimResult> {
  return this.lock.run(() => {
    const t = this.readRaw(id);
    if (!t) return { ok: false, msg: `task ${id} 不存在` };
    if (t.status !== 'pending') return { ok: false, msg: `task ${id} is ${t.status}, cannot claim` };
    if (!this.canStart(id)) { /* ... Blocked by ... */ return { ok: false, ... }; }
    t.owner = owner; t.status = 'in_progress'; this.writeRaw(t);
    return { ok: true, msg: `Claimed ${id} (${t.subject})` };
  });
}
```

- 进程内（同一 CLI 调用、所有子 agent 在同一 Node 进程）下，并发 `claim` 被串行化，
  **恰好一个**成功，杜绝重复认领 —— 这正是 s12 `proper-lockfile` 想解决的竞态。
- 跨进程 / 跨 CLI 实例的强一致，下一步应换 `proper-lockfile` 之类的真实文件锁（已在已知边界列出）。

### 2) 看板扇出调度器 `runTasksInParallel`

有界并发池（默认 `maxWorkers=3`，范围 1-8）持续从看板认领「可开始」任务，
派子 agent 执行，完成一个自动解锁下游，直到看板清空：

```
worker 循环:
  claimNext()  →  list 出 pending 且 canStart 的任务，逐个尝试原子 claim，成功则返回
  exec(task)   →  spawnSubagent 派子 Agent 在共享 cwd 执行（stripAllTaskTools：worker 只干活、不碰看板）
  completeTask → 标记完成、扫描并解锁下游
```

- `claimNext` 在候选被别的 worker 抢走后会试下一个，天然「工作窃取」；
- 只要还有可认领任务，必有仍在循环的 worker 接管（持有 in_progress 任务的 worker 完成后续循环认领下游），无死锁；
- 并发上限用 `Promise.all(Array.from({length: maxWorkers}, () => worker()))` 实现。

### 3) `task_run_parallel` 工具

`getTaskTools(store, subDeps?)` 在提供 subagent 依赖（`model/permission/bus/cwd/tools`）时，
额外注册 `task_run_parallel` 工具。agent 在循环内自主调用即可触发并行扇出（对齐 s12 多 Agent 协作）：

- 标 `isReadOnly=true`，非交互 / Plan 模式也能触发编排（子 agent 写操作各自经权限 gate）；
- `maxWorkers` 可选（默认 3，钳制 1-8）。

`buildSubagentTools` 新增 `stripAllTaskTools`：并行 worker 的工具集剔除整个 `task*` 家族，
成为「纯执行者」，避免干扰调度器对任务状态的权威管理（防止 worker 自己 claim/complete 造成状态错乱）。

## 接线

- `src/core/tasks/index.ts`：`AsyncMutex` + 原子 `claimTask` + `runTasksInParallel` + `task_run_parallel` 工具；
- `src/core/multiagent/subagent.ts`：`buildSubagentTools` 支持 `stripAllTaskTools`，`spawnSubagent` 透传；
- `src/cli/main.ts`：在 `permission/bus` 就绪后调用 `getTaskTools(taskStore, subDeps)` 注册扇出工具；
- `src/core/prompts/index.ts`：`NON_GENERAL_TOOLS` 加 `task_run_parallel` + 工具策略引导。

## 验证

- **单测**（`tests/unit/parallel-tasks.test.ts`，4 例全绿；`tasks.test.ts` 因 `claimTask` 改 async 同步更新）：
  ① 并发 `claimTask` 同一任务恰好一个成功（原子锁）；② `runTasksInParallel` 按依赖图并发执行、看板清空、根任务先于下游、无重复认领；③ `maxWorkers=1` 串行链顺序正确；④ `getTaskTools` 仅在有 subDeps 时注册 `task_run_parallel`。
- **全量** 408/408 通过，tsc 干净，build 成功。
- **真实 API**（agnes-2.0-flash）：agent **自主建出 4 任务依赖图（4×`task_create`）+ 调用 `task_run_parallel` 触发并行扇出**，证明工具已正确接线并被模型采用。并发子 agent 执行阶段因模型端点网络抖动（`UND_ERR_CONNECT_TIMEOUT`/SIGKILL，本会话多次复现）中断，非实现缺陷——并行协调逻辑已由单测确定性覆盖。

## 已知边界（s12 进阶项，未做）

- **跨进程文件锁**：当前为进程内互斥锁；多 CLI 实例并发需换 `proper-lockfile`。
- **共享 cwd 的文件冲突**：并行 worker 在同一工作目录干活，若任务触碰相同文件会互相覆盖（s12 描述的「多 agent 同仓库」固有风险；`/agent` 用 worktree 隔离可规避，但那就不是看板语义了）。
- 无 `fs.watch` 响应式面板、无环检测、无 `in_progress → pending` 释放路径（agent 中途退出时未完成任务不自动 unassign）。
