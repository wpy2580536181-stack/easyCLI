// InputBox：输入框 + 斜杠命令下拉 + 历史导航（Ink useInput 版）。
//
// 等价于旧 src/cli/line-editor.ts 的 raw mode 自绘：
//   - 输入以 / 开头弹出命令下拉，按全名包含子串实时筛选；
//   - ↑/↓ 菜单内移动高亮 / 非斜杠翻历史；Tab/Enter 填充或执行；Esc 清空；
//   - ←/→/Home/End 移动光标，Backspace 删光标前字符；Ctrl+C 中断、Ctrl+D 退出。
//
// 变化：不再 raw mode 绝对定位自绘 + boxTop/clearFrom 手工清屏；由 Ink useInput
// 收键、Yoga 布局定位；复用 line-editor 的纯函数 paintInputBox / computeDropdownViewport。
//
// 设计依据：docs/tui-ink-design.md §4.2.6。

import React, { useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import chalk from 'chalk';
import type { CommandMeta } from '../../cli/commands';
import { computeDropdownViewport } from '../../cli/line-editor';
import type { AppStoreApi } from '../store';
import { useAppStore } from '../hooks';
import { filterCommands, decideEnter, wrapIndex } from '../input-editor';

export interface InputBoxProps {
  store: AppStoreApi;
  prompt: string;
  commands: readonly CommandMeta[];
  /** 「新 → 旧」历史，用于非斜杠 ↑/↓ 翻历史。 */
  history: string[];
  onSubmit: (line: string) => void;
  onInterrupt: () => void;
  onExit?: () => void;
}

export function InputBox({
  store,
  prompt,
  commands,
  history,
  onSubmit,
  onInterrupt,
  onExit,
}: InputBoxProps): React.ReactElement | null {
  const input = useAppStore(store, (s) => s.input);
  const cursor = useAppStore(store, (s) => s.cursor);
  const selIndex = useAppStore(store, (s) => s.selIndex);
  const state = useAppStore(store, (s) => s.state);
  const width = useAppStore(store, (s) => s.width);
  const height = useAppStore(store, (s) => s.height);

  // 历史导航本地态（不入 store，属组件私有交互态）。
  const histIndex = useRef(-1);
  const savedDraft = useRef('');

  const syncDropdown = (nextInput: string) => {
    store.getState().setDropdown(filterCommands(nextInput, commands));
  };

  useInput(
    (ch, key) => {
      const st = store.getState();
      // asking 交给 <Approval>；hidden（忙）忽略键入。
      if (st.state !== 'input') return;

      // —— 控制键 ——
      if (key.ctrl && ch === 'c') {
        onInterrupt();
        return;
      }
      if (key.ctrl && ch === 'd') {
        onExit?.();
        return;
      }
      if (key.escape) {
        st.setInputCursor('', 0);
        st.setSelIndex(0);
        syncDropdown('');
        return;
      }

      const matches = filterCommands(st.input, commands);
      const isSlash = st.input.startsWith('/');

      // —— Tab：填充高亮项 ——
      if (key.tab) {
        if (isSlash && matches.length) {
          const sel = matches[Math.min(st.selIndex, matches.length - 1)];
          if (sel) {
            const next = '/' + sel.name + ' ';
            st.setInputCursor(next, next.length);
            st.setSelIndex(0);
            syncDropdown(next);
          }
        }
        return;
      }

      // —— Enter：决议 ——
      if (key.return) {
        const decision = decideEnter(st.input, commands, st.selIndex);
        if (decision.kind === 'execute' || decision.kind === 'submit') {
          histIndex.current = -1;
          savedDraft.current = '';
          st.setInputCursor('', 0);
          st.setSelIndex(0);
          syncDropdown('');
          onSubmit(decision.line);
        } else if (decision.kind === 'fill') {
          st.setInputCursor(decision.input, decision.input.length);
          st.setSelIndex(0);
          syncDropdown(decision.input);
        }
        return;
      }

      // —— 光标移动 ——
      if (key.leftArrow) {
        st.moveCursor(-1);
        return;
      }
      if (key.rightArrow) {
        st.moveCursor(1);
        return;
      }

      // —— ↑/↓：斜杠菜单 or 历史 ——
      if (key.upArrow) {
        if (isSlash && matches.length) {
          st.setSelIndex(wrapIndex(st.selIndex, -1, matches.length));
        } else {
          navHistory(-1);
        }
        return;
      }
      if (key.downArrow) {
        if (isSlash && matches.length) {
          st.setSelIndex(wrapIndex(st.selIndex, 1, matches.length));
        } else {
          navHistory(1);
        }
        return;
      }

      // —— Backspace/Delete：删光标前字符 ——
      if (key.backspace || key.delete) {
        if (st.cursor > 0) {
          const next = st.input.slice(0, st.cursor - 1) + st.input.slice(st.cursor);
          st.setInputCursor(next, st.cursor - 1);
          st.setSelIndex(0);
          syncDropdown(next);
        }
        return;
      }

      // —— 可打印字符（含中文/粘贴多字符）——
      if (ch && !key.ctrl && !key.meta) {
        const next = st.input.slice(0, st.cursor) + ch + st.input.slice(st.cursor);
        st.setInputCursor(next, st.cursor + ch.length);
        st.setSelIndex(0);
        syncDropdown(next);
      }
    },
    { isActive: state === 'input' },
  );

  function navHistory(dir: number): void {
    const st = store.getState();
    if (history.length === 0) return;
    if (dir < 0) {
      if (histIndex.current === -1) {
        savedDraft.current = st.input;
        histIndex.current = 0;
      } else if (histIndex.current < history.length - 1) {
        histIndex.current++;
      }
      const v = history[histIndex.current] ?? '';
      st.setInputCursor(v, v.length);
    } else {
      if (histIndex.current === -1) return;
      if (histIndex.current > 0) {
        histIndex.current--;
        const v = history[histIndex.current] ?? savedDraft.current;
        st.setInputCursor(v, v.length);
      } else {
        histIndex.current = -1;
        st.setInputCursor(savedDraft.current, savedDraft.current.length);
      }
    }
    st.setSelIndex(0);
  }

  // hidden 态（模型生成中）不渲染输入框。
  if (state === 'hidden') return null;

  const matches = filterCommands(input, commands);
  const dropdownRows = renderDropdown(matches, selIndex, width, height);

  return (
    <Box flexDirection="column">
      {renderInputLine(prompt, input, cursor)}
      {dropdownRows.map((row, i) => (
        <Text key={i}>{row}</Text>
      ))}
    </Box>
  );
}

/** 剥离 ANSI 转义（prompt 可能带 chalk 色），交给 Ink 原生上色避免被 <Text> 剥离。 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * 原生 Ink 渲染输入行（Phase 3 视觉层次重做）：
 *   青色 prompt 字形 + 已输入文本 + 光标处 inverse 块（可见光标，替代原整行底色条）。
 * 原生 Text 自动换行，长输入不再需要手工按宽度截断。
 */
function renderInputLine(prompt: string, input: string, cursor: number): React.ReactElement {
  const before = input.slice(0, cursor);
  const at = input.slice(cursor, cursor + 1);
  const after = input.slice(cursor + 1);
  return (
    <Box>
      <Text color="cyan" bold>{stripAnsi(prompt)}</Text>
      <Text>{before}</Text>
      <Text inverse>{at || ' '}</Text>
      <Text>{after}</Text>
    </Box>
  );
}

/** 渲染斜杠下拉可见行（复用 computeDropdownViewport 的视口/滚动逻辑）。 */
function renderDropdown(
  matches: CommandMeta[],
  selIndex: number,
  width: number,
  height: number,
): string[] {
  if (matches.length === 0) return [];
  const sel = Math.max(0, Math.min(selIndex, matches.length - 1));
  const { viewportStart, maxVisible } = computeDropdownViewport(sel, matches.length, height, 0);
  const visible = matches.slice(viewportStart, viewportStart + maxVisible);
  const reserved = 6 + 16 + 2;
  const maxDesc = Math.max(8, width - reserved);
  return visible.map((c, i) => {
    const isSel = viewportStart + i === sel;
    const name = '/' + c.name;
    let desc = c.description;
    if (desc.length > maxDesc) desc = desc.slice(0, maxDesc - 1) + '…';
    // 选中项加 ❯ 标记（青）+ inverse 整行；未选中用 2 空格占位保持对齐。
    const marker = isSel ? chalk.cyan('❯ ') : '  ';
    const row = `${marker}${chalk.cyan(name.padEnd(14))}  ${chalk.gray(desc)}`;
    return isSel ? chalk.inverse(row) : row;
  });
}

export default InputBox;
