// TUI 入口：mountTui()（TTY 挂 Ink）/ runHeadless()（非 TTY 回退，仅建 store/bridge 骨架）。
//
// 设计依据：docs/tui-ink-design.md §4.2.10 / §6.2。
// 供 repl.ts / runOnce 调用，决定走 Ink 声明式路径还是纯文本路径。
//
// 说明：本文件用 React.createElement 而非 JSX，以保持 .ts 扩展名（App.tsx 内使用 JSX）。

import React from 'react';
import { render } from 'ink';
import type { ChatMessage } from '../core/chatmodel/types';
import type { CommandMeta } from '../cli/commands';
import { createAppStore, type AppStoreApi, type TuiMode } from './store';
import { createBridge, type Bridge } from './bridge';
import { App } from './App';

export interface MountOptions {
  model: string;
  branch: string;
  mode?: TuiMode;
  statuslineEnabled: boolean;
  autoContext: boolean;
  commands: readonly CommandMeta[];
  /** 输入框提示符（如 chalk.cyan('❯ ')）。 */
  prompt: string;
  /** 「新 → 旧」历史，供 ↑/↓ 翻历史。 */
  history: string[];
  /** 流式正文渲染器（TTY 下传 renderMarkdown；非 TTY 不传）。 */
  markdown?: (md: string, width: number) => string[];
  /** 输入框提交 → runTurn。 */
  onSubmit: (line: string) => void;
  /** Ctrl+C 语义（忙→取消 / 空闲→退出）。 */
  onInterrupt: () => void;
  /** Ctrl+D：退出 REPL。 */
  onExit?: () => void;
  /** 初始会话历史（用于语义态，不影响显示）。 */
  initialHistory?: ChatMessage[];
  /** 初始显示行（如 splash 欢迎面板）。 */
  initialTranscript?: string[];
}

export interface MountedTui {
  store: AppStoreApi;
  bridge: Bridge;
  unmount(): void;
}

/** TTY 模式：挂载 Ink 应用。 */
export function mountTui(opts: MountOptions): MountedTui {
  const store = createAppStore({
    model: opts.model,
    branch: opts.branch,
    mode: opts.mode ?? 'normal',
    statuslineEnabled: opts.statuslineEnabled,
    autoContext: opts.autoContext,
    initialHistory: opts.initialHistory,
    initialTranscript: opts.initialTranscript,
  });

  const bridge = createBridge(store);

  const instance = render(
    React.createElement(App, {
      store,
      prompt: opts.prompt,
      commands: opts.commands,
      history: opts.history,
      markdown: opts.markdown,
      onSubmit: opts.onSubmit,
      onInterrupt: opts.onInterrupt,
      onExit: opts.onExit,
    }),
    {
      // 让 Ink 独占管理光标/清屏；stdout 由 Ink 统一写。
      exitOnCtrlC: false,
    },
  );

  return {
    store,
    bridge,
    unmount() {
      bridge.dispose();
      instance.unmount();
    },
  };
}

/**
 * 非 TTY 模式：不挂 Ink，仅建立 store/bridge 骨架，供调用方自行驱动纯文本渲染。
 * （repl.ts 当前由 PlainView 直接管理 readline + StreamRenderer；此函数保留为
 * 可复用的 store/bridge 工厂，对齐设计文档 §6.2。）
 */
export function runHeadless(opts: MountOptions): { store: AppStoreApi; bridge: Bridge } {
  const store = createAppStore({
    model: opts.model,
    branch: opts.branch,
    mode: opts.mode ?? 'normal',
    statuslineEnabled: opts.statuslineEnabled,
    autoContext: opts.autoContext,
    initialHistory: opts.initialHistory,
    initialTranscript: opts.initialTranscript,
  });
  const bridge = createBridge(store);
  return { store, bridge };
}

export { createAppStore } from './store';
export type { AppStore, AppState, AppStoreApi } from './store';
export { createBridge } from './bridge';
export type { Bridge } from './bridge';
