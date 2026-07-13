# TUI 界面层框架化重构设计文档（方案 A：基于 Ink）

> 状态：设计稿（待评审 → 实现）  
> 范围：`src/cli/` 下的终端界面层（渲染器 / 状态栏 / 状态行 / 输入框 / 自动上下文注入 UI）  
> 决策：采用 **Ink（React 声明式 TUI）** 重写界面层，取代当前手写 ANSI 自绘架构  
> 关联：本仓库既有 TUI 现状见 `docs/tui-current-state.md`（调研结论，见附录 A）



---

## 0. 本文档目的与阅读对象

本文档面向**开发团队**，目标是在不破坏现有 Agent 行为（ReAct / 工具 / MCP / RAG / 权限）的前提下，把"纯手写 ANSI 自绘"的 TUI 重构成"声明式、组件化、状态驱动"的 Ink 应用。

读完本文档，开发者应能直接进入实现：知道目录怎么分、组件树长什么样、状态放哪、事件怎么流、每个模块改什么、边界在哪、风险怎么兜底。

文档结构：

1. 项目概述
2. 现状分析与重构动机
3. 架构设计（总体 + Ink 应用方式）
4. 模块划分（职责 / 交互 / 依赖）
5. 数据流程
6. 接口定义
7. 技术细节（组件树 / 状态管理 / 渲染策略）
8. 可实施性（迁移策略 / 目录 / 边界条件 / 约束 / 测试）
9. 风险与对策
10. 附录

---

## 1. 项目概述

### 1.1 背景

easyCLI 是一个命令行 Agent CLI（仿 Claude Code）。当前 TUI 由三层独立组件构成，均**直接操作 `process.stdout` 的绝对定位转义序列**：

| 组件           | 文件                       | 职责                       | 占用区域                   |
| ------------ | ------------------------ | ------------------------ | ---------------------- |
| `StatusBar`  | `src/cli/statusbar.ts`   | 常驻底部状态条                  | 最底行，`setInterval` 每秒重绘 |
| `StatusLine` | `src/cli/status.ts`      | 流式正文 + 思考/工具/生成动画 footer | 中部 transcript，动画定时器驱动  |
| `LineEditor` | `src/cli/line-editor.ts` | 输入框 + 斜杠下拉 + HITL 审批     | 底部输入框盒子，raw mode 自绘    |

`markdown.ts` / `splash.ts` / `theme.ts` 为无状态"视图原料"，可保留。

### 1.2 重构目标

1. **消灭"三方绝对定位抢屏"的脆弱协调**：用 Ink 的约束布局（Yoga）替代手工 `footerRow/caret/reservedBottom` 几何计算。
2. **收口状态**：把散落在 `repl.ts` 闭包里的 `transcript/history/mode/busy/awaitingApproval` 等，提升为单一可测的状态源。
3. **组件化、可组合、可单测**：每个 UI 片段是组件，不再是命令式 `draw()` 方法。
4. **保留既有行为**：所有对外可见的交互（流式输出、状态栏字段、斜杠下拉、HITL y/n/a、Plan 模式切换、`--no-statusline`、`--auto-context`）必须等价保留。
5. **不引入运行期回归**：Agent 循环（`runAgent`）、工具系统、事件总线、配置、权限完全不动；仅替换"终端如何画"。

### 1.3 非目标（明确不做）

- 不改 `runAgent` / `ToolRegistry` / `EventBus` / 配置加载。
- 不做 RAG / 记忆 / 权限逻辑改动。
- 不重写 `markdown.ts` 的样式算法（保留为纯函数，仅改变"如何被布局"）。

---

## 2. 现状分析与重构动机（痛点）

> 本节基于 `src/cli/renderer.ts`、`statusbar.ts`、`status.ts`、`line-editor.ts`、`repl.ts`、`core/events/bus.ts` 的实读。

### 2.1 现状架构图

```
                         runAgent (核心循环, 不动)
                          │ onText / onToolCall / onToolResult
                          ▼
        repl.ts 闭包 ── 持有应用状态(transcript/history/mode/busy/...)
           │                         │                         │
           ▼                         ▼                         ▼
      StatusLine                StatusBar                  LineEditor
   (status.ts)               (statusbar.ts)             (line-editor.ts)
   手写 transcript 模型        绝对定位最底行             raw mode 自绘
   \x1b[1;1H\x1b[J 整段重绘    setInterval 每秒           input+dropdown+HITL
           │                         │                         │
           └──────── 三者各自 write(ESC…) 抢占同一条 process.stdout ──────┘
                    靠 setCaret()/reservedBottom/footerRow 手工协调光标/区域
```

### 2.2 三大痛点

**痛点 1：状态无单一真相。** 应用状态散布在 `repl.ts`/`runOnce` 闭包：`transcript: string[]`、`history: ChatMessage[]`、`mode`、`busy`、`awaitingApproval`、`autoCtxEnabled`、`pending[]`、`planCheckpoint`；`LineEditor` 内部还有 `input/hidden/asking`、`cursor/selIndex/dropdown`。多个来源（事件总线、runAgent 回调、键盘）改同一块输出，无集中 store，`repl.ts` 主循环**无法单测**。

**痛点 2：三方绝对定位抢屏的协调脆弱。** 三组件各自 `this.out.write('\x1b[H…')` 写屏，靠 `setCaret()`/`footerRow`/`reservedBottom`/`topReserve` 手工几何避免互相覆盖。代码注释里反复出现"状态栏被正文吞掉、输入框上侵欢迎框、下拉残留"等覆盖事故的修复记录——这是架构性脆弱，不是偶发 bug。

**痛点 3：渲染逻辑不可单测。** `StatusLine.render()` 直接依赖真实 `process.stdout.columns/rows`，transcript 整段重绘逻辑与"屏幕几何"强耦合，单测需 mock TTY。

### 2.3 为什么选 Ink（方案 A）而非自研 / blessed

- **Ink**：React 声明式 + Yoga 约束布局，diff 出最小 ANSI 更新；组件可组合、可单测（`render().lastFrame()`）；生态成熟。代价是引入 `react`+`ink`（但 MCP SDK 已破例，项目对"零依赖"已非硬约束，见 `CLAUDE.md` 最新约定）。
- **自研 / blessed**：保留命令式心智，但要么自己写渲染内核（工程量大），要么接笨重控件库。对"根治脆弱定位 + 可单测"目标，Ink 收益最高、路径最短。

> 方案 A 的核心权衡：**接受新依赖（`ink` + `react`），换取架构层面的脆弱性根除与可测试性**。这是本项目已接受"MCP 迁官方 SDK"之后，在 UI 层一致的务实取向。

---

## 3. 架构设计

### 3.1 总体架构（重构后）

```
                         runAgent (核心循环, 不变)
                          │ onText / onToolCall / onToolResult (回调)
                          ▼
        TUI Bridge ──dispatch──▶  AppStore (zustand, 单一状态源)
                          │                                  │
                          │ (subscribe)                       │ (read)
                          ▼                                  ▼
                   <App> 组件树 (Ink/React)          HITL/输入 命令式桥 (resolve promise)
                   Transcript / StatusBar /          ← LineEditor 逻辑迁入 <InputBox>
                   StatusLine / InputBox / Approval
                          │
                          ▼
                    Ink reconciler (Yoga 布局) → 最小 ANSI diff → stdout

   非 TTY（管道/测试）：不挂载 <App>，走既有 StreamRenderer 纯文本路径（保留 renderer.ts）
```

**关键变化**：状态从"repl.ts 闭包"移到 `AppStore`；三个组件不再各自写屏，而是作为 `<App>` 的子组件，由 Ink 统一布局与重绘；`repl.ts` 退化为"桥接层"——把 runAgent 回调 dispatch 进 store，并把键盘/HITL 结果经 store 回传。

### 3.2 Ink 在本项目的具体应用方式

- **挂载入口**：`startRepl` / `runOnce` 中，若 `process.stdout.isTTY` 为真，用 `render(<App store={store} .../>)` 挂载 Ink 应用；否则走既有 `StreamRenderer` 纯文本路径。
- **布局引擎**：Ink 内置 Yoga（Flexbox），替代手工 `footerRow/reservedBottom`。`<App>` 用 `flexDirection="column"`，自上而下：`Transcript`（占满剩余高度，`flexGrow:1`）→ `StatusLine`（footer，固定 1 行）→ `StatusBar`（最底 1 行）→ `InputBox`（输入区，按需出现）→ `Approval`（覆盖层）。
- **最小更新**：Ink 的 reconciler 对比前后虚拟 DOM，只输出变化的单元格；不再有"整段 `\x1b[1;1H\x1b[J` 重绘"。
- **宽度/CJK**：Ink 用 `string-width` 测量（CJK 双宽自动正确），替代手写 `displayWidth`/`wrapPlain`/`bodyLines`；折行由 Ink 的 `wrap` 处理。

### 3.3 状态管理方案

采用 **`zustand` 作为单一 store**（Ink 生态事实标准，与 Ink 的 `useStore` 选择器配合可做到"按需重渲染"）。

为何不直接用 Ink `useReducer`：流式 token 高频更新若走 React context，会引发整树重渲染。用 `zustand` + 细粒度 selector，只有订阅了对应切片的组件重渲染（如 `Transcript` 订阅 `assistantBuffer`，`StatusBar` 订阅 `{model,cost,ctxPct,mode}`，互不影响）。

若团队希望"零额外依赖"，可降级为 Ink `useReducer` + `useContext`，但需在 token 频更新路径上手动 `React.memo` 隔离——**本设计默认推荐 zustand**（见 §8 约束）。

### 3.4 渲染策略（流式输出）

核心挑战：SSE token 可能每几毫秒到达一次，不能每次都触发 React 渲染。

策略：**双缓冲 + 节流 flush**

1. `runAgent` 的 `onText(c)` 回调不立即 dispatch，而是 `buffer += c`。
2. 一个 flush 定时器（默认 **30–50ms**，或对齐 Ink 帧率）把 `buffer` 一次性 commit 到 `store.assistantBuffer`。
3. `Transcript` 组件订阅 `assistantBuffer`，仅在 commit 时重渲染该片段。
4. 一轮结束（`stop`）时，把 `assistantBuffer` 落盘为 `history` 的一条 `ChatMessage`，清空 buffer。

这把"高频 SSE"与"低频 React 渲染"解耦，避免闪烁与卡顿。

---

## 4. 模块划分

新建 `src/tui/` 作为框架层，保留 `theme.ts` / `markdown.ts` / `splash.ts` 作为视图原料。

### 4.1 目录结构（目标态）

```
src/tui/
  store.ts          # AppStore (zustand)：状态定义 + actions
  App.tsx           # 根组件：布局 <App> → Transcript/StatusLine/StatusBar/InputBox/Approval
  components/
    Transcript.tsx  # 历史 + 本轮用户输入 + 流式正文（Markdown 渲染）
    StatusBar.tsx   # 底部状态条
    StatusLine.tsx  # footer 动画（思考/工具/流式 + token 计数）
    InputBox.tsx    # 输入框 + 斜杠下拉 + 历史导航 + 粘贴 debounce
    Approval.tsx    # HITL y/n/a 覆盖层
    Splash.tsx      # 欢迎面板（复用 splash.ts 内容）
  bridge.ts         # runAgent 回调 → store 的 dispatch 适配；HITL/键盘 promise 桥
  hooks.ts          # useClock(tick 每秒更新 duration) 等
  index.ts          # mountTui() / runHeadless() 入口，供 repl.ts 调用
src/cli/
  repl.ts           # 改造为：建 store → 挂 bridge → mountTui()；保留 runAgent 编排
  renderer.ts       # 保留为 非-TTY 纯文本路径（StreamRenderer）
  status.ts         # 旧组件：迁移完成后删除
  statusbar.ts      # 旧组件：迁移完成后删除
  line-editor.ts    # 旧组件：迁移完成后删除
  theme.ts          # 保留（语义色）
  markdown.ts       # 保留（纯函数）
  splash.ts         # 保留（内容）
```

### 4.2 模块职责 / 交互 / 依赖

#### 4.2.1 `store.ts` — AppStore（单一状态源）

**职责**：持有全部 TUI 状态，提供 actions。

**状态切片（State）**：

```ts
interface AppState {
  // —— 会话/历史 ——
  history: ChatMessage[];          // 已完成轮次（含用户/助手/工具结果）
  userTurn: string[];              // 本轮已提交用户输入（带输入框底色的屏显行）
  assistantBuffer: string;         // 本轮流式正文累积（未提交）
  // —— 状态栏 ——
  model: string; branch: string; mode: 'normal' | 'plan';
  costText: string; ctxPct?: number; showCtx: boolean; startedAt: number;
  // —— footer 动画 ——
  anim: { mode: 'idle'|'thinking'|'tool'|'stream'; label: string; startedAt: number; estTokens: number; cachePct: number|null };
  // —— 输入/交互 ——
  input: string; cursor: number; selIndex: number; dropdown: CommandMeta[];
  state: 'input' | 'hidden' | 'asking';
  approval: { question: string; resolve: (v: string) => void } | null;
  // —— 环境 ——
  statuslineEnabled: boolean; autoContext: boolean;
  width: number; height: number;
}
```

**关键 actions**：`pushText(c)`、`beginAnim(label)`、`toolStart(name)`、`toolDone(name, ok)`、`commitUserTurn(lines)`、`finishTurn()`、`setStatus(patch)`、`setInput(s)`、`moveCursor(d)`、`setDropdown(items)`、`requestApproval(q): Promise<string>`、`resolveApproval(v)`、`tickClock()`、`setSize(w,h)`。

**依赖**：`zustand`。不依赖任何渲染细节。

**交互**：`bridge.ts` 调 actions；组件用 `useStore(selector)` 读切片。

#### 4.2.2 `App.tsx` — 根组件

**职责**：声明式布局，组合子组件；挂载 `useClock`、绑定 `stdout` resize → `setSize`。

**依赖**：`ink`（`Box`/`Text`）、各子组件、`store`。

**交互**：只读 store；不写状态（写经 actions/bridge）。

#### 4.2.3 `Transcript.tsx`

**职责**：渲染 `history` + `userTurn` + 本轮 `assistantBuffer`。调用 `renderMarkdown(buffer, width)` 把流式正文转 ANSI 样式行（保留既有 markdown 样式算法），再以 `<Text>` 逐行渲染（Ink 负责折行/定位）。超长时从顶部裁剪（等价于现状 `content.slice(len - bodyAvail)`）。

**依赖**：`markdown.ts`（`renderMarkdown`）、`store`（订阅 `history/userTurn/assistantBuffer`）、`theme.ts`（`ui`）。

**边界**：非 TTY 不挂载；Markdown 渲染仅在 TTY 启用（同现状 `status.ts` 的 `md` 选项）。

#### 4.2.4 `StatusBar.tsx`

**职责**：底部状态条 `模型 · 分支 · [ctx%] · ¥成本 · 时长 · 模式`。订阅 `{model,branch,costText,ctxPct,showCtx,mode,startedAt}`；`useClock` 每秒 `tickClock()` 刷新时长。替代现状 `StatusBar` 类的 `setInterval` + `setCaret` 协调。

**依赖**：`store`、`theme.ts`、`ui`。

**边界**：`statuslineEnabled === false` 时不渲染该组件（对应 `--no-statusline`）。

#### 4.2.5 `StatusLine.tsx`

**职责**：footer 动画（脉动字形 + 标签 + 实时秒数 + `↓ N tokens`）。订阅 `anim` 切片；动画帧由 Ink 的 `setInterval`（或 `useClock` 高频 tick）驱动重绘。替代现状 `StatusLine` 的 `render()` transcript 整段重绘——footer 现在是独立组件，布局由 Yoga 钉在 Transcript 下方，不再手工算 `footerRow`。

**依赖**：`store`、`theme.ts`、`ui`。

**边界**：`anim.mode === 'idle'` 时高度为 0（不占行）。

#### 4.2.6 `InputBox.tsx`

**职责**：把现状 `LineEditor` 的 raw mode 逻辑迁入 Ink `useInput` 组件。管理 `input/cursor/selIndex/dropdown`；`/` 开头时弹出斜杠下拉（`computeDropdownViewport` 保留为纯函数复用）；`↑/↓` 历史/菜单导航；粘贴 debounce；`Ctrl+C/D/L`；提交经 `commitUserTurn` + `onSubmit` 回调上抛。

**依赖**：`store`、`commands` 元数据、`theme.ts`、`ui`、`line-editor.ts` 的纯函数 `computeDropdownViewport` / `paintInputBox` / `displayWidth`（保留复用）。

**边界**：非 TTY 时由 `bridge` 走 `readline` 回退（同现状 `LineEditor.startReadline`），不挂 `InputBox`。

#### 4.2.7 `Approval.tsx`

**职责**：HITL 审批覆盖层（`y/n/a`）。当 `store.approval` 非空时渲染提问；捕获 `y/n/a` → `resolveApproval(v)`，对应现状 `LineEditor.ask()` 返回的 Promise。

**依赖**：`store`、`ui`。

**边界**：`approval === null` 时不渲染；防抖（渲染后忽略首回车，复用现状 `askReadyAt` 逻辑）保留。

#### 4.2.8 `bridge.ts` — TUI 桥接层

**职责**：连接"Agent 循环"与"store"。把 `runAgent` 的 `onText/onToolCall/onToolResult` 映射为 store actions；暴露 `requestApproval`（供权限层调用，返回 Promise）；暴露 `onSubmit`（输入框提交回调）；非 TTY 下路由到 `StreamRenderer`。

**依赖**：`store`、`renderer.ts`（非 TTY）、`runAgent` 类型。

**交互**：`repl.ts` 调用 `bridge.attach(runAgentCallbacks)`；权限层调用 `bridge.requestApproval(q)`。

#### 4.2.9 `hooks.ts`

**职责**：`useClock(intervalMs)` 周期性 `tickClock()`（时长刷新）；可复用为 footer 动画 tick。

**依赖**：`ink`（`useApp`/`useInput`）、`store`。

#### 4.2.10 `index.ts` — 入口

**职责**：`mountTui(opts)`（TTY 挂 Ink）+ `runHeadless(opts)`（非 TTY 走 `StreamRenderer`）。供 `repl.ts`/`runOnce` 调用，决定走哪条路径。

**依赖**：`ink`（`render`）、`store`、`bridge`、`renderer.ts`。

---

## 5. 数据流程

### 5.1 TTY 模式：一轮对话

```
用户输入(useInput) ──InputBox.onSubmit──▶ bridge.onSubmit(line)
                                            │
                                            ▼
                                  repl.ts: runTurn(line)
                                            │
                                            ▼
                                  runAgent(history, {
                                    onText: c => bridge 累积到 buffer →(flush 30ms)→ store.pushText
                                    onToolCall: call => store.toolStart(call.name)
                                    onToolResult: (call,res) => store.toolDone(call.name, res.ok)
                                  })
                                            │
        ┌───────────────────────────────────┴────────────────────────────┐
        ▼                                                                  ▼
  AppStore 状态变化                                           权限层需审批?
        │ (zustand 通知订阅组件)                                （store.approval 设值）
        ▼                                                                  ▼
  <Transcript>(assistantBuffer)                            <Approval> 渲染提问
  <StatusLine>(anim)                                         用户 y/n/a → resolveApproval
  <StatusBar>(cost/ctx)                                        │
                                                                ▼
                                                       runAgent 继续(权限结果回注)
        │
        ▼ (一轮结束 stop)
  bridge.finishTurn(): assistantBuffer → history 一条 ChatMessage；清空 buffer；anim→idle
        ▼
  <Transcript> 显示完整本轮；<InputBox> 重新激活
```

### 5.2 事件总线（保留）

现状 `bus`（`token/tool:call/tool:result/turn/compact/error`）**继续作为 Agent→审计的通道**，与 TUI 解耦。TUI 桥接**不依赖** bus（直接吃 runAgent 回调），保持"界面与可观测性互不污染"。现状 `repl.ts` 中由 bus 触发 `statusBar.update` 的逻辑，改为在 bridge 的回调里直接 dispatch store action（更短链路）。

### 5.3 非 TTY 模式

`runHeadless()` 不挂 Ink，复用 `StreamRenderer` 直接写正文文本；输入用 `readline`。保证管道/测试输出纯净、可解析（同现状 `tty=false` 分支）。

---

## 6. 接口定义

### 6.1 AppStore（节选签名）

```ts
import type { ChatMessage } from '../core/agent/types';
import type { CommandMeta } from '../cli/commands';

export type TuiMode = 'normal' | 'plan';
export type AnimMode = 'idle' | 'thinking' | 'tool' | 'stream';
export type InputState = 'input' | 'hidden' | 'asking';

export interface AppState {
  history: ChatMessage[];
  userTurn: string[];
  assistantBuffer: string;
  model: string; branch: string; mode: TuiMode;
  costText: string; ctxPct?: number; showCtx: boolean; startedAt: number;
  anim: { mode: AnimMode; label: string; startedAt: number; estTokens: number; cachePct: number | null };
  input: string; cursor: number; selIndex: number; dropdown: CommandMeta[];
  state: InputState;
  approval: { question: string; resolve: (v: string) => void } | null;
  statuslineEnabled: boolean; autoContext: boolean;
  width: number; height: number;
}

export interface AppStore extends AppState {
  pushText(c: string): void;
  beginAnim(label: string): void;
  toolStart(name: string): void;
  toolDone(name: string, ok: boolean): void;
  setAnimLabel(label: string): void;
  setCache(pct: number | null): void;
  commitUserTurn(lines: string[]): void;
  finishTurn(): void;
  setStatus(patch: Partial<Pick<AppState, 'model'|'branch'|'mode'|'costText'|'ctxPct'|'showCtx'>>): void;
  setInput(s: string): void;
  moveCursor(delta: number): void;
  setDropdown(items: CommandMeta[]): void;
  setSelIndex(i: number): void;
  requestApproval(question: string, opts?: { debounceMs?: number }): Promise<string>;
  resolveApproval(value: string): void;
  tickClock(): void;
  setSize(w: number, h: number): void;
}
```

### 6.2 入口与桥接（供 repl.ts 调用）

```ts
// src/tui/index.ts
export interface MountOptions {
  model: string; branch: string;
  statuslineEnabled: boolean; autoContext: boolean;
  commands: readonly CommandMeta[];
  onSubmit: (line: string) => void;        // 输入框提交 → runTurn
  onInterrupt: () => void;                  // Ctrl+C 语义（忙→取消 / 空闲→退出）
  requestApproval: (q: string, opts?: { debounceMs?: number }) => Promise<string>;
  initialHistory: ChatMessage[];
}
export function mountTui(opts: MountOptions): { unmount(): void; store: AppStore };
export function runHeadless(opts: MountOptions): Promise<void>;  // 非 TTY 回退
```

### 6.3 与 Agent 循环的接线点（repl.ts 改造）

```ts
// 改造后 repl.ts 内部（示意）
const { store } = mountTui({
  model: config.llm.model, branch: currentBranch,
  statuslineEnabled: config.statusline !== false,
  autoContext, commands,
  onSubmit: (line) => { void runTurn(buildUserTurn(line, promptStr)); },
  onInterrupt: handleInterrupt,
  requestApproval: (q, o) => permission.ask(q, o),
  initialHistory: history,
});

async function runTurn(userTurn: string[]) {
  store.commitUserTurn(userTurn);
  store.setStatus({ showCtx: false });
  await runAgent(history, {
    onText: (c) => streamBuffer.push(c),                 // 节流 flush → store.pushText
    onToolCall: (call) => store.toolStart(call.name),
    onToolResult: (call, res) => store.toolDone(call.name, res.ok),
  });
  store.finishTurn();
}
```

---

## 7. 技术细节

### 7.1 组件树结构

```jsx
<App>
  <Transcript />              {/* flexGrow:1, 占满剩余高度 */}
  <StatusLine />              {/* footer 动画, 固定 1 行, idle 时高度 0 */}
  <StatusBar />               {/* 最底状态条, statuslineEnabled 时渲染 */}
  <InputBox />                {/* 输入区, state!=='hidden' 时渲染 */}
  {approval && <Approval />}  {/* HITL 覆盖层 */}
</App>
```

布局由 Ink/Yoga 的 flex 自动处理，取代 `reservedBottom/footerRow/topReserve` 等全部手工几何。

### 7.2 状态管理细节

- **store 单一实例**：`repl.ts` 创建一次，`<App>` 通过 prop 或 context 注入；组件用 `useStore(s => s.x)` 细粒度订阅。
- **流式节流**：`bridge` 持有 `streamBuffer` + `setInterval(30ms)` flush 到 `store.pushText`，避免每次 token 触发渲染。
- **选择性重渲染**：`Transcript` 仅订阅 `assistantBuffer/history/userTurn`；`StatusBar` 仅订阅状态栏切片；`StatusLine` 仅订阅 `anim`。互不影响。
- **时长刷新**：`useClock(1000)` → `tickClock()` 更新 `startedAt` 推导的 duration，只触发 `StatusBar` 重渲染。

### 7.3 渲染策略细节

- **Markdown**：保留 `renderMarkdown(buffer, width)` 产出带 ANSI 样式的行；`Transcript` 把每行作为 `<Text>` 渲染。Ink 负责折行与 CJK 双宽测量（替代 `displayWidth`/`wrapPlain`/`bodyLines`）。
  - **v1（低风险）**：Markdown 产出 ANSI 字符串，`<Text>{ansiString}</Text>` 直出（Ink 透传 ANSI）。
  - **v2（可选增强）**：把 Markdown 解析为 Ink JSX 元素（标题/列表/代码块用 `Box`/`Text` 组合），彻底脱离 ANSI 字符串拼接。
- **footer 钉位**：由 `flexDirection="column"` + 组件顺序保证 footer 恒在 Transcript 下方，不再 `ESC[r;1H` 绝对定位。
- **光标/输入框**：Ink `useInput` + 组件 state 管理 `cursor`；提交后经 `commitUserTurn` 回显为永久行（同现状 `paintInputBox` 底色逻辑，复用其纯函数）。
- **resize**：`ink` 内置监听 `stdout` resize 并触发重渲染，`bridge` 在 resize 时 `setSize`；移除现状 `out.on('resize', draw)` 手动处理。

### 7.4 子进程 stdout 冲突（关键边界）

**问题**：若工具（如 `bash`）把内容直接写到终端 stdout，会与 Ink 的帧输出交错，导致花屏。

**本项目无此问题**：所有工具结果都由 `runAgent` 循环捕获为字符串（`res.content`），回注 history，再由 Ink 渲染到 `Transcript`——**工具不直写终端**。仅 `bash` 工具理论上可能流式输出，但现状同样是把结果作为字符串返回。故迁移后**无需**在工具执行期间 suspend Ink。若未来要支持工具实时透传，再引入 `ink` 的 `unmountDuring`/suspend 模式（记录在 §9 风险项，本期不做）。

---

## 8. 可实施性

### 8.1 分阶段迁移策略（每阶段可独立验证、可回滚）

| 阶段                | 内容                                                                                             | 退出标准（gate）                        |
| ----------------- | ---------------------------------------------------------------------------------------------- | --------------------------------- |
| **A. 脚手架**        | 加 `ink`+`react`(+`zustand`) 依赖；建 `src/tui/` 空壳 `App`/`store`；`repl.ts` 仍走旧路径                   | `tsc`+`test` 绿；`pnpm dev` 旧 UI 不变 |
| **B. StatusBar**  | 实现 `StatusBar.tsx` + store 状态栏切片；TTY 下挂 `<StatusBar>` 替代旧 `StatusBar` 类                        | 状态栏字段等价；`--no-statusline` 生效      |
| **C. StatusLine** | 实现 `StatusLine.tsx` + `anim` 切片；footer 动画由独立组件渲染                                               | 思考/工具/流式动画等价；时长/token 计数等价        |
| **D. Transcript** | 实现 `Transcript.tsx`；用 Ink flex 取代 transcript 整段重绘；接入节流 flush                                   | 历史/流式正文/Markdown 等价；超长裁剪等价        |
| **E. InputBox**   | 把 `LineEditor` 迁入 `InputBox.tsx`（`useInput`）；斜杠下拉/历史/粘贴/HITL 等价；`bridge.requestApproval` 接通权限层 | 输入/下拉/历史/HITL 全部等价；非 TTY 回退保留     |
| **F. 收尾**         | 删除 `status.ts`/`statusbar.ts`/`line-editor.ts`；`repl.ts` 清理旧引用；`renderer.ts` 仅留非 TTY 路径        | 全量测试绿；真机 `pnpm dev` 全交互跑通         |

每阶段完成后旧组件先保留为 fallback，确认新组件等价再删，降低回滚成本。

### 8.2 边界条件（Boundary Conditions）

1. **TTY 判定**：`process.stdout.isTTY` 为真才挂 Ink；否则 `runHeadless`。
2. **非 TTY 输出纯净**：管道/测试下不渲染任何动画/底色，仅纯文本（沿用现状 `tty=false` 分支语义）。
3. **`--no-statusline`**：`StatusBar` 组件不挂载（高度 0），footer 钉最底行。
4. **`--auto-context`**：仅控制 auto-context 注入开关（默认关），不直接影响布局。
5. **Plan 模式**：`mode` 切片切到 `'plan'`，状态栏显示"规划"；布局不变。
6. **窗口过矮（rows 很小）**：Ink 自动压缩；下拉视口 `computeDropdownViewport` 保留（纯函数复用），约束最大高度不侵入 Transcript。
7. **HITL 期间**：`approval` 非空时 `InputBox` 让位给 `Approval`；权限结果经 `resolveApproval` 回注 Agent。
8. **Ctrl+C 忙时**：`onInterrupt` 触发"取消当前 runAgent"（现状语义保留）；空闲时退出。

### 8.3 约束定义（Constraints）

- **C1 行为等价**：所有对外可见交互必须与原 UI 一致（字段、动画、下拉、HITL、快捷键）。
- **C2 Agent 零改动**：`runAgent`/工具/MCP/RAG/权限/配置/事件总线不动，仅替换"如何画"。
- **C3 依赖**：新增 `ink`（含 React 运行时与 Yoga 布局）、`zustand`（状态）；`chalk` 保留（`<Text>` 内联 ANSI 透传）；`react` 作为 ink peer 依赖。版本固定（见 §10）。
- **C4 测试**：组件可经 `render().lastFrame()` 断言；store 独立单测；保留既有 `tests/unit/*` 不破。
- **C5 非 TTY 兼容**：必须有纯文本回退路径，CI/管道不挂 Ink。
- **C6 性能**：流式 token 必须节流（默认 30–50ms），单轮渲染开销可接受（无肉眼闪烁）。

### 8.4 测试策略

| 层      | 方法                                                                     | 覆盖                                                      |
| ------ | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| store  | 直接调用 actions 断言 state                                                  | pushText/commit/finishTurn/requestApproval 解析/状态栏 patch |
| 组件     | `import { render } from 'ink-testing-library'` → `lastFrame()` 正则/包含断言 | StatusBar 字段、Transcript 含流式文本、InputBox 下拉渲染、Approval 提问 |
| bridge | mock runAgent 回调 → 断言 store 变化                                         | onText 节流、onToolCall→toolStart、finishTurn 落 history     |
| 非 TTY  | `runHeadless` 捕获 stdout 字符串                                            | 纯文本输出、无 ANSI 动画                                         |
| 回归     | 既有 `tests/unit/*` 全绿                                                   | RAG/autocontext 等不破                                     |

> Ink 测试库 `ink-testing-library` 提供 `render` + `lastFrame()`，可直接对帧字符串做断言；这是现状 `repl.ts` 无法做到的——**可单测性是本次重构的核心收益之一**。

---

## 9. 风险与对策

| #  | 风险                                                   | 影响       | 对策                                                                                                           |
| -- | ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| R1 | **流式高频重渲染卡顿/闪烁**                                     | 用户体验倒退   | 双缓冲 + 节流 flush（30–50ms）；`zustand` 细粒度 selector；`React.memo` 隔离重组件（Transcript/StatusBar）                      |
| R2 | **Markdown ANSI 与 Ink 布局冲突**（ANSI 字符串在 flex 布局中测量偏差） | 行错位/花屏   | v1 仅 `<Text>` 直出 ANSI，先用 `ink-testing-library` 帧断言验证；v2 再上 Ink JSX Markdown 组件                               |
| R3 | **raw 输入复杂度（斜杠下拉/历史/HITL）迁入 `useInput` 出错**          | 输入交互回归   | 增量迁移（阶段 E），`computeDropdownViewport`/`paintInputBox`/`displayWidth` 纯函数复用；InputBox 独立单测；非 TTY 保留 readline 回退 |
| R4 | **子进程 stdout 与 Ink 帧交错**                             | 花屏       | 本项目工具结果均经 `runAgent` 捕获为字符串再渲染，工具不直写终端 → 本期无此问题；未来如需实时透传再引入 Ink suspend（记录为已知扩展点）                            |
| R5 | **Ink/React 版本与 Node 22 兼容**                         | 构建/运行失败  | 固定 `ink@4` + `react@18`（Node 22 验证通过）；`package.json` 锁版本；CI 跑 `pnpm build`+`pnpm test`                       |
| R6 | **失去精细绝对光标控制**（如"输入框贴着 AI 输出"）                       | 视觉细节差异   | Yoga flex 顺序布局天然保证 footer 贴正文；必要时用 `flexGrow`/固定高度微调；以 `ink-testing-library` 帧比对现状                           |
| R7 | **迁移期双实现并存导致行为漂移**                                   | 旧/新路径不一致 | 每阶段旧组件先作 fallback，新组件经真机+帧测试确认等价后再删；`repl.ts` 用开关切换路径便于回滚                                                    |
| R8 | **依赖体积/启动变慢**（引入 React）                              | CLI 启动略增 | tsup 打包 React/ink 进单 bundle；`pnpm dev`(tsx) 直跑；实测启动耗时，必要时懒加载 TUI 模块                                          |
| R9 | **`--no-statusline`/`--auto-context` 等 flag 语义丢失**   | 命令行行为回归  | 阶段 B/E 显式保留旗标映射；在 store 初始化时传入 `statuslineEnabled`/`autoContext`                                             |

---

## 10. 附录

### A. 现状调研结论（摘要）

- 三层组件各自绝对定位抢同一条 stdout；状态散落 `repl.ts` 闭包；transcript 模型用手工几何（`footerRow/reservedBottom/topReserve/setCaret`）。
- 健康可复用层：`markdown.ts`（纯函数）、`theme.ts`（`ui` 语义色）、`splash.ts`、`line-editor.ts` 的纯函数（`computeDropdownViewport`/`paintInputBox`/`displayWidth`）、`renderer.ts` 的 `StreamRenderer`（非 TTY 路径）。
- 详见 `docs/tui-current-state.md`（如需要可补一份独立调研文档）。

### B. 依赖与版本（建议固定）

```
dependencies:
  ink: ^4.4.1            # React 声明式 TUI，内置 Yoga 布局
  react: ^18.3.1         # ink 运行时（peer）
  zustand: ^4.5.5        # 单一状态源（细粒度 selector）
  chalk: ^4.1.2          # 保留（<Text> 内联 ANSI 透传）
devDependencies:
  ink-testing-library: ^3.0.0   # 组件帧测试
  @types/react: ^18.3.0
```

> 注：`ink@4` 需要 `react@18`；Node 22 已验证。若升级 ink@5（React 19），同步升 react。版本以 `package.json` 实际锁为准。

### C. 术语表

- **transcript 模型**：现状把"历史+用户输入+流式正文"拼成完整文本从顶行重绘的渲染模型；Ink 下由 `Transcript` 组件 + flex 布局取代。
- **节流 flush**：把高频 token 缓冲后按固定间隔一次性提交到 store，解耦 SSE 频率与渲染频率。
- **bridge（桥接层）**：连接 Agent 循环回调与 store actions 的适配模块，使 UI 与 Agent 解耦。

### D. 评审决策记录

- 选定方案 A（Ink）而非自研/blessed：换取架构脆弱性根除 + 可测试性，代价为引入 `ink`+`react` 依赖（与"MCP 迁官方 SDK"一致，项目对零依赖已非硬约束）。
- 状态方案默认 `zustand`（细粒度 selector 防高频重渲染）；若团队要求零额外依赖，可降级 `useReducer`+context（见 §3.3）。
- 非 TTY 保留既有 `StreamRenderer` 纯文本路径，不挂 Ink。

---

> 本文档随实现演进更新；任意阶段落地后，把"实际踩坑"回填 §9 风险表与 §8.1 迁移表，保证后续会话拿到最新设计。
