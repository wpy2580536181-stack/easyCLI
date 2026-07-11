# easyCLI

从零到一**纯手写**的仿 Claude Code 命令行 Agent CLI。目标是吃透 ReAct、Tool Calling、MCP、多模型适配、Prompt 工程、RAG、安全审计等底层模式，每一期完成一个小模块并配套学习文档。

> 本项目为学习用途，**不 fork 任何参考实现**：核心 Agent 逻辑（ReAct / Tool Calling / 权限 / 记忆 / RAG 等）均从零手写；**MCP 客户端与服务端基于官方 `@modelcontextprotocol/sdk` 实现**（先手写学习、后迁移到 SDK，见 `docs/mcp-sdk-migration-plan.md`），协议层交由社区维护。

---

## ✨ 当前能力

已完成第 1–17 期，覆盖从脚手架到多 Agent 协作的完整链路：

- **终端 REPL 多轮对话**，支持 OpenAI 兼容模型的**流式输出**与欢迎面板（Splash）
- **ReAct 循环 + Tool Calling**：模型可调用内置/外部工具，循环直至给出最终答案
- **内置工具**：`read_file` / `write_file` / `edit_file` / `list_dir` / `glob` / `grep` / `bash`
- **安全围栏**：`isReadOnly`/`isDestructive` 标记，读并行 / 写串行；三级权限 + 围栏 + 黑名单 + HITL 人工确认 + 审计日志（挂事件总线）
- **上下文压缩 + 长期记忆**（SQLite）：窗口相对预算 + 5 层渐进压缩（大结果落盘 / 选择性裁剪 / 去重 / 折叠 / 缓存友好摘要）+ 413 响应式兜底
- **记忆增强**：① 每轮结束自动从对话提取稳定事实写入记忆库（fire-and-forget）；② 记忆召回用 LLM 语义选择 topN（理解字面不同但语义相关，失败降级关键词）。开关 `--no-auto-memory` / `--no-semantic-recall`
- **MCP 协议**：客户端（基于官方 SDK `Client` 的 stdio 门面，保留连接状态机/超时/错误归一契约）+ 服务端（基于官方 SDK 低层 `Server`，暴露 tools/resources，Streamable HTTP 传输由 SDK 提供完整 SSE/会话能力）
- **RAG 检索增强**：纯手写嵌入（TF-IDF）+ SQLite 向量检索，可插拔 API 嵌入器
- **Skill 系统**：三层加载（builtin/user/project）+ 渐进式披露，保护 Prompt Cache；支持 `skills.autoInject` 指定技能每轮自动注入正文
- **任务规划（todo_write）**：带状态（pending/in_progress/completed）的可追踪任务清单，让模型面对复杂多步任务先拆解再逐项执行；配 nag reminder（连续多轮未更新则临时提醒，不污染 history）
- **任务系统（Task System）**：可持久化到 `.tasks/{id}.json` 的依赖任务图（对齐 Learn Claude Code s12）；`task_create` 建任务并声明 `blockedBy` 依赖、`task_claim` 认领（依赖未完成则拒绝，原子锁防并发重复认领）、`task_complete` 完成并自动解锁下游、`task_list`/`task_get` 查看。与 todo_write 并存：todo_write 是会话内清单，任务系统跨会话保留、有依赖图，适合有依赖 / 需恢复的多步任务
- **看板并行处理（task_run_parallel）**：在任务系统之上做 s12 多 Agent 并行协作——`task_run_parallel` 自动从看板认领「可开始」任务、用有界并发（maxWorkers）派子 Agent 执行、完成一个即解锁下游，直到看板清空（对齐 s12 并行处理）
- **配置持久化**：`~/.config/agent-cli/config.json`，优先级 CLI 参数 > 环境变量 > 配置文件 > 默认值
- **首次运行向导**：无配置文件时交互式收集 API Key / BaseURL / Model 并持久化，下次免输入
- **会话持久化**：`/save` `/load`、跨会话恢复、历史浏览
- **Plan 模式 + 异步并行**：先规划再执行，子任务可并行预执行只读工具（与 ReAct 共享同一引擎）
- **多模型适配**：OpenAI 兼容 / Anthropic / Ollama 适配器 + **fallback model 降级**
- **Token / 成本统计与可观测性**：挂事件总线统一观测
- **动态上下文注入**：当前时间、cwd、git 分支、OS 自动注入 System Prompt
- **Multi-Agent**：Planner / Worker / Reviewer，文件隔离（git worktree）+ 事件总线
- **Subagent（task 工具）**：主 Agent 在 ReAct 循环内可**自主派发**子 Agent（对齐 Learn Claude Code s06）；子 Agent 共享主 cwd（文件副作用保留），但拥有全新 `messages[]`（上下文隔离），只把结论回传，工具集剔除 `task` 防递归
- **联网搜索**：`web_search`（实时检索标题/链接/摘要）+ `web_fetch`（网页正文提取）；Provider 无关（Tavily 正式 API + DuckDuckGo 零 key 兜底），配置纳入 `config.json` 的 `search`

---

## 🚀 快速开始

### 环境要求
- Node.js >= 18（推荐 22）
- pnpm

### 安装
```bash
git clone https://github.com/wpy2580536181-stack/easyCLI.git
cd easyCLI
pnpm install
```

### 配置（任选一种）
支持任意 OpenAI 兼容协议模型（DeepSeek / GLM / Kimi / Qwen 等）。以 DeepSeek 为例：

```bash
export AGENTCLI_API_KEY=你的Key            # 或 OPENAI_API_KEY
export AGENTCLI_BASE_URL=https://api.deepseek.com/v1
export AGENTCLI_MODEL=deepseek-chat
```

> 优先级：`--api-key/--model/--base-url` 命令行参数 > 环境变量 > 配置文件 > 默认值。
> `baseURL` 只需写到 API 根路径（如 `https://api.deepseek.com/v1`），`/chat/completions` 由程序自动拼接。

**首次运行免配置**：若 `~/.config/agent-cli/config.json` 不存在，启动时会自动进入交互式向导，依次填写 API Key / BaseURL / Model 并保存，之后无需重复输入。

### 运行
```bash
pnpm dev                      # 交互 REPL（tsx 直接跑 TS）

# 或先构建再运行
pnpm build && pnpm start

# 单次提问（不进入 REPL）
pnpm dev -p "用一句话解释什么是 ReAct？"
```

### REPL 内命令
| 命令 | 作用 |
|---|---|
| `/help` | 显示帮助 |
| `/clear` | 清空对话上下文（保留系统提示） |
| `/model` | 显示当前模型 |
| `/prompt <文本>` | 单次提问 |
| `/tools` | 列出已注册工具 |
| `/perm` | 查看权限（allow/deny）列表 |
| `/config` | 查看当前生效配置（密钥打码） |
| `/rag` | RAG 索引状态 / 重建 |
| `/skills` `/skill` | 列出 / 查看 Skill |
| `/save` `/load` | 保存 / 加载会话 |
| `/sessions` `/session` | 浏览 / 切换历史会话 |
| `/agent <任务>` | 多 Agent 协作：规划 + 并发 Worker（隔离 worktree）+ 评审（Phase 17） |
| `/rm` | 删除会话 |
| `/exit` 或 `/quit` | 退出 |

---

## 🧱 工程脚本
```bash
pnpm dev         # 交互 REPL
pnpm build       # tsup 打包到 dist/
pnpm test        # vitest 回归测试
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint
```

---

## 🗺️ 路线图（每期一个小模块）

| 期 | 模块 | 状态 |
|---|---|---|
| 1 | 脚手架 + REPL + 流式对话 + ChatModel/OpenAI 适配器 | ✅ 完成 |
| 2 | ReAct 循环 + Tool Calling + 最小内置工具（read_file/bash） | ✅ 完成 |
| 3 | 内置工具扩展 + 安全围栏（isReadOnly/isDestructive；读并行/写串行；三级权限+围栏+黑名单+HITL+审计） | ✅ 完成 |
| 4 | 上下文压缩（5 层渐进 + 窗口相对预算 + 413 兜底）+ 长期记忆（SQLite） | ✅ 完成 |
| 5 | MCP 客户端（基于官方 SDK `Client` 的 stdio 门面；连接状态机/超时/错误归一） | ✅ 完成 |
| 6 | RAG（检索增强生成，纯手写嵌入 + SQLite 向量检索） | ✅ 完成 |
| 7 | Skill 系统（三层加载 + 渐进式披露保护 cache） | ✅ 完成 |
| 8 | 模型配置持久化（`~/.config/agent-cli/config.json`） | ✅ 完成 |
| 9 | 会话持久化（Session）：`/save` `/load`、跨会话恢复、历史浏览 | ✅ 完成 |
| 10 | REPL 体验打磨：跨会话命令历史、多行粘贴、基础补全、流式渲染 | ✅ 完成 |
| 11 | 多模型适配补全：Anthropic/Ollama 适配器 + fallback model 降级；embed() 可插拔（手写/API） | ✅ 完成 |
| 12 | MCP Server（基于官方 SDK 低层 `Server`，与客户端对端；暴露 tools/resources，Streamable HTTP 传输） | ✅ 完成 |
| 13 | System Prompt 工程化 + 动态上下文注入（时间/cwd/git 分支/OS） | ✅ 完成 |
| 14 | Token / 成本统计与可观测性（挂事件总线） | ✅ 完成 |
| 15 | Plan 模式 + 异步并行（与 ReAct 共享同一引擎） | ✅ 完成 |
| 16 | 记忆与检索自动注入（recall/RAG 结果每轮自动进上下文） | ✅ 完成 |
| 17 | Multi-Agent（Planner/Worker/Reviewer + 文件隔离 worktree + 事件总线） | ✅ 完成 |
| 18 | 联网搜索工具（web_search / web_fetch，Provider 无关：Tavily 正式 API + DuckDuckGo 零 key 兜底） | ✅ 完成 |
| 19 | Browser（CDP） | ⏳ 待做 |
| 20 | 记忆增强：自动提取（每轮从对话被动记忆）+ LLM 语义召回（topN 选择，降级关键词） | ✅ 完成 |
| 21 | 任务规划（todo_write）：带状态的可追踪任务清单 + nag reminder（复杂多步任务先拆解再逐项执行） | ✅ 完成 |
| 22 | Skill 自动注入：指定技能正文每轮自动拼入系统提示（无需 use_skill），菜单同步排除避免重复触发 | ✅ 完成 |
| 23 | Subagent（task 工具）：主 Agent 循环内自主派发子 Agent（全新上下文隔离 + 只回传结论 + 防递归），对齐 s06 | ✅ 完成 |
| 24 | Task System（任务系统）：持久化到 `.tasks/` 的依赖任务图（blockedBy 依赖 + can_start 强制 + claim 认领 + complete 解锁下游），对齐 s12 | ✅ 完成 |

---

## 📚 学习文档

每期配套一份学习文档（设计原理、面试话术、常见面试题等），见 [`docs/`](./docs)：
- [第 1 期：脚手架 + REPL 流式对话 MVP](./docs/phase1.md)
- [第 2 期：ReAct 循环 + Tool Calling](./docs/phase2.md)
- [第 3 期：内置工具扩展 + 安全围栏](./docs/phase3.md)
- [第 4 期：上下文压缩 + 长期记忆](./docs/phase4.md)
- [第 5 期：MCP 客户端](./docs/phase5.md)
- [第 6 期：RAG 检索增强](./docs/phase6.md)
- [第 7 期：Skill 系统](./docs/phase7.md)
- [第 8 期：模型配置持久化](./docs/phase8.md)
- [第 9 期：会话持久化](./docs/phase9.md)
- [第 10 期：REPL 体验打磨](./docs/phase10.md)
- [第 11 期：多模型适配补全](./docs/phase11.md)
- [第 12 期：MCP Server](./docs/phase12.md)
- [第 13 期：System Prompt 工程化 + 动态上下文注入](./docs/phase13.md)
- [第 14 期：Token / 成本统计与可观测性](./docs/phase14.md)
- [第 15 期：Plan 模式 + 异步并行](./docs/phase15.md)
- [第 16 期：记忆与检索自动注入](./docs/phase16.md)
- [第 17 期：Multi-Agent](./docs/phase17.md)
- [第 23 期：Subagent（task 工具，对齐 s06）](./docs/phase23.md)
- [第 24 期：Task System（任务系统，对齐 s12）](./docs/phase24.md)
- [第 25 期：看板并行处理（task_run_parallel，对齐 s12 并行）](./docs/phase25.md)
- [记忆增强设计（Phase 20）：自动提取 + LLM 语义召回](./docs/memory-enhancement-design.md)

---

## 📁 目录结构
```
src/cli/              入口、REPL、流式渲染器、斜杠命令、首次运行向导、欢迎面板
src/core/chatmodel/   ChatModel 接口 + 适配器（OpenAI 兼容 / Anthropic / Ollama）
src/core/agent/       ReAct 循环（决策核心，不依赖 REPL）
src/core/tools/       工具系统（含 isReadOnly/isDestructive 标记）
src/core/mcp/         McpClient（SDK Client 门面，期5）/ McpServer（SDK 低层 Server 门面，期12）/ demo-server（stdio + Streamable HTTP）
src/core/memory/      上下文压缩（5 层）+ SQLite 长期记忆；extractor.ts 自动提取（期20）；窗口推导见 src/core/chatmodel/contextWindow.ts
src/core/rag/         向量检索（期6）
src/core/skill/       三层加载 + 渐进式披露（期7）
src/core/multiagent/  Orchestrator（期17，worktree 隔离）
src/core/security/    围栏/黑名单/权限/脱敏/审计（期3/6/9）
src/core/events/      事件总线/钩子（审计与可观测性挂载点）
src/config/           配置加载、合并与持久化
tests/unit/           vitest 回归测试
docs/                各期学习文档
```

---

## ⚠️ 说明
- `node_modules`、`dist`、`.env`、本地 `CLAUDE.md` 均不入库。
- 密钥（API Key）切勿提交；请只用环境变量或首次运行向导注入。
