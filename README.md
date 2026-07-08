# easyCLI

从零到一**纯手写**的仿 Claude Code 命令行 Agent CLI。目标是吃透 ReAct、Tool Calling、MCP、多模型适配、Prompt 工程、RAG、安全审计等底层模式，每一期完成一个小模块并配套学习文档。

> 本项目为学习用途，**不 fork 任何参考实现**，所有代码均从零手写。

---

## ✨ 当前能力

已完成第 1–17 期，覆盖从脚手架到多 Agent 协作的完整链路：

- **终端 REPL 多轮对话**，支持 OpenAI 兼容模型的**流式输出**与欢迎面板（Splash）
- **ReAct 循环 + Tool Calling**：模型可调用内置/外部工具，循环直至给出最终答案
- **内置工具**：`read_file` / `write_file` / `edit_file` / `list_dir` / `glob` / `grep` / `bash`
- **安全围栏**：`isReadOnly`/`isDestructive` 标记，读并行 / 写串行；三级权限 + 围栏 + 黑名单 + HITL 人工确认 + 审计日志（挂事件总线）
- **上下文压缩 + 长期记忆**（SQLite）：超预算自动裁剪 / 去重 / 折叠 / 摘要
- **MCP 协议**：客户端（stdio，JSON-RPC 状态机）+ 服务端（暴露 tools/resources，可选 Streamable HTTP）
- **RAG 检索增强**：纯手写嵌入（TF-IDF）+ SQLite 向量检索，可插拔 API 嵌入器
- **Skill 系统**：三层加载（builtin/user/project）+ 渐进式披露，保护 Prompt Cache
- **配置持久化**：`~/.config/agent-cli/config.json`，优先级 CLI 参数 > 环境变量 > 配置文件 > 默认值
- **首次运行向导**：无配置文件时交互式收集 API Key / BaseURL / Model 并持久化，下次免输入
- **会话持久化**：`/save` `/load`、跨会话恢复、历史浏览
- **Plan 模式 + 异步并行**：先规划再执行，子任务可并行预执行只读工具（与 ReAct 共享同一引擎）
- **多模型适配**：OpenAI 兼容 / Anthropic / Ollama 适配器 + **fallback model 降级**
- **Token / 成本统计与可观测性**：挂事件总线统一观测
- **动态上下文注入**：当前时间、cwd、git 分支、OS 自动注入 System Prompt
- **Multi-Agent**：Planner / Worker / Reviewer，文件隔离（git worktree）+ 事件总线

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
| 4 | 上下文压缩（裁剪/去重/折叠/摘要）+ 长期记忆（SQLite） | ✅ 完成 |
| 5 | MCP 客户端（stdio，JSON-RPC 连接状态机） | ✅ 完成 |
| 6 | RAG（检索增强生成，纯手写嵌入 + SQLite 向量检索） | ✅ 完成 |
| 7 | Skill 系统（三层加载 + 渐进式披露保护 cache） | ✅ 完成 |
| 8 | 模型配置持久化（`~/.config/agent-cli/config.json`） | ✅ 完成 |
| 9 | 会话持久化（Session）：`/save` `/load`、跨会话恢复、历史浏览 | ✅ 完成 |
| 10 | REPL 体验打磨：跨会话命令历史、多行粘贴、基础补全、流式渲染 | ✅ 完成 |
| 11 | 多模型适配补全：Anthropic/Ollama 适配器 + fallback model 降级；embed() 可插拔（手写/API） | ✅ 完成 |
| 12 | MCP Server（与客户端对端；暴露 tools/resources，可选 Streamable HTTP 传输） | ✅ 完成 |
| 13 | System Prompt 工程化 + 动态上下文注入（时间/cwd/git 分支/OS） | ✅ 完成 |
| 14 | Token / 成本统计与可观测性（挂事件总线） | ✅ 完成 |
| 15 | Plan 模式 + 异步并行（与 ReAct 共享同一引擎） | ✅ 完成 |
| 16 | 记忆与检索自动注入（recall/RAG 结果每轮自动进上下文） | ✅ 完成 |
| 17 | Multi-Agent（Planner/Worker/Reviewer + 文件隔离 worktree + 事件总线） | ✅ 完成 |
| 18 | Browser（CDP） | ⏳ 待做 |

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

---

## 📁 目录结构
```
src/cli/              入口、REPL、流式渲染器、斜杠命令、首次运行向导、欢迎面板
src/core/chatmodel/   ChatModel 接口 + 适配器（OpenAI 兼容 / Anthropic / Ollama）
src/core/agent/       ReAct 循环（决策核心，不依赖 REPL）
src/core/tools/       工具系统（含 isReadOnly/isDestructive 标记）
src/core/mcp/         McpClient（期5）/ McpServer（期12）
src/core/memory/      上下文压缩 + SQLite 长期记忆
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
