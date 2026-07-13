// 输入编辑器（纯函数部分）。
//
// Phase F：原先的 LineEditor 类（raw mode 自绘输入框 + 斜杠下拉 + HITL 审批）已整体迁入
// Ink 的 <InputBox> 组件（src/tui/components/InputBox.tsx，用 useInput 收键）。此处只保留
// 被 TTY/非 TTY 两端共用的纯函数：
//   - computeDropdownViewport：斜杠下拉可视窗口计算（InputBox 复用）。
//   - paintInputBox / paintBoxLine / displayWidth：把「提示符 + 输入」渲染成带输入框底色的
//     永久行，作为 transcript 中本轮 userTurn 的一段（与输入框消失后的渲染保持一致）。

import { ui } from './theme';

/**
 * 计算斜杠下拉菜单的「可视窗口」：限制最大高度（上限 10 行，且不向上吞掉
 * topReserve 预留区上方的 transcript 历史），并让选中项始终落在可视区内。
 *
 * 纯函数，便于单测（不依赖 TTY / this）。
 * @returns maxVisible 最多显示几项；viewportStart 可见区在 matches 中的起始下标。
 */
export function computeDropdownViewport(
  selIndex: number,
  matchesLen: number,
  rows: number,
  topReserve: number,
): { maxVisible: number; viewportStart: number } {
  // 限制下拉最大高度：上限 10 行，且不能超出 topReserve 上方可用空间。
  const available = Math.max(2, rows - topReserve - 4);
  const maxVisible = Math.min(10, available);
  // 滚动视口：选中项向下移出底部时视口跟随下移；向上移出顶部时视口跟随上移。
  let viewportStart = 0;
  if (selIndex >= maxVisible) {
    viewportStart = selIndex - maxVisible + 1;
  }
  viewportStart = Math.max(0, Math.min(viewportStart, matchesLen - maxVisible));
  return { maxVisible, viewportStart };
}

/** 单个字符的显示宽度（CJK 等宽字符按 2，其余按 1），忽略 ANSI 转义 */
function displayWidth(s: string): number {
  const strip = s.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of strip) {
    w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  }
  return w;
}

/**
 * 把一行内容渲染成「整行带输入框底色」：内容 + 右侧补空格到终端宽度，
 * 这样行末到屏幕右边缘都有底色（不再只有文字部分有底色、后边空着）。
 */
function paintBoxLine(content: string, width: number): string {
  const pad = Math.max(0, width - displayWidth(content));
  return ui.inputBg(content + ' '.repeat(pad));
}

/**
 * 把可能含换行的内容逐行刷底色（多行输入 / 粘贴的多行提交都各自撑满整行）。
 * 导出给 REPL：提交一行时把「提示符 + 输入」渲染成带底色的永久行，作为 transcript
 * 中本轮 userTurn 的一段（与输入框消失后的渲染保持一致）。
 */
export function paintInputBox(text: string, width: number): string {
  return text.split('\n').map((ln) => paintBoxLine(ln, width)).join('');
}
