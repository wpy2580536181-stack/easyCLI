# 第 23 期：Subagent（task 工具，对齐 Learn Claude Code s06）

> 参考：[Learn Claude Code · s06 Subagent](https://learn.shareai.run/zh/s06/)
> 一句话：**让主 Agent 在 ReAct 循环内自主派发子 Agent，子 Agent 拥有干净的全新上下文，只把结论回传。**

---

## 1. 问题

长对话里，Agent 为了解决一个子问题（比如「调研这个项目的测试框架」）会读一堆文件、聊很多轮，
这些中间过程全部堆在主对话的 `messages[]` 里，稀释了主 Agent 对原始目标的注意力，越聊越「健忘」。

类比：你修 bug 时会「开一个新终端」去追调用链，追完了关掉终端、把结论写进笔记，回到原终端继续。
Agent 也需要这个能力——开一个独立的子进程，给它干净的上下文，让它专心做一件事，最后只把结论拿回来。

---

## 2. s06 的核心设计（教学版）

- 新增 `task` 工具：主 Agent 像调其他工具一样调用它，spawn 一个子 Agent。
- 子 Agent 拥有**全新的 `messages[]`**（上下文隔离），跑自己的循环，结束后**只回传结论文本**（中间过程丢弃）。
- 子 Agent 的工具受限（有 bash/read/write/edit/glob，**没有 task**），防止递归 spawn。
- 子 Agent 的工具调用仍走权限 hook——上下文隔离 ≠ 权限隔离。
- 相对 s05（只有 todo_write 规划）：工具数 6 → 7（+task）；循环不变，dispatch 不变，子 Agent 有独立 `SUB_SYSTEM` 与 hook 保护的循环。

---

## 3. 本项目的实现

复用既有的 `runAgent` 引擎（`src/core/agent/loop.ts`），零新引擎：

| 文件 | 内容 |
|------|------|
| `src/core/multiagent/subagent.ts`（新） | `spawnSubagent()`（派发单个子 Agent）+ `getSubagentTools()`（导出 `task` 工具）+ `buildSubagentTools()`（剔除 task 防递归） |
| `src/cli/main.ts` | 工具装配处注册 `getSubagentTools({ model, permission, bus, cwd, tools })` |
| `src/core/prompts/index.ts` | `NON_GENERAL_TOOLS` 加 `task`；`toolPolicyBlock` 加使用时机引导 |

**`task` 工具行为**：
1. 主 Agent 在循环内调用 `task({ description })`；
2. `spawnSubagent` 用 `buildWorkerSystemPrompt` 构造子 Agent 系统提示（追加「你是被派发的子 Agent，不要再次委派」），发起**全新** `messages[]`；
3. 子 Agent 跑自己的 `runAgent` 循环（安全轮次上限 30，对齐 s06），共享主 `cwd`（文件副作用保留在主工作目录，对齐 s06「开新终端」比喻）；
4. 子 Agent 的工具集由 `buildSubagentTools` 裁剪——**剔除 `task` 自身**，防递归；
5. 只取子 Agent 最后一条 assistant 文本作为结论回传给主 Agent。

**权限**：`task` 标 `isReadOnly=true`（编排动作本身不改主目录；子 Agent 的具体写操作仍各自经权限 gate），因此主 Agent 在非交互 / Plan 模式下也能自主派发。子 Agent 工具调用同样走 `PermissionManager` 与事件总线（`agent:spawn` / `agent:done`）。

---

## 4. 与 Phase 17 `/agent` 编排器的区别

两者复用同一 `runAgent` 引擎，但触发方式与范围不同：

| 维度 | `/agent <任务>`（Phase 17） | `task` 工具（Phase 23，对齐 s06） |
|------|------|------|
| 触发 | 用户**显式命令** | 主 Agent **自主**在循环内调用 |
| 流程 | Planner → 并发 Worker（隔离 worktree）→ Reviewer | 单个子 Agent（全新 messages[]） |
| 文件系统 | 每个 Worker 独立 git worktree（隔离） | 子 Agent 共享主 cwd（副作用保留，s06 风格） |
| 上下文 | 每个 Worker 独立 worktree + 独立历史 | 仅 messages[] 隔离，cwd 共享 |
| 递归 | N/A（命令式） | 工具集剔除 task，禁止递归 |

> 简言之：`/agent` 是「用户拉起一次多 Agent 协作」，`task` 是「Agent 自己把一个小任务甩给子 Agent」。

---

## 5. 验证

- 单测 `tests/unit/subagent.test.ts`（5 例）：`buildSubagentTools` 剔除 task / `task` 工具定义 / `spawnSubagent` 端到端回传结论 / 父 Agent 自主调用 task 且子 Agent 上下文隔离（首条消息 `[system, user]` 全新、不含父历史）/ 空 description 不派发。
- 全量 `vitest` **389/389** 通过；`tsc --noEmit` 干净；`pnpm build` 成功。
- 真实 API（agnes-2.0-flash）：给定「调研本项目测试框架」任务，Agent **第 0 轮即自主调用 `task`**，子 Agent 读出 `package.json` 确认用 **Vitest**，结论回传后父 Agent 整合进最终回复。机制端到端可用。

---

## 6. 已知边界

- **Plan 模式 + task**：`task` 标 `isReadOnly=true` 故在 Plan 模式下也可被调用，但子 Agent 不继承 Plan 模式的写 gate，可能实际执行写操作。当前未强制把 Plan 状态下传给子 Agent（边缘场景，未处理）。
- **无 Fork 模式 / Prompt Cache 共享**：本项目子 Agent 是「全新上下文」等价（教学版 Normal Subagent），未实现 CC 源码里的 Fork 模式（共享前缀命中缓存）。
- **无异步后台子 Agent**：`task` 为同步（父等子跑完），对应 CC 的 s13 异步路径未实现。
