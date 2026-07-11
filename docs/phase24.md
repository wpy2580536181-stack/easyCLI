# 第 24 期：Task System（任务系统，对齐 Learn Claude Code s12）

## 背景：s12 讲的是什么

Learn Claude Code 的 s12 是一套独立的 **Task System（任务系统）**，与 s05 的 TodoWrite **并存于 CC 中**（由 `isTodoV2Enabled()` 切换）。两者的区别：

| | TodoWrite（s05，本项目 Phase 21 `todo_write`） | Task System（s12，本项目 Phase 24） |
|---|---|---|
| 定位 | 当前任务的执行清单 | 可恢复的任务系统 |
| 存储 | 进程内 / 会话状态（内存，退出即清空） | `.tasks/{id}.json`（磁盘，跨会话） |
| 依赖 | 无 | `blockedBy` / `blocks` 依赖图 |
| 生命周期 | 当前会话 / 任务 | 跨会话保留 |
| 分工 | 不负责任务认领 | `owner` / `claim` 认领 |
| 状态 | pending / in_progress / completed | 同左 |
| 粒度 | Agent 自己的步骤 | 可被认领、追踪、解锁的任务 |

s12 要解决的问题：**任务之间有先后依赖（DAG）**。盖房子不能先盖屋顶再打地基——s05 的 TodoWrite 只是内存里的执行清单，没有依赖、不跨会话、多 Agent 无法协调认领。s12 把每个任务落成磁盘文件，用 `blockedBy` 建依赖图，`can_start` 强制执行，`claim`/`complete` 推进并解锁下游。

## 设计要点

### 1. 数据结构（对齐 CC 的 9 字段子集）
`Task`：`id` / `subject` / `description` / `status` / `owner` / `blockedBy` / `blocks` / `activeForm` / `metadata`。
- `id`：顺序整数（高水位标防重用）。
- `blockedBy`：上游依赖；`blocks`：下游被阻塞者（创建时由 `blockedBy` **反向自动维护**，便于 `complete` 高效找下游）。
- `owner`：认领者（多 Agent 防重复认领）。

### 2. 文件持久化（`TaskStore`）
- 每个任务一个 JSON 文件：`<cwd>/.tasks/{id}.json`。
- 懒创建 `.tasks/` 目录（仅首次写入时落盘，未使用不在项目留痕）。
- `.highwatermark` 记录已分配最大 ID（即使任务删除，ID 也不重用——对齐 CC 严谨设计）。

### 3. 依赖强制（`can_start`）
一个任务只有在 `blockedBy` **全部 `completed`** 后才能开始；缺失的依赖视为 blocked（避免引用错误 ID 时崩溃）。

### 4. 认领与完成（`claim` / `complete`）
- `claimTask(id, owner)`：`pending → in_progress`，记录 `owner`；依赖未完成或被他人认领则**拒绝**。
- `completeTask(id)`：`in_progress → completed`，并扫描算出**刚被解锁的下游** pending 任务返回（自动解锁）。
- 状态机：`pending ──claim──▶ in_progress ──complete──▶ completed`（无 release 回退路径，与 CC 一致）。

### 5. 五个工具（`getTaskTools`）
`task_create`（建任务 + 声明 `blockedBy`）、`task_list`（看全貌）、`task_get`（取完整细节 / 跨会话恢复）、`task_claim`（认领）、`task_complete`（完成 + 解锁）。注册进主 Agent 工具表后在循环内可用。

## 与既有系统的关系

- **vs `todo_write`（Phase 21）**：两套并存（对齐 CC）。`todo_write` = 会话内执行清单（轻、无副作用）；Task System = 持久化依赖图（适合有依赖 / 需恢复的多步任务）。系统提示里明确告知二者区别，避免误用。
- **vs Multi-Agent（Phase 17 `/agent` 编排器 + Phase 23 `task` 子 Agent）**：多 Agent 引擎已具备，但 s12 的「多 Agent 认领任务」场景需在其上叠加**共享 `.tasks` 看板 + `claim` 协调**才成立——本 Phase 24 提供了这层持久任务图，`owner`/`claim` 即为多 Agent 认领防重复的基础。

## 已知边界（未实现，属 s12 进阶项）

1. **无并发文件锁**（`proper-lockfile`）：仅单 Agent 或顺序多 Agent 时安全；真正并发多 Agent 同写 `.tasks/` 需加锁（CC 用双重锁防竞争）。
2. **无 `fs.watch` 响应式监听 / 生命周期 hooks**：没有「任务变更实时刷新面板」（`useTaskListWatcher`）。
3. **无环检测**：`blockedBy` 当前不检测环（教学版同样省略）；依赖 DAG 的正确性依赖模型/调用方。
4. **无 `in_progress → pending` 释放路径**：Agent 终止时 CC 会 unassign 并重置为 pending，本实现未做（任务数少、单 Agent 场景下影响有限）。

## 验证

- **单元测试** `tests/unit/tasks.test.ts`：**15 例全绿**——create 写文件 / 顺序 ID / 高水位标防重用；`blockedBy` 未完成 `claim` 拒绝、`can_start=false`、完成后解锁；`claim` 设 `owner`+`in_progress`；`get`/`list`；缺失依赖 blocked；双向边维护；`task_*` 工具封装返回正确。
- **真实 API**（agnes-2.0-flash，`scripts/test-tasksystem-realapi.ts`，`source .env`，临时目录当 cwd 避免污染仓库）：给定「建表→API(依赖表)→测试(依赖API)→文档(依赖表)」计划，agent 用 `task_create` 建出精确依赖图（`api←1`、`tests←2`、`docs←1`），按 DAG 顺序 `1→2→4→3` `claim`+`complete`，全部 `completed`，`.tasks/` 落盘。机制端到端可用。
- **质量门**：tsc 干净；全量 **404/404**；pnpm build 成功。
