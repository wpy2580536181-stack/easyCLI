# 第 18 期学习文档：联网搜索工具（web_search / web_fetch）

## 0. 本期在全局路线图中的位置

Phase 18 给 easyCLI 装上一对「联网工具」——`web_search`（实时检索网页标题/链接/摘要）+ `web_fetch`（抓取网页正文）。这是 Agent 从「只懂本地文件与记忆」迈向「能查外部实时信息」的关键一步，也是路线图里 Agent 能力闭环的延伸。本期方案**参考 `paicli-ts` 的联网搜索实现**设计，但完全落地到 easyCLI 既有的 `ToolDef + ToolRegistry + executeTools` 抽象上，**不改动 Agent 循环与 LLM 适配层**。

```mermaid
flowchart LR
  P17[Phase17<br/>Multi-Agent] --> P18[Phase18<br/>联网搜索]
  P18 --> P19[Phase19<br/>Browser(CDP)]
  P18 -.复用.-> REG[ToolRegistry<br/>+ ToolDef 契约]
  P18 -.Provider 无关.-> PROV{{SearchProvider<br/>Tavily/DuckDuckGo}}
  P18 -.信号/重试.-> BUS{{AbortSignal.any<br/>+ classifyFetchError}}
```

## 1. 本节完成了什么（交付物）

| 文件 | 类型 | 作用 |
|---|---|---|
| `src/core/tools/web/types.ts` | **新增** | 核心类型：`SearchProvider` / `SearchResult` / `SearchOptions`（工具外壳与搜索服务解耦的契约） |
| `src/core/tools/web/fetch-util.ts` | **新增** | `combinedSignal()`（`AbortSignal.any` 组合用户中断 + 超时，修正 paicli 中断无效）+ `fetchSearch()`（网络错误重试 1 次、429 单独提示，复用 `classifyFetchError`） |
| `src/core/tools/web/providers/duckduckgo.ts` | **新增** | `DuckDuckGoProvider`：抓 DuckDuckGo HTML 正则解析，**零 key 兜底**（移植自 paicli） |
| `src/core/tools/web/providers/tavily.ts` | **新增** | `TavilyProvider`：正式搜索 API（`POST /search` + Bearer，需 key，质量更高更稳定） |
| `src/core/tools/web/factory.ts` | **新增** | `createSearchProvider(cfg)`：按 `config.search.provider` 选实现；tavily 无 key 自动降级 duckduckgo |
| `src/core/tools/web/index.ts` | **新增** | `getWebTools(cfg)`：导出 `web_search` + `web_fetch` 两个标准 `ToolDef`（均 `isReadOnly:true`） |
| `src/config/index.ts` | 修改 | `AppConfig.search`（Provider 无关配置）+ `SearchConfig` 类型 + `loadConfig`/`appConfigToUserConfig` 合并与落盘 |
| `src/config/store.ts` | 修改 | `userConfigSchema` 增加 `search` 的 zod 分支；`UserConfig.search` |
| `src/cli/main.ts` | 修改 | `--search-provider` / `--search-key` / `--search-max-results` 旗标；`createToolRegistry()` 后 `registerAll(getWebTools(config.search))`；tavily 无 key 时打印降级提示 |
| `src/core/prompts/index.ts` | 修改 | `toolPolicyBlock()` 增补「何时该联网检索」的使用政策 |
| `tests/unit/web-search.test.ts` | **新增** | 19 个单测：Tavily/DuckDuckGo 解析、工厂降级、工具外壳、组合信号、错误/重试、空结果 |

> 真机验证路径：`tsc --noEmit` 干净；**全量 276 个单测全绿**（本期新增 19）；`tsup` 构建通过；冒烟确认 `search` 配置合并正确、`web_search`/`web_fetch` 已注册进 `ToolRegistry`、`isReadOnly:true`、JSON Schema 正确。

## 2. 核心概念速览（先看这个）

- **`SearchProvider` 抽象（Provider 无关）**：把「搜索服务」与「工具外壳」解耦，仿照项目既有的 `ChatModel` / `Embedder` 哲学。两个内置工具 `web_search` / `web_fetch` 只依赖 `SearchProvider` 接口，不关心底层是 Tavily 还是 DuckDuckGo。
- **零 key 兜底 + 正式 API 双实现**：`DuckDuckGoProvider` 抓 HTML、无需任何 key，保证开箱即用；`TavilyProvider` 调正式搜索 API、质量更高，需 `apiKey`。二者实现同一接口，靠工厂切换。
- **标准 `ToolDef` 外壳**：工具就是 `ToolDef`（`name/description/inputSchema/isReadOnly/execute`），经 `getWebTools(cfg)` 工厂闭包注入 `SearchConfig` 后 `registerAll` 进同一张表；因 `isReadOnly:true`，执行器自动并行执行且默认放行（无需权限审批）。
- **组合中断信号**：`combinedSignal(ctx.signal, timeoutMs)` 用 `AbortSignal.any` 把「执行器注入的用户 Ctrl-C 信号」与「工具自身超时」合并——修正 paicli 只用自建 timeout、用户无法中断搜索的缺陷。
- **网络错误重试一次**：`fetchSearch` 对「网络层失败」（连接超时/DNS/掉线）重试 1 次（退避 500ms）；用户中断（abort）与 HTTP 错误（含 429 限流）不重试、直接给可读错误。
- **统一优先级配置**：搜索配置纳入 `AppConfig.search`，走既有「CLI > 环境变量 > 配置文件 > 默认值」四层合并，key 用 `maskSecret` 打码。

## 3. 设计方案与原理

### 3.1 参考对象：paicli-ts 的联网搜索实现

> 本期方案的设计蓝本。先吃透它，才能知道哪些该吸收、哪些该修正。

**架构设计**：paicli-ts 把「网络能力」做成两个内置工具，放在 `src/tools/builtins/` 下：

| 文件 | 工具 | 职责 |
|---|---|---|
| `WebSearchTool.ts` | `web_search` | 输入 query，返回若干「标题 + URL + 摘要」 |
| `WebFetchTool.ts` | `web_fetch` | 输入 url，抓取网页正文并做 HTML→文本提取 |
| `webInputGuard.ts` | — | 「网页输入纠偏」中间件：当用户消息里显式给了域名/URL 时，纠正 LLM 幻觉出的错误 host |

工具经 `buildTool()` 工厂（`src/tools/Tool.ts`）统一生产，实例进 `ToolRegistry`，由 `StreamingToolExecutor` 调度执行。整体是清晰的「工厂 → 注册表 → 执行器」三段式。

**核心模块**：
- **`buildTool(config)`（`src/tools/Tool.ts`）**：统一生命周期工厂。产出的 `Tool` 具备 `validate()`（zod safeParse）、`getDefinition()`（zod → JSON Schema，喂给 LLM function calling）、`execute()` / `executeStream()`（支持 `Promise<Chunk>` 或 `AsyncGenerator<Chunk>` 两种返回）。`meta` 里含 `dangerLevel`、`requiresApproval`、`timeout`。
- **`WebSearchTool`**：`inputSchema = { query: string, maxResults?: number(默认5) }`，`isReadOnly: true`、`isConcurrencySafe: true`。`call` 内部逻辑：拼 URL → `fetch` → `!res.ok` 返回错误 chunk → `res.text()` → 正则解析 → 截断 `maxResults` → 格式化输出。
- **`webInputGuard`**：`normalizeWebToolInput(toolName, input, userMessage)` 从用户原文用正则抽取显式 URL/域名，若 LLM 填错 host 则纠正（`web_fetch` 改 url、`web_search` 往 query 里补 host）。这是防幻觉的实用增强。

**API 调用流程（现状 = 占位实现）**：
```
web_search(query, maxResults)
  → url = https://duckduckgo.com/html/?q=<encodeURIComponent(query)>
  → fetch(url, { headers:{'User-Agent':'PaiCLI/0.1.0'}, signal: AbortSignal.timeout(15_000) })
  → if(!res.ok) return {content:`Search HTTP ${status}`, isError:true}
  → html = res.text()
  → parseDuckDuckGoResults(html)  // 正则匹配 result__a / result__snippet，再 stripTags + decodeHtml
  → .slice(0, maxResults)
  → 格式化：`${i+1}. ${title}\n${url}\n${snippet}` 用 \n\n 连接
```

**关键结论**：这是抓取 DuckDuckGo HTML 页面的**占位实现**——无 API Key、无独立配置、无重试、超时写死 15s，且**没用执行器传入的中止信号**（用自建 `AbortSignal.timeout`，用户 Ctrl-C 中断不了搜索）。不是对接 Tavily/Brave/SerpAPI 这类正式搜索服务。设计 easyCLI 方案时**吸收其工具化框架，修正其实现缺陷**。

**配置 / 错误处理 / 注册**：paicli-ts 的搜索工具**没有任何独立配置**（URL、UA、超时全硬编码，全局配置无 `SearchConfig`）；错误处理仅工具内 `try/catch` 转 `isError` chunk，无重试、无分类；注册靠 zod schema 经 `getDefinition()` 转 JSON Schema 喂给 LLM，统一进 `ToolRegistry`，`isReadOnly` 工具默认放行可并发。

### 3.2 easyCLI 现有结构与接入点

easyCLI 已有一套**成熟、Provider 无关**的工具抽象，新增搜索工具无需触碰 Agent 循环或 LLM 适配层：

| 接入点 | 文件 | 说明 |
|---|---|---|
| 工具类型 | `src/core/chatmodel/types.ts` | `ToolDef { name, description, inputSchema(JSON Schema), isReadOnly?, isDestructive?, execute(args, ctx) }`；`ToolContext { cwd, signal? }`；`ToolResult { ok, output }` |
| 内置工具 | `src/core/tools/builtin.ts` | `getBuiltinTools(): ToolDef[]`，每个工具是纯对象 + 一个 `(args, ctx) => Promise<ToolResult>` 函数；用 `ok()/fail()` 辅助 |
| 注册表 | `src/core/tools/registry.ts` | `createToolRegistry()` 里 `registerAll(getBuiltinTools())` |
| 执行器 | `src/core/tools/executor.ts` | 只读工具并行（上限 10）、写串行；try/catch 兜底；emit 事件 |
| 配置类型/合并 | `src/config/index.ts` | `AppConfig`；`loadConfig(overrides, fileConfig)`；`firstNonEmpty` 按「CLI > env > file > 默认」合并 |
| 配置持久化 | `src/config/store.ts` | zod `userConfigSchema` 校验 + JSON 落盘 `~/.config/agent-cli/config.json`；`maskSecret` |
| 装配入口 | `src/cli/main.ts` | 加载配置 → `createChatModel` → `createToolRegistry` → 各种 `registerAll` |
| 系统提示词 | `src/core/prompts/index.ts` | `toolPolicyBlock()` 里声明可用工具及使用政策 |
| HTTP 范型 | `src/core/rag/embedder.ts` | 原生 `fetch` + Bearer 鉴权 + `res.ok` 检查 + JSON 解析 的干净范例 |
| 错误分类 | `src/core/chatmodel/errors.ts` | `classifyFetchError(err, op)` 识别 network/abort/http，可复用 |

**两处关键差异（决定移植方式）**：
1. easyCLI 的 `ToolDef.inputSchema` 是**手写 JSON Schema**（不像 paicli 用 zod）。→ 搜索工具直接写 JSON Schema 即可，无需引 zod-to-json-schema。
2. easyCLI 的 `execute(args, ctx)` 里 **`ctx.signal` 是执行器统一注入的中止信号**。→ 必须把 `ctx.signal` 传进 `fetch`（修正 paicli 的缺陷），实现用户可中断。

### 3.3 总体设计原则与模块划分

**设计原则**：
1. **Provider 抽象**：定义 `SearchProvider` 接口，把「搜索服务」与「工具外壳」解耦。默认提供 `TavilyProvider`（正式 API，推荐）+ `DuckDuckGoProvider`（零 key 兜底，移植自 paicli）。
2. **贴合 `ToolDef`**：`web_search` 就是一个标准 `ToolDef`（`isReadOnly: true`），不引入 paicli 的 `buildTool`/zod 体系，保持 easyCLI 风格一致。
3. **配置纳入 `AppConfig`**：新增 `search: SearchConfig`，走既有 `firstNonEmpty` 优先级合并 + zod 持久化校验。
4. **正确中断 + 独立超时 + 有限重试**：`fetch` 携带 `ctx.signal`，用 `AbortSignal.any` 组合执行器信号与超时信号；对网络类错误做 1 次重试。
5. **`web_fetch` 同批实现**：一并移植网页抓取工具（同样标 `isReadOnly`），与搜索形成「搜 → 取正文」闭环。

**模块划分（实际落地文件）**：
```
src/core/tools/
├── web/
│   ├── types.ts          # SearchProvider 接口 + SearchResult / SearchOptions 类型
│   ├── fetch-util.ts     # combinedSignal(ctx.signal, ms) + fetchSearch(网络重试/429 提示)
│   ├── providers/
│   │   ├── tavily.ts     # Tavily API Provider（推荐，需 key）
│   │   └── duckduckgo.ts # DuckDuckGo HTML Provider（零 key 兜底，移植 paicli 正则解析）
│   ├── factory.ts        # createSearchProvider(cfg): 按 config.search.provider 选择实现
│   └── index.ts          # getWebTools(cfg): ToolDef[]  —— 导出 web_search / web_fetch
```
配置层改动：`src/config/index.ts`（类型 + 合并 + 落盘）、`src/config/store.ts`（zod）、装配 `src/cli/main.ts`、`src/core/prompts/index.ts`（工具政策）。

### 3.4 接口设计

**`src/core/tools/web/types.ts`**
```ts
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  maxResults: number;
  signal?: AbortSignal;   // 来自 ToolContext.signal，支持用户中断
}

export interface SearchProvider {
  readonly name: string;                       // 'tavily' | 'duckduckgo'
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>;
}
```

**配置类型（`src/config/index.ts`）**
```ts
export interface SearchConfig {
  provider: 'tavily' | 'duckduckgo';   // 默认 duckduckgo（零 key）
  apiKey?: string;                     // tavily 必填
  maxResults?: number;                 // 默认 5
  timeoutMs?: number;                  // 默认 15000
}
// AppConfig 增加：search: SearchConfig;   // 默认零 key 的 duckduckgo，开箱即用
```

**工具外壳（`src/core/tools/web/index.ts`）** —— 标准 `ToolDef`，靠 `getWebTools(cfg)` 闭包注入配置：
```ts
export function getWebTools(cfg: SearchConfig): ToolDef[] {
  const provider = createSearchProvider(cfg);
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  const defaultMax = cfg.maxResults ?? 5;
  return [
    {
      name: 'web_search',
      description: '联网搜索：给定查询词，返回若干网页的标题、链接与摘要。当问题涉及实时信息、最新事件、你不确定或可能过期的外部知识时，应先调用它检索再据此回答。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          maxResults: { type: 'number', description: '返回结果数（默认 5，受配置上限约束）' },
        },
        required: ['query'],
      },
      isReadOnly: true,
      isDestructive: false,
      async execute(args, ctx) {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) return fail('缺少参数 query');
        const maxResults = typeof args.maxResults === 'number' && args.maxResults > 0
          ? Math.min(args.maxResults, defaultMax) : defaultMax;
        try {
          const results = await provider.search(query, { maxResults, signal: ctx.signal });
          if (results.length === 0) return ok(`未找到关于「${query}」的搜索结果。`);
          return ok(results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n'));
        } catch (e) {
          return fail(`搜索失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
    // web_fetch 同理（isReadOnly:true，传 combinedSignal(ctx.signal, timeoutMs)，支持 maxLength 截断）
  ];
}
```

**中断 + 超时组合（`fetch-util.ts`）** —— 修正 paicli 的缺陷：
```ts
export function combinedSignal(userSignal: AbortSignal | undefined, ms: number): AbortSignal {
  if (!userSignal) return AbortSignal.timeout(ms);
  return AbortSignal.any([userSignal, AbortSignal.timeout(ms)]);
}
```

### 3.5 与现有 CLI 框架的集成

1. **装配（`src/cli/main.ts`）**：在 `const tools = createToolRegistry();` 之后加一行 `tools.registerAll(getWebTools(config.search));`（放在 memory/rag/skill/mcp 注册附近，位置无所谓，Map 去重按 name）。tavily 无 key 时 `console.warn` 一次降级提示。
2. **Agent 循环无改动**：`web_search` 是标准 `ToolDef`，`runAgent` → `model.complete(tools=...)` → `executeTools` 自动识别并调度。因 `isReadOnly: true`，执行器会**并行执行 + 默认权限放行**，无需审批。
3. **LLM function 声明无改动**：`openai-compatible.ts` 的 `toOpenAITool` 直接读 `inputSchema`，手写 JSON Schema 即可被识别。
4. **系统提示词（`prompts/index.ts` 的 `toolPolicyBlock`）**：增补——「若已提供 web_search 工具（联网搜索），当问题涉及实时信息、最新事件、你不确定或可能过期的外部知识时，应先调用 web_search 检索，再据此回答；需要某条结果的网页正文时用 web_fetch。」

### 3.6 配置管理策略

沿用 easyCLI 既有的「CLI > env > file > 默认」四层优先级：

| 层级 | 搜索相关键 |
|---|---|
| CLI 参数 | `--search-provider tavily`、`--search-key <key>`、`--search-max-results <n>`（新增到 commander + `ConfigOverrides`） |
| 环境变量 | `AGENTCLI_SEARCH_PROVIDER`、`AGENTCLI_SEARCH_API_KEY`、`AGENTCLI_SEARCH_MAX_RESULTS`、`AGENTCLI_SEARCH_TIMEOUT_MS` |
| 配置文件 | `config.json` 的 `search: { provider, apiKey, maxResults, timeoutMs }`（`userConfigSchema` 加 zod 校验） |
| 默认值 | `{ provider: 'duckduckgo', maxResults: 5, timeoutMs: 15000 }`（零 key 即可用） |

- key 用 `maskSecret` 展示（`/config` 命令、状态栏），绝不打明文。
- 无 key 时自动降级到 `duckduckgo`，保证「开箱即用」；配了 tavily key 则用正式 API（质量更高、更稳定）。
- 落盘遵循 store.ts 约定：**仅当偏离默认**（非 duckduckgo，或显式改 `maxResults`/`timeoutMs`，或有 key）才写文件，避免把零 key 默认配置写进 `config.json` 造成冗余。

### 3.7 错误处理机制

1. 工具内 `try/catch` → 统一返回 `{ ok: false, output }`（遵循 easyCLI 约定，工具**不抛未捕获异常**）。
2. Provider 内部：`!res.ok` → 抛带状态码的 `Error`；用 `classifyFetchError`（复用 `chatmodel/errors.ts`）区分 network/abort/http。
3. **有限重试**：仅对 `kind === 'network'`（连接超时、DNS 失败等）重试 1 次，退避 500ms；`abort`（用户中断/超时）和 4xx 不重试。
4. **限流（429）**：单独提示「搜索服务限流，请稍后重试或配置 API key」。
5. 用户中断（Ctrl-C）：`ctx.signal` 触发 → fetch 抛 `AbortError` → 返回「搜索失败: 请求已被中断」，不当作崩溃。

### 3.8 对 paicli 实现的三点修正（已内建）

1. **中断信号**：paicli 用自建 `AbortSignal.timeout` 忽略执行器信号；本方案用 `combinedSignal(ctx.signal, ms)` 让用户 Ctrl-C 能真正中断搜索。
2. **配置缺失**：paicli 搜索无任何配置；本方案纳入 `AppConfig.search`，走统一优先级 + zod 校验 + 打码展示。
3. **无重试/无分类**：本方案对网络类错误重试 1 次、429 单独提示、abort 友好返回，复用既有 `classifyFetchError`。

## 4. 为什么这样设计（设计权衡）

| 决策点 | 选择 | 反方案 | 理由 |
|---|---|---|---|
| 搜索服务实现 | `SearchProvider` 接口 + Tavily/DuckDuckGo 双实现 | 硬编码单一搜索服务 | 解耦工具与具体服务；可零 key 起步、按需升级；符合 ChatModel/Embedder 的 Provider 无关范式 |
| 零 key 兜底 | 默认 `duckduckgo`，无需配置即可用 | 必须配 key 才能启动 | 开箱即用、降低上手门槛；有 key 再切 Tavily 提质量 |
| 中断信号 | `AbortSignal.any(用户信号, 超时)` | 像 paicli 只用 `AbortSignal.timeout` | paicli 缺陷：用户 Ctrl-C 中断不了搜索；合并后用户信号真正生效 |
| 网络错误 | 重试 1 次（退避 500ms） | 完全不重试 | 搜索服务偶发抖动常见，一次重试即可显著降低毛刺；但 abort/http 不重试，避免无意义重试 |
| 配置位置 | 纳入 `AppConfig.search` 走统一优先级 | 把 URL/UA/超时硬编码在工具里 | 与项目「CLI>env>file>默认」约定一致；key 可走 env 注入、可打码、可持久化 |
| 工具形态 | 标准 `ToolDef`（手写 JSON Schema） | 引入 paicli 的 `buildTool`+zod 体系 | 保持 easyCLI 风格统一；不引 zod-to-json-schema，依赖更克制；执行/权限/并行模型零改动 |
| `web_fetch` | 与 `web_search` 同批实现 | 只做搜索 | 「搜→取正文」是高频闭环；两者都是只读、可并行，成本极低 |

## 5. 与其它方案对比（优势）

| 维度 | 本期方案 | paicli-ts 原实现 | 说明 |
|---|---|---|---|
| 搜索后端 | Provider 抽象（Tavily 正式 / DuckDuckGo 兜底） | 仅 DuckDuckGo HTML 抓取的占位实现 | 本期可接正式 API，质量/稳定性更高 |
| 配置 | `AppConfig.search` 四层优先级 + zod + 打码 | 无配置，全硬编码 | 本期符合项目配置约定，可持久化 |
| 用户中断 | `AbortSignal.any` 组合信号，可中断 | 自建 timeout，Ctrl-C 无效 | 本期修正 paicli 缺陷 |
| 重试/错误分类 | 网络错误重试 1 次、429 提示、复用 `classifyFetchError` | 无重试、无分类 | 本期更健壮 |
| 与 Agent 集成 | 标准 `ToolDef`，执行器自动并行+放行 | `buildTool`+zod 体系 | 本期零侵入复用既有管道 |
| 依赖 | 仅原生 `fetch`，零新增搜索库 | 仅原生 `fetch` | 都克制；本期未引搜索 SDK |

## 6. 面试话术（30 秒版 + 详版）

**30 秒版：**
> 我在 easyCLI 加了联网搜索工具：一对 `web_search`（检索标题/链接/摘要）和 `web_fetch`（抓网页正文），让 Agent 能查实时外部信息。核心是把「搜索服务」抽象成 `SearchProvider` 接口——默认用零 key 的 DuckDuckGo 兜底，配了 key 就切到 Tavily 正式 API。两个工具都是项目既有的标准 `ToolDef`，靠工厂闭包注入配置后进 `ToolRegistry`，执行器自动并行、默认放行，完全没改 Agent 循环。我重点修正了参考实现 paicli 的三个缺陷：用 `AbortSignal.any` 组合用户中断信号（否则 Ctrl-C 断不了搜索）、把配置纳入统一优先级体系、对网络错误重试一次并复用错误分类。

**详版（被追问时）：**
> 为什么抽象成 Provider？搜索后端很多（Tavily/Brave/SerpAPI/甚至自抓 HTML），硬编码会绑死一个。抽象接口后，工具外壳只依赖 `search(query)` 契约，换后端零改动——和项目里 `ChatModel`/`Embedder` 的 Provider 无关哲学一致。
> 为什么默认 DuckDuckGo 零 key？降低上手门槛，开箱即用；但要质量/稳定就配 Tavily key，工厂自动切换，无 key 还选 tavily 会降级回 DuckDuckGo 并 warn。
> 中断怎么保证？参考实现 paicli 只用 `AbortSignal.timeout`，把执行器注入的 `ctx.signal` 丢了——用户 Ctrl-C 断不掉搜索。本期用 `AbortSignal.any([ctx.signal, timeout])`，用户信号一来 fetch 立刻中止。
> 重试怎么控？只在「网络层失败」（连接超时/DNS/掉线，靠 `classifyFetchError` 判定）重试 1 次、退避 500ms；用户中断和 4xx（含 429 限流）不重试——避免无意义的反复请求。
> 配置放哪？放进 `AppConfig.search`，走项目既有「CLI>env>file>默认」合并，key 用 `maskSecret` 打码、不落明文。

## 7. 常见面试题（附答题要点）

1. **搜索功能为什么抽成 `SearchProvider` 而不是直接在工具里写 fetch？**
   答：解耦「工具外壳」与「搜索后端」。后端可替换（Tavily/DuckDuckGo/未来 Brave）、可零 key 起步；工具只依赖 `search()` 契约，新增后端不改工具。与 ChatModel/Embedder 的 Provider 无关范式一致。

2. **默认为什么用 DuckDuckGo 而不是必须配 Tavily？**
   答：开箱即用、降低门槛。DuckDuckGo 是抓 HTML、零 key；Tavily 是正式 API、质量高但需 key。配了 key 工厂自动切；没 key 硬选 tavily 会降级回 DDG 并提示。

3. **paicli 的搜索中断有什么问题？本期怎么修的？**
   答：paicli 只用 `AbortSignal.timeout(15_000)`，忽略了执行器传入的 `ctx.signal`，用户 Ctrl-C 断不了搜索。本期用 `AbortSignal.any([ctx.signal, timeout])` 把用户信号和超时组合，任一触发即中止。

4. **哪些错误会重试？哪些不会？**
   答：仅「网络层失败」（连接超时/DNS/掉线，经 `classifyFetchError` 判 `kind==='network'`）重试 1 次；用户中断（abort）和 HTTP 错误（含 429 限流）不重试——abort 重试没意义，4xx 重试通常也无效。

5. **搜索结果数量谁说了算？**
   答：工具参数 `maxResults` 与配置 `search.maxResults`（默认 5）取较小者（`Math.min`），既让模型按需调小，又受配置上限约束，防止一次拉太多。

6. **工具加了联网能力，Agent 循环要改吗？**
   答：不用。两个工具都是标准 `ToolDef`（`isReadOnly:true`），`registerAll` 进 `ToolRegistry` 后，ReAct 循环与 LLM function 声明照常识别、执行器自动并行+默认放行。

7. **配置 key 会泄露到终端或文件吗？**
   答：不会。key 走 env（`AGENTCLI_SEARCH_API_KEY`）或 `config.json`，展示用 `maskSecret` 打码；落盘时仅偏离默认（非 duckduckgo/有 key/改了 maxResults/timeoutMs）才写，且不会写明文到日志。

## 8. 关键代码索引

| 功能 | 位置 |
|---|---|
| Provider 契约 | `src/core/tools/web/types.ts` → `SearchProvider` / `SearchResult` / `SearchOptions` |
| 中断+重试封装 | `src/core/tools/web/fetch-util.ts` → `combinedSignal` / `fetchSearch` |
| 零 key 兜底 | `src/core/tools/web/providers/duckduckgo.ts` → `DuckDuckGoProvider`（`parseDuckDuckGoResults` / `normalizeDuckDuckGoUrl` / `decodeHtml`） |
| 正式 API | `src/core/tools/web/providers/tavily.ts` → `TavilyProvider`（`POST /search` + Bearer） |
| Provider 工厂 | `src/core/tools/web/factory.ts` → `createSearchProvider`（tavily 无 key 降级 DDG） |
| 工具外壳 | `src/core/tools/web/index.ts` → `getWebTools`（web_search + web_fetch） |
| 配置类型/合并 | `src/config/index.ts` → `SearchConfig` / `AppConfig.search` / `loadConfig` / `appConfigToUserConfig` |
| 配置持久化 | `src/config/store.ts` → `userConfigSchema.search`（zod）+ `UserConfig.search` |
| 装配+旗标 | `src/cli/main.ts` → `--search-*` 旗标 + `registerAll(getWebTools(config.search))` |
| 工具政策 | `src/core/prompts/index.ts` → `toolPolicyBlock` 增补联网检索政策 |
| 错误分类（复用） | `src/core/chatmodel/errors.ts` → `classifyFetchError` |
| 单测 | `tests/unit/web-search.test.ts` |

## 9. 踩坑与细节（来自真实实现）

1. **`appConfigToUserConfig` 落盘误判默认**：最初条件是 `s.maxResults !== 5`，但 `s.maxResults` 为 `undefined` 时 `undefined !== 5` 为 `true`，导致「默认 duckduckgo」也被写进 `config.json`。**修复**：先判「已显式设置」——`s.maxResults !== undefined && s.maxResults !== 5`（timeoutMs 同理），只有真正偏离默认才落盘。

2. **Provider 相对路径多一层**：`providers/duckduckgo.ts` 在 `src/core/tools/web/providers/` 下，引用 `src/config` 需要 `../../../../config`（比 `web/` 下多一层），一开始写成 `../../../config` 报 `Cannot find module`。**教训**：深层目录的相对导入要数对 `../` 层数。

3. **`ToolDef.execute` 是可选属性**：测试里写 `search.execute(...)` 因 `ToolDef.execute?` 可选被判为 `possibly undefined`。**处理**：对解构出的工具加 `!` 非空断言（`const search = getWebTools(cfg)[0]!`），调用处 `search.execute!(...)`。真实执行器已先判 `tool.execute` 存在。

4. **组合中断信号**：`combinedSignal` 用 `AbortSignal.any` 合并用户信号与超时——这是修正 paicli「用户 Ctrl-C 断不了搜索」的关键。注意 `AbortSignal.any` 在 Node 18+ 可用（项目 target node22）。

5. **DuckDuckGo 真实地址藏在 `uddg` 参数**：结果链接是 `https://duckduckgo.com/l/?uddg=<encoded>`，需 `decodeURIComponent(uddg)` 还原成真实 URL，否则工具返回的是 DDG 跳转链接。

6. **网络重试判定靠 `classifyFetchError`**：`fetchSearch` 用 `classifyFetchError(err, op)` 区分 `network`/`abort`/`http`；只对 `network` 重试 1 次。`TypeError('fetch failed')`、各种 `UND_ERR_*`、`ENOTFOUND` 等都被归为 network，统一重试。

## 10. 自测题（检验是否真懂）

1. 本期把搜索后端抽象成了什么接口？默认用哪个后端、为什么？（答案：`SearchProvider`；默认 DuckDuckGo，零 key 开箱即用）
2. `combinedSignal` 解决了 paicli 的什么缺陷？（答案：paicli 只用自建 timeout、忽略执行器 `ctx.signal`，用户 Ctrl-C 断不了搜索；本期用 `AbortSignal.any` 组合用户信号+超时）
3. 哪些错误会重试、哪些不会？（答案：仅 network 类重试 1 次；abort/http/429 不重试）
4. 给 Agent 加了联网工具，要改 ReAct 循环或 LLM 适配器吗？（答案：不用；标准 `ToolDef` 进 `ToolRegistry`，执行器自动并行+放行）
5. `config.json` 里没写 `search`，会用哪个后端、key 从哪来？（答案：默认 duckduckgo、零 key；若要 Tavily，从 `AGENTCLI_SEARCH_API_KEY` 或 `config.json` 的 `search.apiKey` 来）
6. 为什么 `appConfigToUserConfig` 落盘要判断「已显式设置」而非直接比较默认值？（答案：未设置的字段是 `undefined`，`undefined !== 5` 为 true 会误判成「偏离默认」而把零 key 默认配置写进文件）

## 11. 延伸与下一步

- **`webInputGuard` 输入纠偏（本次未做，P2）**：移植 paicli 的 `webInputGuard`——当用户消息里显式给了域名/URL 而 LLM 填错 host 时纠偏。需在 Agent 循环拿到「用户原始消息」并在工具调用前 `normalizeWebToolInput`，改动面较大，按需再做。
- **首运行向导收集搜索 key（本次未做，P2）**：`src/cli/setup.ts` 首次运行向导可选收集搜索 `apiKey` 并落盘，降低配置门槛。
- **搜索结果缓存**：同一 query 在会话内多次出现时可加短 TTL 缓存，省 token/省请求。
- **Phase 19 Browser（CDP）**：用 CDP 真正渲染页面（JS 执行后的内容），可作为 `web_fetch` 的增强后端或对需要登录/动态内容的站点兜底；与本期搜索工具形成「搜 → 渲染取正文」更完整闭环。
- **可观测**：把 `web_search`/`web_fetch` 的调用耗时、成败挂到事件总线（决策 9），用 Phase 14 的 `CostTracker` 观测。

```mermaid
flowchart TD
  NOW[本期: SearchProvider 抽象<br/>+ web_search/web_fetch + 组合信号/重试] --> A[webInputGuard 输入纠偏]
  NOW --> B[首运行向导收集 key]
  NOW --> C[搜索结果缓存]
  NOW --> D[Phase19 Browser(CDP)<br/>增强 web_fetch 后端]
  NOW --> E[搜索调用挂事件总线观测]
```
