# MCP 手写实现 → 官方 SDK 迁移计划

> 目标：把 `src/core/mcp/` 下全部手写实现替换为 `@modelcontextprotocol/sdk`（v1.x，生产稳定线），
> 同时保持**对外的工具契约、CLI 开关、配置格式、权限/审计路径完全不变**（无破坏性变更）。
> 本文档为迁移的执行蓝图，含：现状盘点、SDK 映射、行为对齐、分阶段步骤、影响范围、验证方案、待决策点、回滚预案。

---

## 0. 原则与红线

1. **行为不变**：`ToolDef` 形状、`McpServerSpec` 配置形状、`--mcp-serve/--mcp-transport/--mcp-port` 开关、MCP 工具进入 `ToolRegistry` 后走同一套执行器/权限/审计——这些对外契约一律不动。
2. **增量可编译**：每阶段结束都能 `typecheck + 跑通相关测试`，不出现"半截迁移"长期无法运行的中间态。
3. **测试驱动**：每迁一块，先让对应测试在 SDK 语义下重新通过（fixture 是裸协议服务器，可作为"对端互操作"证据保留）。
4. **文档同步**：`phase5.md` / `phase12.md` / `README.md` 内容随实现刷新，与 SDK 版本一致。

---

## 一、现状盘点（手写代码清单 + 功能）

### 1.1 核心手写文件（全部位于 `src/core/mcp/`）

| 文件 | 导出/符号 | 功能 |
|---|---|---|
| `client.ts` | `McpClient` 类 | 手写 MCP 客户端：stdio spawn 子进程 + 换行 JSON-RPC 2.0 + 连接状态机（`disconnected→initializing→ready→closed`）+ `connect/listTools/callTool/disconnect` + 请求-响应 id 配对 + 超时 + `failAll` + EPIPE 防护 |
| `client.ts` | `mcpToolsToToolDefs` | MCP 工具 → 项目 `ToolDef` 归一化（`execute` 内部转调 `client.callTool`），使远端工具伪装成本地工具 |
| `client.ts` | `connectMcpServers` | 批量连接多个 Server，逐个 try/catch 容错，工具注册进同一 `ToolRegistry`，返回客户端列表供退出回收 |
| `client.ts` | 类型 `McpServerSpec` / `McpClientOptions` / `McpTool` / `McpState` | 配置规格与协议报文类型 |
| `server.ts` | `McpServer` 类 | 传输无关协议层：`handleMessage` 唯一入口，分发 `initialize/ping/tools/list/tools/call/resources/list/resources/read/shutdown`；标准 JSON-RPC 错误码 + `McpError` |
| `server.ts` | `fromToolDefs` | `ToolDef` → MCP 工具桥（与 `mcpToolsToToolDefs` 反向）；`tools/call` 转调 `ToolDef.execute` 并收口 `{content,isError}` |
| `server.ts` | `McpResource` 接口 | 只读资源（如 `agent://clock`），`resources/read` 返回文本 |
| `stdio.ts` | `StdioTransport` | 逐行 JSON-RPC；readline 解析；优雅停机（等所有在途响应刷出再 `process.exit`） |
| `http.ts` | `HttpTransport` | Streamable HTTP 子集：`POST /mcp` + `Mcp-Session-Id` 会话头；回 `application/json`（**无 SSE 流、无 GET/DELETE**） |
| `demo-server.ts` | `startMcpServer` | 演示服务端：把 `getBuiltinTools()` 暴露为 MCP 工具 + 挂 `agent://clock` 资源；按 `transport` 选 stdio/http，阻塞进程 |

### 1.2 调用点（集成边界）

| 位置 | 用法 |
|---|---|
| `src/cli/main.ts:21-22` | `import { connectMcpServers, McpClient }` / `startMcpServer` |
| `src/cli/main.ts:111-116` | `--mcp-serve` 分支：`startMcpServer({ transport, port, cwd })`（早于模型配置，不进 Agent） |
| `src/cli/main.ts:216-221` | `connectMcpServers(config.mcpServers, tools, { timeoutMs, connectTimeoutMs }, console.log)` |
| `src/config/index.ts:7,133` | `import type { McpServerSpec }`；`parseMcpServers(raw)` 容错解析 |
| `src/config/store.ts:16,30` | `import type { McpServerSpec }`；写入配置 schema `mcpServers?` |
| `src/core/chatmodel/types.ts:56` | `ToolDef` 契约（迁移的"对齐基准"） |

### 1.3 测试与文档（受影响资产）

- 测试：`tests/unit/mcp.test.ts`（13 例，客户端）、`tests/unit/mcp-server.test.ts`（16 例，协议）、`tests/unit/mcp-server-integration.test.ts`（2 例，对端+HTTP）、`tests/fixtures/{fake,silent,lazy}-mcp-server.mjs`（裸协议服务器，可作 SDK 客户端的互操作对端）。
- 文档：`docs/phase5.md`（MCP 客户端学习文档，明确写"纯手写不引 SDK 为硬约束"）、`docs/phase12.md`（MCP Server 学习文档，同调性）、`README.md`（line 3 "纯手写"、line 19 能力描述、line 115/122 期数表、line 145/152 文档链接、line 171 目录结构）、`docs/phase25.md`（提及 `main.ts:216` MCP 注册位置）。

> ⚠️ **身份冲突（必读）**：项目定位是"从零手写学习"，`phase5/12` 把"不引 SDK"作为硬约束。完全替换会与这一叙事冲突——见第七节待决策点。

---

## 二、SDK 映射方案

选用 `@modelcontextprotocol/sdk@^1`（v1.x，生产稳定；v2 已拆包且仍 beta，不采用）。项目已依赖 `zod@^3`，与 SDK v1.x 一致。

### 2.1 客户端（替换 `client.ts`）

- 用 SDK 高层 `Client` + `StdioClientTransport`（stdio 类型）/ `StreamableHTTPClientTransport`（HTTP 类型）。
- 保留对外导出名 `connectMcpServers`、`mcpToolsToToolDefs`、`McpServerSpec`；`McpClient` 改为**薄门面**（内持 SDK `Client`，暴露 `connect/listTools/callTool/disconnect`，便于测试最小改动）。
- `mcpToolsToToolDefs` 重写：`client.listTools()` 返回 `{ tools:[{name,description,inputSchema,annotations}] }` → 映射为 `ToolDef`，`execute` 内 `const r = await client.callTool({name, arguments:args})`，把 `r.content`（text 块）拼成 `output`、`r.isError` → `ok`；`annotations.readOnlyHint/destructiveHint` → `isReadOnly/isDestructive`（与现逻辑一致）。
- 协议版本：SDK 自动做 `min(client, server)` 协商，替代写死的 `2024-11-05`（行为更稳，非破坏）。
- 超时/容错：`connectMcpServers` 保留"逐个 try/catch、失败告警不阻断"语义；SDK `Client` 自带超时与错误。

### 2.2 服务端（替换 `server.ts` + `stdio.ts` + `http.ts`）

- **推荐：低层 `Server`（`@modelcontextprotocol/sdk/server`）**，手动 `setRequestHandler('tools/list', ...)` / `setRequestHandler('tools/call', ...)` 返回现有 `ToolDef` 形状 + `{content,isError}` 收口。
  - 好处：`fromToolDefs` 几乎原样保留（`inputSchema` 继续用 JSON Schema，无需 zod 转换），`tool.execute(args, ctx)` 调用路径不变，**行为零漂移**。
  - 资源：`setRequestHandler('resources/list'/'resources/read', ...)` 或直接用高层 `registerResource` 挂 `agent://clock`。
- 传输：用 SDK `StdioServerTransport` 替换 `StdioTransport`；`StreamableHTTPServerTransport` 替换 `HttpTransport`（**附带获得 SSE 流式 + GET/DELETE 会话管理**，属能力扩展而非破坏）。
- `McpError` / `JsonRpcError`：交给 SDK 内部错误模型；移除手写错误码（错误语义等价）。
- `startMcpServer` 重写为：建 SDK `Server` → `fromToolDefs` 注册内置工具 + 注册 clock 资源 → 选 transport `.connect()` → 监听退出信号 `close()`。

> 备选（不推荐，需额外工作）：用高层 `McpServer.registerTool`（要 zod 输入 schema），则需把每个 `ToolDef.inputSchema`（JSON Schema）转 zod，引入 `json-schema-to-zod` 依赖与转换风险。低层 `Server` 路径规避此风险，优先采用。

### 2.3 配置（`config/index.ts` + `store.ts`）

- `McpServerSpec` 形状 `{ command, args?, env?, cwd? }` **保持不变**（用户配置零改动）。
- 仅在使用处把 `McpServerSpec` 映射到 SDK `StdioServerParameters`（`command/args/env` 直传；`cwd` 经 spawn options 或 `env` 传入）。`cwd` 在 SDK `StdioClientTransport` 中通过底层 spawn options 支持，需验证后接入。

---

## 三、行为对齐表（保证"无破坏性变更"）

| 维度 | 手写现状 | SDK 迁移后 | 是否破坏 |
|---|---|---|---|
| 工具名 | MCP 工具名 → `ToolDef.name` | 同名透传 | 否 |
| `ToolResult` 形状 | `{ ok, output }` | 同（`isError`→`ok`，text 块拼 `output`） | 否 |
| `isReadOnly/isDestructive` | 取自 `annotations` | 同 | 否 |
| 进入 `ToolRegistry` 后路径 | 执行器/权限/审计/总线 | 同（归一化层保留） | 否 |
| CLI 开关 | `--mcp-serve/--mcp-transport/--mcp-port` | 同 | 否 |
| 配置 `mcpServers` | `{command,args,env,cwd}[]` | 同 | 否 |
| 退出回收 | 手动 `killChild` | SDK `client.close()`（等价且更稳） | 否 |
| 协议版本 | 锁定 `2024-11-05` | 自动 `min` 协商 | 否（更兼容） |
| HTTP 传输 | 仅 `POST` + JSON，无 SSE | 增加 SSE 流式 + 会话生命周期 | 否（超集） |
| `agent://clock` 资源 | 只读文本 | 同（SDK resource） | 否 |

---

## 四、迁移步骤（分阶段，每阶段可独立编译+测试）

**Step 0 — 引入依赖**
- `npm i @modelcontextprotocol/sdk@^1`（managed 工作区隔离安装）。
- `package.json` 记录依赖；`README` 注明 MCP 不再"零额外依赖"。
- 验收：`typecheck` 通过，SDK 可 import。

**Step 1 — 客户端迁移（`client.ts`）**
- 新增 SDK `Client` + 传输；保留 `connectMcpServers` / `mcpToolsToToolDefs` 签名；`McpClient` 改门面。
- 改 `main.ts:216` 调用无感（签名不变）；退出处加 `await Promise.allSettled(clients.map(c=>c.close()))`。
- 验收：`mcp.test.ts` 重写后通过（`fake-mcp-server.mjs` 作为对端）；`main.ts` 接入点编译通过。

**Step 2 — 服务端 + 传输迁移（`server.ts` / `stdio.ts` / `http.ts` / `demo-server.ts`）**
- 用低层 `Server` + `setRequestHandler` 重建 `tools/call`/`tools/list`/`resources/*`；`fromToolDefs` 保留。
- `startMcpServer` 接 SDK `StdioServerTransport` / `StreamableHTTPServerTransport`。
- 验收：`mcp-server.test.ts` 重写后通过；`--mcp-serve --mcp-transport stdio|http` 手测可用。

**Step 3 — 配置接线收尾（`config/index.ts` / `store.ts`）**
- `McpServerSpec` → `StdioServerParameters` 映射；`cwd` 接入验证。
- 验收：`config.test.ts` 不受影响仍绿；`AGENTCLI_MCP_SERVERS` 端到端可用。

**Step 4 — 测试重写**
- `mcp.test.ts`（客户端，对端 `fake/silent/lazy` fixture）、`mcp-server.test.ts`（协议行为）、`mcp-server-integration.test.ts`（SDK Client ↔ CLI SDK Server；HTTP 段改 SDK `StreamableHTTPClientTransport` 或 fetch+session 头）。
- fixture 三个 `.mjs` **保留**（裸协议服务器，证明与官方 SDK 客户端互操作）。
- 验收：三套 MCP 测试全绿。

**Step 5 — 文档同步**
- 刷新 `phase5.md` / `phase12.md` 为 SDK 版（保留"历史：手写实现"折叠区以留存学习价值）；新增本计划 `mcp-sdk-migration-plan.md`；`README.md` 改能力描述/期数表/目录结构/"纯手写"措辞。
- 验收：文档与代码一致，链接有效。

**Step 6 — 全量验证 + 手动回归**
- 见第六节。

**Step 7 — 旧代码处置（见决策点）**
- 删除旧 `client/server/stdio/http.ts`（git 历史已留存）；或移至 `src/core/mcp/legacy/`。

---

## 五、影响范围评估

| 类别 | 范围 |
|---|---|
| 重写文件 | `src/core/mcp/{client,server,stdio,http,demo-server}.ts`（5） |
| 小幅改动 | `src/cli/main.ts`、`src/config/index.ts`、`src/config/store.ts`（3） |
| 测试重写 | `tests/unit/mcp.test.ts`、`mcp-server.test.ts`、`mcp-server-integration.test.ts`（3）；fixture 保留（3） |
| 文档 | `docs/phase5.md`、`phase12.md`、`phase25.md`、`README.md`、新增 `mcp-sdk-migration-plan.md` |
| 新增依赖 | `@modelcontextprotocol/sdk@^1`（zod 已存在） |
| 对外契约 | **不变**（工具名/形状/CLI/配置/权限路径） |
| 内部删除 | 手写状态机、JSON-RPC 配对、错误码、`McpState` 等（由 SDK 接管） |
| 能力扩展 | 多版本协商、HTTP SSE 流式、资源订阅（非破坏） |

**主要风险**
1. **身份/叙事冲突**：项目与 `phase5/12` 明确"纯手写不引 SDK"为硬约束。完全替换需重新定位（建议：保留手写文档为"历史/学习"，正文改为 SDK 版，并加一篇迁移说明）。
2. **依赖 footprint**：打破"MCP 零额外依赖"的自我宣称，需在 README 说明。
3. **HTTP 行为变化**：SDK HTTP 传输带来 SSE/GET/DELETE，集成测试的 session 流程需按 SDK 语义微调（非破坏）。
4. **`cwd` 透传**：SDK stdio 的 `cwd` 不是顶层字段，需经 spawn options 验证接入。
5. **structuredContent**：SDK `callTool` 可能返回 `structuredContent`；归一化层只取 text 块，binary/结构内容暂不暴露（与现状一致，可接受）。

---

## 六、验证方案

**自动化**
1. `npm run typecheck`（`tsc --noEmit`）——全量类型通过。
2. `npm test`（`vitest run`）——全量用例绿；重点 MCP 三套：
   - 客户端：连 `fake-mcp-server.mjs` → list/call/归一化为 `ToolDef`/与 `runAgent` 集成。
   - 服务端：SDK `Server` 注册内置工具 → SDK `Client` 调用 → 断言 `content/isError` 形状。
   - 集成：SDK `Client` ↔ 本项目 `--mcp-serve` 服务端（stdio + HTTP 两段）。
3. `npm run build`（`tsup`）——产物可启动。

**互操作证据（保留 fixture 的意义）**
- `fake/silent/lazy-mcp-server.mjs` 是**裸协议**服务器（非 SDK）。用 SDK `Client` 连它们仍通过，证明本项目迁移后**不丧失与任意标准 MCP 服务器的互操作**——这正是手写时代的设计目标，迁移后由官方 SDK 保证。

**手动回归**
- 启动服务端：`node dist/cli/main.js --mcp-serve --mcp-transport stdio &`，用任意标准 MCP 客户端（或 SDK Client 脚本）连接，确认 `tools/list` 含内置工具、`tools/call bash` 返回文本。
- 客户端消费：配置 `AGENTCLI_MCP_SERVERS='[{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}]'`，启动 CLI，确认 filesystem 工具进入 `ToolRegistry` 且经权限 gate 后被模型调用。
- 回归断言：新增一条测试，确认 MCP 工具与本地工具一样流经 `executeTools → 权限 resolve → 审计 emit`，路径无分叉。

**验收门禁**
- 全量测试绿 + 手动两端（serve/connect）可用 + 文档与代码一致 + 无对外契约变更 diff。

---

## 七、待决策点（需你确认）

1. **旧手写代码处置**：A) 直接删除（git 历史留存）；B) 移到 `src/core/mcp/legacy/` 保留为学习参考。**建议 B**，并在 `phase5/12` 加"历史：手写实现"折叠区。
2. **服务端用低层 `Server` 还是高层 `McpServer`**：本计划默认**低层 `Server`**（免 zod 转换、行为零漂移）。若你更想用官方推荐的高层 API，需接受引入 JSON-Schema→zod 转换。
3. **文档叙事**：是否接受把"纯手写"定位改为"先手写学习、后迁移官方 SDK"的双段叙事（影响 README 顶层描述与 `phase5/12` 调性）。

---

## 八、回滚预案

- 每阶段独立提交；若某阶段引入回归，可 `git revert` 该阶段提交回到上一可编译态。
- SDK 依赖在 Step 0 引入后若整体回退，删除依赖并 `git checkout` 相关文件即可整体还原手写实现（git 历史完整）。
- 测试 fixture 不删，保证"回滚后手写实现"仍有对端测试可跑。
