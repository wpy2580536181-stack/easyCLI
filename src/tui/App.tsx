// 根组件：声明式布局骨架。
//
// Phase F：按 docs/tui-ink-design.md §7.1 组件树填入子组件，并接 stdout resize → setSize。
// 蓝图 P0 布局（维度 ①③⑦）：横向分栏 = 左侧栏(Sidebar) + 右主列(顶栏 + 主输出 + footer + 底栏)。
//   - TopStatusBar：顶部状态条（模型/分支/ctx/token/时长 + 模式）
//   - Transcript：主输出区（占满剩余空间）
//   - PendingDiffs：待展示代码变更（DiffBlock）
//   - StatusLine：footer 动画（spinner/流式/取消）
//   - StatusBar：底部状态条（内容等价 TopStatusBar，置于底）
//   - InputBox：输入框 + 斜杠下拉 + @文件引用下拉
//   - Approval：HITL 覆盖层
// 快捷键：Ctrl+B 收起/展开侧栏；Ctrl+D（非输入态）行内↔并排 diff 切换。
//
// 设计依据：docs/tui-ink-design.md §4.2.2 / §7.1；蓝图 P0。

import React, { useEffect } from 'react';
import { Box, useInput, useStdout } from 'ink';
import type { AppStoreApi } from './store';
import type { FileStatus, SessionMeta } from './store';
import { useAppStore, useClock } from './hooks';
import type { CommandMeta } from '../cli/commands';
import { Transcript } from './components/Transcript';
import { StatusLine } from './components/StatusLine';
import { StatusBar } from './components/StatusBar';
import { InputBox } from './components/InputBox';
import { Approval } from './components/Approval';
import { Sidebar } from './components/Sidebar';
import { PendingDiffs } from './components/PendingDiffs';
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
  /** 工作区文件 git 状态（注入侧栏 FILES 面板）。 */
  files?: FileStatus[];
  /** 历史会话（注入侧栏 SESSIONS 面板）。 */
  sessions?: SessionMeta[];
  /** 已知文件路径（@ 引用下拉候选）。 */
  fileRefs?: string[];
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
  files,
  sessions,
  fileRefs,
}: AppProps): React.ReactElement {
  // 每秒节拍：驱动状态栏时长与 footer 动画刷新。
  useClock(store, 1000);

  // 订阅窗口尺寸切片（resize 时由下方 effect 调 setSize 触发重渲染）。
  const width = useAppStore(store, (s) => s.width);
  const height = useAppStore(store, (s) => s.height);
  const approval = useAppStore(store, (s) => s.approval);

  // 注入侧栏 / @引用 数据（bridge 也可在运行中 setFiles/setSessions/setFileRefs 更新）。
  useEffect(() => {
    if (files) store.getState().setFiles(files);
    if (sessions) store.getState().setSessions(sessions);
    if (fileRefs) store.getState().setFileRefs(fileRefs);
  }, [store, files, sessions, fileRefs]);

  // 应用内滚动键：PageUp/PageDown 翻页，Home 跳到顶 / End 回到底部。
  // 与 <InputBox> 的 useInput 并存（Ink 允许多个 handler）；翻页键不冲突于输入框历史(↑/↓)。
  // 注：Ink 的 Key 类型未声明 home/end，但运行时 keypress 会解析，故 key 用 any 兼容。
  useInput(
    (_ch, key: any) => {
      const st = store.getState();
      const step = Math.max(3, Math.floor((st.height - 4) / 2)); // 半页
      // 真实总行数：body 用 markdown 渲染后的行数，与 Transcript 的 buildVisibleLines 完全一致。
      const body = st.assistantBuffer
        ? (markdown ? markdown(st.assistantBuffer, st.width) : st.assistantBuffer.split('\n')).length
        : 0;
      const total = st.transcriptLines.length + st.userTurn.length + body;
      if (key.pageUp) {
        st.scrollBy(step, total);
        return;
      }
      if (key.pageDown) {
        st.scrollBy(-step, total);
        return;
      }
      if (key.home) {
        st.scrollBy(Number.MAX_SAFE_INTEGER, total);
        return;
      }
      if (key.end) {
        st.scrollToBottom();
        return;
      }
    },
    { isActive: true },
  );

  // 全局 Ctrl+C：无论 state 如何都捕获（busy 时 InputBox 的 useInput 被禁用，
  // 必须在此处拦截才能中断 AI 生成）。
  useInput(
    (_ch, key: any) => {
      if (key.ctrl && key.name === 'c') {
        onInterrupt();
      }
    },
    { isActive: true },
  );

  // 蓝图 P0 快捷键：Ctrl+B 收起/展开侧栏；Ctrl+D（非输入态）行内↔并排 diff 切换。
  // 输入态下 Ctrl+D 仍由 <InputBox> 用于退出 REPL（互不冲突）。
  useInput(
    (_ch, key: any) => {
      const st = store.getState();
      if (key.ctrl && key.name === 'b') {
        st.toggleSidebar();
        return;
      }
      if (key.ctrl && key.name === 'd' && st.state !== 'input') {
        st.toggleDiffMode();
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
      <Box flexDirection="row" width={width} height={height}>
        <Sidebar store={store} />
        <Box flexDirection="column" flexGrow={1}>
          <Box flexDirection="column" flexGrow={1}>
            <Transcript
              store={store}
              markdown={markdown}
              reservedRows={3}
            />
            <PendingDiffs store={store} />
          </Box>
          <StatusLine store={store} />
          <StatusBar store={store} />
          <InputBox
            store={store}
            prompt={prompt}
            commands={commands}
            history={history}
            fileRefs={fileRefs}
            onSubmit={onSubmit}
            onExit={onExit}
          />
          {approval && <Approval store={store} />}
        </Box>
      </Box>
    </AppTheme>
  );
}

export default App;
