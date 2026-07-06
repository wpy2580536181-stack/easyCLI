# easyCLI

从零到一**纯手写**的仿 Claude Code 命令行 Agent CLI。目标是吃透 ReAct、Tool Calling、MCP、多模型适配、Prompt 工程、RAG、安全审计等底层模式，每一期完成一个小模块并配套学习文档。

> 本项目为学习用途，**不 fork 任何参考实现**，所有代码均从零手写。

---

## ✨ 当前能力（第 1 期 MVP）

- 终端 REPL 多轮对话，支持 OpenAI 兼容模型的**流式输出**
- Provider 无关的 `ChatModel` 接口 + `OpenAICompatibleAdapter`（手写 SSE 解析、tool_calls 分片拼接、兼容 DeepSeek `reasoning_content`）
- 配置三层合并：CLI 参数 > 环境变量 > 默认值
- 斜杠命令：`/help` `/clear` `/model` `/prompt` `/exit`

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

> 优先级：`--api-key/--model/--base-url` 命令行参数 > 环境变量 > 默认值。
> `baseURL` 只需写到 API 根路径（如 `https://api.deepseek.com/v1`），`/chat/completions` 由程序自动拼接。

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
| 2 | ReAct 循环 + Tool Calling | 待做 |
| 3 | 内置工具 + 安全围栏 | 待做 |
| 4 | Memory（SQLite + 压缩） | 待做 |
| 5 | MCP 客户端（stdio） | 待做 |
| 6 | RAG | 待做 |
| 7 | Skill 系统 | 待做 |
| 8 | Multi-Agent | 待做 |
| 9 | MCP Server + 多模型补全 | 待做 |
| 10 | Browser(CDP) + 异步并行 + Plan 模式 | 待做 |

---

## 📚 学习文档

每期配套一份学习文档（设计原理、面试话术、常见面试题等），见 [`docs/`](./docs)：
- [第 1 期：脚手架 + REPL 流式对话 MVP](./docs/phase1.md)

---

## 📁 目录结构
```
src/cli/              入口、REPL、流式渲染器、斜杠命令
src/core/chatmodel/   ChatModel 接口 + 适配器
src/config/           配置加载与合并
tests/unit/           vitest 回归测试
docs/                各期学习文档
```

---

## ⚠️ 说明
- `node_modules`、`dist`、`.env`、本地 `CLAUDE.md` 均不入库。
- 密钥（API Key）切勿提交；请只用环境变量注入。
