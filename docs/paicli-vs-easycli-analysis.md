# PaiCLI-TS「有什么值得学」× easyCLI 现状对照与改进方案

> 来源：<https://paicoding.com/paicli-typescript-launch> 的「01、有什么值得学的？」与「02、实现了哪些功能？」板块。
> 对照对象：本仓库 easyCLI（agent-cli 0.1.0，Node 22 + Ink5 + React18 + zustand）。
> 结论定位：**8 个核心依赖里，6 个已覆盖或已用更优替代；2 个存在真实缺口（MCP 客户端 HTTP 传输、glob）；zod 覆盖不完整；另有 3 处功能层差异（Plan-and-Execute 缺独立模块、Multi-Agent 角色/依赖不全、ReAct 用回调而非 AsyncGenerator）。**

---

## 一、文章「值得学」要点速览

**核心依赖（8 个）**：Ink+React（声明式 TUI）、undici（HTTP+SSE）、commander（CLI）、zod（运行时校验）、@modelcontextprotocol/sdk（MCP，stdio+HTTP）、better-sqlite3（同步 SQLite）、fast-glob（文件匹配）、chalk（着色）。
**工具链**：pnpm + tsup + vitest + TS 5.5+。
**已实现功能**：ReAct 循环（AsyncGenerator 流式）、Plan-and-Execute、Multi-Agent 编排（4 角色 + 依赖）、Skill 系统（三级加载）。

---

## 二、现状对照矩阵

| # | 文章要点 | easyCLI 现状 | 判定 |
|---|---------|-------------|------|
| 1 | Ink + React 声明式 TUI | Ink5 + React18 + @inkjs/ui + ink-big-text(cfonts splash) + ink-spinner + zustand，流式/工具态/进度全组件化 | ✅ 已覆盖且更先进 |
| 2 | undici HTTP + SSE | 用 Node 内置 `fetch`（底层即 undici）手写 SSE 逐行解析；web 工具走 `undici.ProxyAgent` | ⚠️ 等价但设计不同，LLM 请求无代理 |
| 3 | commander CLI | `main.ts` 已用 `Command` 链式定义子命令/选项 | ✅ 已覆盖 |
| 4 | zod 运行时校验 | **仅** `config/store.ts` 校验配置文件；LLM 返回 JSON 用裸 `JSON.parse`，工具入参各工具手写 `typeof` 判断 | ⚠️ 覆盖不完整 |
| 5 | MCP SDK（stdio+HTTP） | **服务端** `demo-server.ts` 支持 stdio+HTTP；**客户端** `client.ts` 仅 StdioClientTransport，无 `url` 规格 | ❌ 客户端缺 HTTP 传输 |
| 6 | better-sqlite3 同步 SQLite | 用 Node22 内置 `node:sqlite`(`DatabaseSync`)，零依赖同步 API，记忆/RAG/会话均用 | ✅ 已覆盖且更优（免原生编译） |
| 7 | fast-glob 文件匹配 | 手写 `walk`+`patternToRegExp`，不支持 `[abc]`/`{a,b}`/`?`，每次全量遍历 | ❌ 缺口（语法+性能） |
| 8 | chalk 着色 | 多处 `chalk.gray/yellow/bold` 与 Ink 配合 | ✅ 已覆盖 |
| — | tsup / vitest | `tsup.config.ts` + vitest（441 测试全绿） | ✅ 已覆盖 |
| — | pnpm | 实际用 **npm**（`package-lock.json` 更新，`pnpm-lock.yaml` 陈旧） | ⚠️ 习惯差异，非缺陷 |

**功能层**：

| 功能 | easyCLI 现状 | 判定 |
|------|-------------|------|
| ReAct 循环 | `agent/loop.ts` 已实现，含压缩/前缀缓存/规划模式/自动上下文/任务 nag 增强 | ✅ 已覆盖（流式用回调而非 AsyncGenerator） |
| Plan-and-Execute | 有 Plan 模式(只读 gate+计划文本) + `todo_write` 清单，但**无「生成计划→逐步执行→结果喂回下一步」的单 Agent 专用模块** | ⚠️ 部分 |
| Multi-Agent | Planner/Worker/Reviewer 三角色 + worktree 隔离 + 有界并发(`mapPool`) | ⚠️ 角色合并、无依赖图 |
| Skill 系统 | `builtin/user/project` 三级 + frontmatter + 渐进式披露 + 自动注入(Phase22) | ✅ 已覆盖且更完善 |

---

## 三、差异点逐项分析与改进方案

### 差异 1（❌ 高优先级）：MCP 客户端只支持 stdio，缺 HTTP/StreamableHTTP 传输

- **现状**：`src/core/mcp/client.ts` 的 `McpServerSpec` 只有 `command/args/env/cwd`，`McpClient.connect()` 只用 `StdioClientTransport`。服务端 `demo-server.ts` 已能 listen HTTP，但客户端连不上远程 HTTP MCP Server。文章明确把「stdio + HTTP 两种传输」列为 SDK 的核心学习点。
- **修改模块**：`src/core/mcp/client.ts`、`src/core/mcp/client.ts` 的 `McpServerSpec` 类型、`src/config/store.ts` 的 `mcpServerSchema`（当前 zod 仅允许 command）、`connectMcpServers()` 工厂。
- **改进目标**：
  1. `McpServerSpec` 增加 `transport?: 'stdio' | 'http'` 与 `url?: string` 字段；
  2. `connect()` 按 `transport` 选择 `StdioClientTransport` 或 `StreamableHTTPClientTransport`（`@modelcontextprotocol/sdk/client/streamableHttp.js`）；
  3. `mcpServerSchema` 改为 `z.union([stdioSchema, httpSchema])`，`config.json` 可声明远程服务；
  4. 保留超时/状态机/工具归一化等既有能力。
- **预期效果**：可接入云端/远程 MCP 服务（如 SSE/StreamableHTTP 端点），与文章「直接接入 MCP 生态」完全对齐；CLI 用户能写 `--mcp '[{"transport":"http","url":"https://x/mcp"}]'`。

### 差异 2（❌ 高优先级）：glob 手写，缺 fast-glob 高级语法与性能

- **现状**：`src/core/tools/builtin.ts` 的 `globTool` 用 `walk` 递归 + `patternToRegExp`（仅替换 `**`、`*`）。不支持字符类 `[abc]`、选择 `{a,b}`、单字符 `?`，且每次调用全量遍历整棵树过滤，无 gitignore/缓存。`skill/loader.ts` 与 `rag/store.ts` 也各自手写 `walk`。
- **修改模块**：`src/core/tools/builtin.ts`(globTool)、`src/core/skill/loader.ts`(walk)、`src/core/rag/store.ts`(walk, 用于 `reindex/listSourceFiles`)；新增依赖 `fast-glob`（或复用已间接存在的 `tinyglobby`）。
- **改进目标**：
  1. `globTool` 改调 `fast-glob(pattern, { cwd, absolute:false, dot:false })`，支持完整 glob 语义；
  2. Skill/RAG 扫描改用 `fast-glob('**/*.md')` 等，统一文件遍历入口，移除 3 处重复 `walk`；
  3. 可选加 `ignore:['**/node_modules/**','**/.git/**']` 提升大仓库下的召回质量与速度。
- **预期效果**：glob 语法完整（模型可写 `src/**/*.{ts,tsx}`、`**/[abc]*.md`）；扫描性能提升（fast-glob 比原生 walk 快 2-3 倍，且不重复读目录）；消除三处重复遍历代码，降低维护成本。

### 差异 3（⚠️ 中优先级）：zod 仅用于配置，未覆盖「LLM 返回 JSON」与「工具输入参数」

- **现状**：`config/store.ts` 用 zod 校验 `config.json`（✅）。但：① 多 Agent 计划 JSON 用裸 `JSON.parse`+try/catch（`orchestrator.parsePlan`）、todo 用 `normalizeTodos` 手工推断；② 工具入参无集中运行时校验，每个 `execute` 内部手写 `typeof`/`Array.isArray`（如 `planning.ts`）。已装 `zod-to-json-schema` 却未反向用于由 inputSchema 校验实参。文章核心论点：「Agent 系统模型输出结构不可控，没有运行时校验很容易崩」。
- **修改模块**：`src/core/multiagent/orchestrator.ts`(parsePlan)、`src/core/tools/planning.ts`(normalizeTodos)、`src/core/tools/executor.ts`(新增入参校验层)、`src/core/skill/types.ts`(frontmatter 解析可选 zod)。
- **改进目标**：
  1. 为计划/子任务/工具结果定义 `z.object(...)` schema，`safeParse` 失败给出结构化错误而非退化；
  2. 在 `executor.ts` 加一层「按 `inputSchema` 校验 `args`」：用 `zod-to-json-schema` 反向把 JSON Schema 转 zod 校验，或写轻量 JSON Schema 校验器，非法参数在入口即拦截并返回 `ok:false`（杜绝脏参数跑进工具）；
  3. 保留现在的「兜底退化」作为最后防线，但把"结构合法性"前移。
- **预期效果**：LLM 偶发畸形 JSON（缺字段/类型错）不再静默退化成单子任务或崩，而是被结构化拒绝/重试；工具实参错误在执行前被拦下，减少"工具跑一半才报错"的浪费，整体健壮性显著提升。

### 差异 4（⚠️ 中优先级）：undici 未显式使用，LLM 请求不支持代理

- **现状**：所有大模型通信走全局 `fetch`（底层 undici），SSE 手写解析（正确且健壮）。但文章把 undici 作为"值得学"的点在于**直接控制 HTTP 解析器/连接池/代理**。`fetch-util.ts` 已用 `undici.ProxyAgent` 仅服务于 web 搜索工具，LLM 适配器（`openai-compatible.ts`/`anthropic.ts`）未用，故**走代理的 LLM 网关无法被代理**。
- **修改模块**：`src/core/chatmodel/openai-compatible.ts`、`anthropic.ts`，以及 chatmodel 工厂/配置（读取 `HTTPS_PROXY`）。
- **改进目标**：当检测到 `HTTPS_PROXY/HTTP_PROXY` 时，构造 `undici.ProxyAgent` 并作为 `fetch` 的 `dispatcher` 选项传给 LLM 请求（与 web 工具一致）；或抽取一个共享的 `createDispatcher()` 工具函数。
- **预期效果**：在内网/代理环境下 LLM 请求也能走代理，与 web 工具行为统一；同时显式用到 undici API，呼应文章学习点（可保留"为何用全局 fetch + 仅在需要时切 undici dispatcher"的注释作为教学说明）。

### 差异 5（⚠️ 中优先级）：Multi-Agent 缺「研究员/架构师」角色拆分与任务依赖图

- **现状**：`src/core/multiagent/` 是 Planner→Worker(扇出)→Reviewer 三角色，Worker 在 worktree 隔离、有界并发。文章为 4 角色（架构师/开发者/审查者/研究员），且强调"支持任务之间的依赖关系"。easyCLI 的 `Subtask` 无 `dependsOn`，`mapPool` 把子任务**全部并行**跑，无拓扑排序。
- **修改模块**：`src/core/multiagent/types.ts`(Subtask 加 `role?`/`dependsOn?`)、`orchestrator.ts`(按依赖做分层/拓扑执行，而非一次性 mapPool)、`prompts.ts`(增 researcher/architect 系统提示)、`index.ts`(暴露角色枚举)。
- **改进目标**：
  1. `Subtask` 增加可选 `dependsOn: string[]`；`orchestrator` 解析出依赖图后**分层拓扑执行**（先无依赖层，完成后再放依赖层），仍保留 worktree 隔离；
  2. 新增 `researcher`/`architect` 角色提示词，允许 Planner 把子任务标注 `role`，Worker 按角色加载对应系统提示（开发者=落地实现，研究员=只读调研）；
  3. 保持「单 Worker 失败不阻断整体」的容错。
- **预期效果**：能正确表达「先调研再实现」「先设计再编码」这类有先后的多步任务，避免并行导致的竞态与上下文污染；角色化系统提示提升各子 Agent 的专精度，更接近文章描述的编排能力。

### 差异 6（⚠️ 低优先级）：缺独立的 Plan-and-Execute 模块

- **现状**：easyCLI 有 Plan 模式（只读 + 模型输出计划文本）和 `todo_write`（可追踪清单），但**没有"先让 LLM 生成分步计划 → 逐步执行每步 → 把每步结果带入下一步上下文"的专用单 Agent 流程**。最接近的是 multiagent 的 planner→worker（那属多 Agent）。
- **修改模块**：新增 `src/core/agent/plan-execute.ts`（复用 `runAgent` 引擎）。
- **改进目标**：实现 `runPlanAndExecute(task, opts)`：① 调模型产出 `steps[]` 计划（zod 校验）；② 循环执行每步，把前序步骤的「观察结果」累积进下一轮的上下文；③ 支持中途人工确认（接 `permission`）。与现有 Plan 模式（只读 gate）正交，可作为复杂任务的标准入口。
- **预期效果**：对"重构整个模块""迁移数据库"类多步骤任务，步骤间上下文连贯、可逐步校验，减少一次性大改动的风险；补齐文章列出的功能清单。

### 差异 7（设计差异，可选）：ReAct 用回调 hooks 而非 AsyncGenerator

- **现状**：`runAgent` 通过 `AgentHooks`(onText/onToolCall/onToolResult) + `EventBus` 上抛流式事件。文章强调 PaiCLI "基于 AsyncGenerator 实现流式事件输出，上层按事件消费"。
- **改进目标（可选）**：在 `runAgent` 之上包一层 `async function* agentEvents(history, opts)` 把 hooks 转成 `yield` 事件，供上层 `for await` 消费；底层引擎不变。
- **预期效果**：更贴合文章的教学范式，上层消费代码更直观（`for await (const ev of agentEvents(...))`）。属风格对齐，非功能缺口。

### 差异 8（文档差异）：包管理器为 npm 而非 pnpm

- **现状**：仓库同时存在 `package-lock.json`（更新）与 `pnpm-lock.yaml`（陈旧），实际以 npm 管理。
- **改进目标**：统一为 pnpm（加 `packageManager` 字段、`pnpm-lock.yaml` 重新生成）或在 README 明确"使用 npm"，删掉无用 lockfile。
- **预期效果**：依赖树单一可信，CI 可复现；与文章"pnpm 做包管理"一致（纯工程规范，非功能差异）。

---

## 四、已覆盖 / 已更优项（无需改动，建议在文档中点明）

- **Ink+React TUI**：不仅覆盖，还多了 cfonts 电影级 splash、状态栏、`@inkjs/ui` 主题、应用内滚动，属先进实现。
- **better-sqlite3 → node:sqlite**：easyCLI 用 Node 22 内置 `DatabaseSync`，**零依赖、免原生编译**，同步 API 语义等价。建议在 README/学习文档写清"为何不用 better-sqlite3"——这是 Node 22 项目的更优解，不是缺口。
- **commander / chalk / tsup / vitest / Skill 三级加载**：均完整覆盖，Skill 系统还多了渐进式披露与自动注入。

---

## 五、落地优先级建议

1. **P0（真实缺口）**：差异 1（MCP 客户端 HTTP 传输）、差异 2（引入 fast-glob 替换手写 glob）。
2. **P1（健壮性提升）**：差异 3（zod 扩展校验）、差异 4（undici dispatcher 支持 LLM 代理）。
3. **P2（功能对齐）**：差异 5（Multi-Agent 角色+依赖）、差异 6（Plan-and-Execute 独立模块）。
4. **P3（风格/规范）**：差异 7（AsyncGenerator 包装）、差异 8（统一包管理器）。

> 注：以上为分析 + 方案，未改动任何代码。如需，我可按 P0→P1 顺序逐条实现并补对应单测。
