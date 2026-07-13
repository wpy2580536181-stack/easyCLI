// 根组件：声明式布局骨架。
//
// Phase F：按 docs/tui-ink-design.md §7.1 组件树填入全部子组件，并接 stdout resize → setSize。
// 布局自上而下：Transcript（主输出区，占满剩余空间）→ StatusLine（footer 动画）→
// StatusBar（底部状态条）→ InputBox（输入框 + 斜杠下拉）→ Approval（HITL 覆盖层）。
//
// 设计依据：docs/tui-ink-design.md §4.2.2 / §7.1。

import React, { useEffect } from 'react';
import { Box, useInput, useStdout } from 'ink';
import type { AppStoreApi } from './store';
import { useAppStore, useClock } from './hooks';
import type { CommandMeta } from '../cli/commands';
import { Transcript } from './components/Transcript';
import { StatusLine } from './components/StatusLine';
import { StatusBar } from './components/StatusBar';
import { InputBox } from './components/InputBox';
import { Approval } from './components/Approval';
import { SplashTitle } from './components/SplashTitle';
import { AppTheme } from './theme';

export interface AppProps {
  store: AppStoreApi;
  /** 输入框提示符（如 chalk.cyan('❯ ')）。 */
  prompt: string;
  /** 斜杠命令元数据（名称 + 说明）。 */
  commands: readonly CommandMeta[];
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
}

export function App({
  store,
  prompt,
  commands,
  history,
  markdown,
  onSubmit,
  onInterrupt,
  onExit,
}: AppProps): React.ReactElement {
  // 每秒节拍：驱动状态栏时长与 footer 动画刷新。
  useClock(store, 1000);

  // 订阅窗口尺寸切片（resize 时由下方 effect 调 setSize 触发重渲染）。
  const width = useAppStore(store, (s) => s.width);
  const height = useAppStore(store, (s) => s.height);
  const approval = useAppStore(store, (s) => s.approval);

  // 应用内滚动键：PageUp/PageDown 翻页，Home 跳到顶 / End 回到底部。
  // 与 <InputBox> 的 useInput 并存（Ink 允许多个 handler）；翻页键不冲突于输入框历史(↑/↓)。
  // 注：Ink 的 Key 类型未声明 home/end，但运行时 keypress 会解析，故 key 用 any 兼容。
  useInput(
    (_ch, key: any) => {
      const st = store.getState();
      const step = Math.max(3, Math.floor((st.height - 4) / 2)); // 半页
      if (key.pageUp) {
        st.scrollBy(step);
        return;
      }
      if (key.pageDown) {
        st.scrollBy(-step);
        return;
      }
      if (key.home) {
        st.scrollBy(Number.MAX_SAFE_INTEGER);
        return;
      }
      if (key.end) {
        st.scrollToBottom();
        return;
      }
    },
    { isActive: true },
  );

  // 接 stdout resize：终端尺寸变化（如分屏/全屏切换）时同步到 store，
  // 让 Transcript/InputBox 按新宽度重排（行为等价旧 StatusLine 的 resize 重绘）。
  const { stdout } = useStdout();
  useEffect(() => {
    const onResize = () => {
      store.getState().setSize(stdout.columns ?? 80, stdout.rows ?? 24);
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.removeListener('resize', onResize);
    };
  }, [store, stdout]);

  return (
    <AppTheme>
      <Box flexDirection="column" width={width}>
      <SplashTitle />
      <Transcript store={store} markdown={markdown} reservedRows={4} />
      <StatusLine store={store} />
      <StatusBar store={store} />
      <InputBox
        store={store}
        prompt={prompt}
        commands={commands}
        history={history}
        onSubmit={onSubmit}
        onInterrupt={onInterrupt}
        onExit={onExit}
      />
      {approval && <Approval store={store} />}
      </Box>
    </AppTheme>
  );
}

export default App;
