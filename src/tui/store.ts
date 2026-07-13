// AppStore（zustand）——TUI 单一状态源。
//
// 设计依据：docs/tui-ink-design.md §4.2.1 / §6.1。
// 目标：把原先散落在 repl.ts 闭包与 LineEditor 内部的状态收口到一处，
// 由 bridge.ts 调用 actions，组件用 useStore(selector) 细粒度订阅。
//
// 本文件不依赖任何渲染细节（不 import ink），保证可脱离终端单测。

import { createStore } from 'zustand/vanilla';
import type { ChatMessage } from '../core/chatmodel/types';
import type { CommandMeta } from '../cli/commands';

export type TuiMode = 'normal' | 'plan';
export type AnimMode = 'idle' | 'thinking' | 'tool' | 'stream';
export type InputState = 'input' | 'hidden' | 'asking';

export interface AnimState {
  mode: AnimMode;
  label: string;
  startedAt: number;
  estTokens: number;
  cachePct: number | null;
}

export interface ApprovalState {
  question: string;
  resolve: (value: string) => void;
  /** 防抖截止时刻（ms epoch）：窗口内的首回车被忽略；0 表示不防抖。 */
  readyAt: number;
}

export interface AppState {
  // —— 会话/历史 ——
  history: ChatMessage[];
  /**
   * 已定稿的「显示行」累积（含 splash / 历轮用户输入框 / 历轮回复 / 成本行 / 记忆提示等）。
   * 等价于旧 repl.ts 的 `transcript: string[]`——是渲染态而非语义态，Transcript 直接铺屏。
   */
  transcriptLines: string[];
  /**
   * transcriptLines 开头属于「启动 splash 面板」的行数。这些行是定宽 ASCII 框，
   * 需由 Transcript 用 <Text wrap="truncate"> 渲染——即便框宽与真实终端有误差也只
   * 右侧截断，绝不换行拆成多行（防「边框拆行」）。普通 AI 正文仍用默认 wrap 保证可读。
   */
  splashCount: number;
  userTurn: string[];
  assistantBuffer: string;
  // —— 状态栏 ——
  model: string;
  branch: string;
  mode: TuiMode;
  tokenText: string;
  ctxPct?: number;
  showCtx: boolean;
  startedAt: number;
  // —— footer 动画 ——
  anim: AnimState;
  // —— 输入/交互 ——
  input: string;
  cursor: number;
  selIndex: number;
  dropdown: CommandMeta[];
  state: InputState;
  approval: ApprovalState | null;
  // —— 环境 ——
  statuslineEnabled: boolean;
  autoContext: boolean;
  width: number;
  height: number;
  // 时钟节拍：useClock 每秒 +1，供派生 duration 的组件订阅重渲染
  clock: number;
}

export interface AppActions {
  pushText(c: string): void;
  beginAnim(label: string): void;
  toolStart(name: string): void;
  toolDone(name: string, ok: boolean): void;
  setAnimLabel(label: string): void;
  setCache(pct: number | null): void;
  commitUserTurn(lines: string[]): void;
  /** 追加已定稿显示行到 transcriptLines（splash / 成本行 / 记忆提示等）。 */
  appendTranscript(lines: string[]): void;
  /** 整体替换 transcriptLines（少用；如重置或外部重建）。 */
  setTranscript(lines: string[]): void;
  /**
   * 一轮结束的「显示定稿」：把本轮 userTurn + 渲染好的正文行 + 附加行（成本/提示）
   * 追加进 transcriptLines，并清空 userTurn。渲染正文行由调用方（bridge，注入
   * renderMarkdown）预先算好传入，保持 store 与视图无关。
   */
  commitTurnDisplay(bodyLines: string[], extra?: string[]): void;
  finishTurn(): void;
  setStatus(
    patch: Partial<
      Pick<AppState, 'model' | 'branch' | 'mode' | 'tokenText' | 'ctxPct' | 'showCtx'>
    >,
  ): void;
  setInput(s: string): void;
  /** 同时设置输入串与光标位置（供插入/删除/历史回填等精确控制光标）。 */
  setInputCursor(s: string, cursor: number): void;
  moveCursor(delta: number): void;
  setDropdown(items: CommandMeta[]): void;
  setSelIndex(i: number): void;
  setInputState(s: InputState): void;
  requestApproval(question: string, opts?: { debounceMs?: number }): Promise<string>;
  resolveApproval(value: string): void;
  tickClock(): void;
  setSize(w: number, h: number): void;
  reset(): void;
}

export type AppStore = AppState & AppActions;

export interface CreateStoreOptions {
  model?: string;
  branch?: string;
  mode?: TuiMode;
  statuslineEnabled?: boolean;
  autoContext?: boolean;
  initialHistory?: ChatMessage[];
  /** 初始显示行（如 splash 欢迎面板）。 */
  initialTranscript?: string[];
  width?: number;
  height?: number;
}

function idleAnim(): AnimState {
  return { mode: 'idle', label: '', startedAt: 0, estTokens: 0, cachePct: null };
}

/**
 * 粗略 token 估算：与既有 status.ts 口径完全一致——
 * CJK 按字计，其余按 ~4 字符/token。用于 footer 的 `↓ N tokens`。
 */
function estimateTokens(s: string): number {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = s.length - cjk;
  return cjk + Math.ceil(other / 4);
}

// footer 标签文案（对齐旧 status.ts）
const LABEL_THINKING = '思考中…';
const LABEL_STREAM = '生成回复中…';

/**
 * 创建 TUI 状态 store。使用 zustand vanilla store，
 * 在组件侧用 useStore(store, selector) 订阅（见 hooks.ts）。
 */
export function createAppStore(opts: CreateStoreOptions = {}) {
  return createStore<AppStore>((set, get) => ({
    // —— 初始状态 ——
    history: opts.initialHistory ?? [],
    transcriptLines: opts.initialTranscript ?? [],
    // 初始 transcript 即为 splash 面板（repl 传入 renderSplash() 结果）。
    splashCount: opts.initialTranscript?.length ?? 0,
    userTurn: [],
    assistantBuffer: '',
    model: opts.model ?? '',
    branch: opts.branch ?? '',
    mode: opts.mode ?? 'normal',
    tokenText: '',
    ctxPct: undefined,
    showCtx: false,
    startedAt: Date.now(),
    anim: idleAnim(),
    input: '',
    cursor: 0,
    selIndex: 0,
    dropdown: [],
    state: 'input',
    approval: null,
    statuslineEnabled: opts.statuslineEnabled ?? true,
    autoContext: opts.autoContext ?? false,
    width: opts.width ?? (process.stdout.columns || 80),
    height: opts.height ?? (process.stdout.rows || 24),
    clock: 0,

    // —— actions ——
    pushText(c) {
      if (!c) return;
      const prev = get().anim;
      const buffer = get().assistantBuffer + c;
      set({
        assistantBuffer: buffer,
        anim: {
          ...prev,
          mode: 'stream',
          label: prev.mode === 'stream' ? prev.label : LABEL_STREAM,
          estTokens: prev.estTokens + estimateTokens(c),
        },
      });
    },

    beginAnim(label) {
      set({
        anim: {
          mode: 'thinking',
          label: label || LABEL_THINKING,
          startedAt: Date.now(),
          estTokens: 0,
          cachePct: null,
        },
      });
    },

    toolStart(name) {
      set({
        anim: { ...get().anim, mode: 'tool', label: `🔧 调用工具 ${name}` },
      });
    },

    toolDone(name, ok) {
      // 对齐旧 status.ts.toolDone：保持 tool 态，label 显示 ✓/✗ 结果。
      set({ anim: { ...get().anim, mode: 'tool', label: `${ok ? '✓' : '✗'} ${name}` } });
    },

    setAnimLabel(label) {
      set({ anim: { ...get().anim, label } });
    },

    setCache(pct) {
      set({ anim: { ...get().anim, cachePct: pct } });
    },

    commitUserTurn(lines) {
      set({
        userTurn: lines,
        assistantBuffer: '',
        showCtx: false,
        // 一轮开始：隐藏输入框，避免生成期间继续接键（由 <InputBox> 的 useInput 感知）。
        state: 'hidden',
        anim: { mode: 'thinking', label: LABEL_THINKING, startedAt: Date.now(), estTokens: 0, cachePct: null },
      });
    },

    appendTranscript(lines) {
      if (!lines.length) return;
      set({ transcriptLines: [...get().transcriptLines, ...lines] });
    },

    setTranscript(lines) {
      set({ transcriptLines: lines });
    },

    commitTurnDisplay(bodyLines, extra = []) {
      const { transcriptLines, userTurn } = get();
      // 与旧 repl.ts 一致：显示行上限 4000，超出从顶部裁剪，避免无限增长。
      let next = [...transcriptLines, ...userTurn, ...bodyLines, ...extra];
      if (next.length > 4000) next = next.slice(next.length - 4000);
      set({ transcriptLines: next, userTurn: [] });
    },

    finishTurn() {
      const { assistantBuffer, history } = get();
      const nextHistory = assistantBuffer
        ? [...history, { role: 'assistant', content: assistantBuffer } as ChatMessage]
        : history;
      set({
        history: nextHistory,
        assistantBuffer: '',
        userTurn: [],
        anim: idleAnim(),
        state: 'input',
      });
    },

    setStatus(patch) {
      set(patch);
    },

    setInput(s) {
      set({ input: s, cursor: Math.min(get().cursor, s.length) });
    },

    setInputCursor(s, cursor) {
      set({ input: s, cursor: Math.max(0, Math.min(s.length, cursor)) });
    },

    moveCursor(delta) {
      const { cursor, input } = get();
      const next = Math.max(0, Math.min(input.length, cursor + delta));
      set({ cursor: next });
    },

    setDropdown(items) {
      set({ dropdown: items, selIndex: items.length ? Math.min(get().selIndex, items.length - 1) : 0 });
    },

    setSelIndex(i) {
      set({ selIndex: i });
    },

    setInputState(s) {
      set({ state: s });
    },

    requestApproval(question, opts) {
      return new Promise<string>((resolve) => {
        const readyAt = opts?.debounceMs && opts.debounceMs > 0 ? Date.now() + opts.debounceMs : 0;
        set({ approval: { question, resolve, readyAt }, state: 'asking' });
      });
    },

    resolveApproval(value) {
      const { approval } = get();
      if (approval) approval.resolve(value);
      set({ approval: null, state: 'input' });
    },

    tickClock() {
      set({ clock: get().clock + 1 });
    },

    setSize(w, h) {
      set({ width: w, height: h });
    },

    reset() {
      set({
        userTurn: [],
        assistantBuffer: '',
        anim: idleAnim(),
        input: '',
        cursor: 0,
        selIndex: 0,
        dropdown: [],
        state: 'input',
        approval: null,
      });
    },
  }));
}

export type AppStoreApi = ReturnType<typeof createAppStore>;
