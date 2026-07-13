// ReplView：统一 TTY（Ink store/bridge）与非 TTY（StreamRenderer + readline）两套渲染后端。
//
// 为什么需要它：
//   repl.ts 的高层逻辑（runTurn / runPlan / handleSlash / processInput / dispatch）在两个后端下
//   共用，但「怎么把一行字画到屏幕上」「怎么问 HITL」「怎么收输入」完全不同。
//   抽象出 ReplView 后，repl.ts 只调用 view.*，无需在每处写 `if (tty)` 分支
//   （对齐 docs/tui-ink-design.md §6.3 的 ReplView 抽象）。
//
// 两个实现：
//   - createInkView  ：TTY。底层是 AppStoreApi + Bridge，由 Ink 渲染，HITL 走 store.requestApproval。
//   - createPlainView：非 TTY。底层是 StreamRenderer（流式纯文本）+ readline（逐行收输入）。

import readline from 'node:readline';
import chalk from 'chalk';
import type { ChatMessage } from '../core/chatmodel/types';
import type { CommandMeta } from './commands';
import { paintInputBox } from './line-editor';
import { StreamRenderer } from './renderer';
import { mountTui } from '../tui';

/** 状态栏可刷新的字段子集（与 store.setStatus 的入参结构兼容）。 */
export interface StatusPatch {
  model?: string;
  branch?: string;
  mode?: 'normal' | 'plan';
  costText?: string;
  ctxPct?: number;
  showCtx?: boolean;
}

/**
 * 渲染后端统一接口。repl.ts 的 turn/plan/slash 逻辑只依赖它。
 */
export interface ReplView {
  /** slash 命令：把「提示符 + 命令」作为一条永久行写进 transcript（不进入 userTurn）。 */
  echoInput(input: string): void;
  /** 普通一轮：记录「提示符 + 输入」输入框行（TTY 带底色）并进入思考态（隐藏输入框）。 */
  beginUserTurn(input: string): void;
  /** 进入思考/规划态，启动 footer 动画。 */
  begin(label: string): void;
  /** 流式 token（累积后由后端决定节流/立即刷新）。 */
  pushToken(c: string): void;
  /** 工具调用开始。 */
  toolStart(name: string): void;
  /** 工具调用结束。 */
  toolDone(name: string, ok: boolean): void;
  /** 任意 footer 动画文案（如规划探测、压缩提示）。 */
  setAnimLabel(label: string): void;
  /** 前缀缓存命中率（token 事件回填）。 */
  setCache(pct: number | null): void;
  /** 把累积缓冲 flush 并渲染成「显示行」（TTY 经 renderMarkdown；非 TTY 返回 []，正文已流式输出）。 */
  flushAndRenderBody(): string[];
  /** 一轮正文定稿：TTY 追加 userTurn + 正文行 + extra 进 transcript；非 TTY 仅打印 extra。 */
  commitDisplay(bodyLines: string[], extra?: string[]): void;
  /** 一轮结束：清缓冲 + 回到输入态（TTY）/ 补换行（非 TTY）。 */
  finishTurn(): void;
  /** 直接打印一行（slash 输出 / 成本 / 错误 / 记忆提示）。 */
  printLine(line: string): void;
  /** HITL 询问，返回用户答案（TTY 走 <Approval>；非 TTY 走 readline.question）。 */
  ask(question: string, opts?: { debounceMs?: number }): Promise<string>;
  /** 刷新状态栏字段（成本 / ctx% / 模式 / showCtx）。 */
  setStatus(patch: StatusPatch): void;
  /** 进入/退出规划态（同步状态栏模式）。 */
  setMode(mode: 'normal' | 'plan'): void;
  /** 启动输入循环，在退出（/exit、Ctrl+D、空闲 Ctrl+C）时 resolve。 */
  start(): Promise<void>;
  /** 退出（unmount Ink / 关闭 readline）。 */
  exit(): void;
}

export interface InkViewOpts {
  model: string;
  branch: string;
  mode?: 'normal' | 'plan';
  statuslineEnabled: boolean;
  commands: readonly CommandMeta[];
  prompt: string;
  history: string[];
  markdown?: (md: string, width: number) => string[];
  /** 输入框提交 → runTurn（返回值被 Ink 路径忽略）。 */
  onSubmit: (line: string) => void | Promise<'exit' | 'continue'>;
  /** Ctrl+C：忙→取消 / 空闲→退出。 */
  onInterrupt: () => void;
  initialHistory?: ChatMessage[];
  initialTranscript?: string[];
}

/** TTY 实现：基于 mountTui 的 store + bridge，由 Ink 渲染。 */
export function createInkView(opts: InkViewOpts): ReplView {
  let resolveStart!: () => void;
  const exitPromise = new Promise<void>((res) => {
    resolveStart = res;
  });
  let exited = false;
  const doExit = (): void => {
    if (exited) return;
    exited = true;
    unmount();
    resolveStart();
  };

  const { store, bridge, unmount } = mountTui({
    model: opts.model,
    branch: opts.branch,
    mode: opts.mode ?? 'normal',
    statuslineEnabled: opts.statuslineEnabled,
    autoContext: false,
    commands: opts.commands,
    prompt: opts.prompt,
    history: opts.history,
    markdown: opts.markdown,
    onSubmit: (line) => opts.onSubmit(line),
    onInterrupt: () => opts.onInterrupt(),
    onExit: () => doExit(),
    initialHistory: opts.initialHistory,
    initialTranscript: opts.initialTranscript,
  });

  const w = (): number => store.getState().width;

  return {
    echoInput(input) {
      store.getState().appendTranscript([paintInputBox(opts.prompt + input, w()), '']);
    },
    beginUserTurn(input) {
      store.getState().commitUserTurn([paintInputBox(opts.prompt + input, w()), '']);
    },
    begin(label) {
      bridge.beginTurn(label);
    },
    pushToken(c) {
      bridge.pushToken(c);
    },
    toolStart(name) {
      bridge.onToolCall(name);
    },
    toolDone(name, ok) {
      bridge.onToolResult(name, ok);
    },
    setAnimLabel(label) {
      store.getState().setAnimLabel(label);
    },
    setCache(pct) {
      store.getState().setCache(pct);
    },
    flushAndRenderBody() {
      bridge.flush();
      const raw = store.getState().assistantBuffer;
      return opts.markdown ? opts.markdown(raw, w()) : raw.split('\n');
    },
    commitDisplay(bodyLines, extra) {
      store.getState().commitTurnDisplay(bodyLines, extra);
    },
    finishTurn() {
      bridge.finishTurn();
    },
    printLine(line) {
      store.getState().appendTranscript([line]);
    },
    ask(question, o) {
      return store.getState().requestApproval(question, o);
    },
    setStatus(patch) {
      store.getState().setStatus(patch);
    },
    setMode(mode) {
      store.getState().setStatus({ mode });
    },
    start() {
      return exitPromise;
    },
    exit() {
      doExit();
    },
  };
}

export interface PlainViewOpts {
  prompt: string;
  history: string[];
  /** 输入框提交 → dispatch；返回值驱动 readline 循环是否退出。 */
  onSubmit: (line: string) => 'exit' | 'continue' | Promise<'exit' | 'continue'>;
  /** Ctrl+C：忙→取消 / 空闲→退出。 */
  onInterrupt: () => void;
  onExit?: () => void;
}

/** 非 TTY 实现：StreamRenderer 流式纯文本 + readline 逐行收输入。 */
export function createPlainView(opts: PlainViewOpts): ReplView {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history: opts.history,
    historySize: 2000,
  });
  const renderer = new StreamRenderer();
  const prompt = opts.prompt;
  let exited = false;

  const askQ = (q: string): Promise<string> =>
    new Promise<string>((res) => {
      rl.question(q, (a) => res(a.trim()));
    });

  const view: ReplView = {
    echoInput(input) {
      console.log(prompt + input);
    },
    beginUserTurn(input) {
      console.log(prompt + input);
    },
    begin(label) {
      renderer.status(label);
    },
    pushToken(c) {
      renderer.push(c);
    },
    toolStart(name) {
      renderer.status(`🔧 ${name}`);
    },
    toolDone(name, ok) {
      renderer.status(`${ok ? '✓' : '✗'} ${name}`);
    },
    setAnimLabel(label) {
      renderer.status(label);
    },
    setCache() {
      /* 纯文本无状态栏，忽略 */
    },
    flushAndRenderBody() {
      return [];
    },
    commitDisplay(_body, extra) {
      if (extra && extra.length) {
        for (const l of extra) console.log(l);
      }
    },
    finishTurn() {
      renderer.newline();
    },
    printLine(line) {
      console.log(line);
    },
    ask(question) {
      return askQ(question);
    },
    setStatus() {
      /* 纯文本无状态栏，忽略 */
    },
    setMode() {
      /* 纯文本无状态栏，忽略 */
    },
    start() {
      return (async () => {
        let pendingResolve: ((line: string) => void) | null = null;
        rl.on('line', (line) => {
          const r = pendingResolve;
          pendingResolve = null;
          r?.(line);
        });
        rl.on('close', () => {
          exited = true;
          const r = pendingResolve;
          pendingResolve = null;
          r?.('');
        });
        rl.on('SIGINT', () => opts.onInterrupt());
        rl.setPrompt(prompt);
        try {
          while (!exited) {
            const line = await new Promise<string>((res) => {
              pendingResolve = res;
              rl.prompt();
            });
            const t = line.trim();
            if (!t) continue;
            const r = await opts.onSubmit(t);
            if (r === 'exit') break;
          }
        } finally {
          rl.close();
        }
      })();
    },
    exit() {
      exited = true;
      rl.close();
    },
  };

  // onExit 钩子（被外部 /exit 之外的路径使用；此处暂挂起以备扩展）。
  void opts.onExit;

  return view;
}
