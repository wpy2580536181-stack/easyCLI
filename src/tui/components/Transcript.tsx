// Transcript：主输出区——历史显示行 + 本轮用户输入 + 流式正文（Markdown 实时渲染）。
//
// 等价于旧 src/cli/status.ts 的 transcript 模型，但：
//   - 不再 `\x1b[1;1H\x1b[J` 整段重绘 + 手工算 footerRow；由 Yoga flex 定位。
//   - 流式正文经 renderMarkdown(buffer,width) 产出 ANSI 行，按行透传给 <Text>
//     （Phase 1：TTY 下着色由 markdown 渲染器自带 ANSI 保证；后续如需 Ink 原生着色再接 AnsiText）。
//   - 超长从顶部裁剪（buildVisibleLines），早期内容滚出，与真实终端滚动一致。
//
// 设计依据：docs/tui-ink-design.md §4.2.3 / §7.3。

import React from 'react';
import { Box, Text } from 'ink';
import type { AppStoreApi } from '../store';
import { useAppStore } from '../hooks';
import { buildVisibleLines } from '../transcript';

export interface TranscriptProps {
  store: AppStoreApi;
  /** 流式正文渲染器（TTY 下传 renderMarkdown；非 TTY 传 undefined 走纯文本按行切）。 */
  markdown?: (md: string, width: number) => string[];
  /**
   * 除 Transcript 外其余 UI 占用的行数（footer + StatusBar + 输入框），
   * 用于推导视口高度 maxRows = height - reservedRows。
   */
  reservedRows?: number;
}

export function Transcript({ store, markdown, reservedRows = 0 }: TranscriptProps): React.ReactElement {
  const transcriptLines = useAppStore(store, (s) => s.transcriptLines);
  const splashCount = useAppStore(store, (s) => s.splashCount);
  const userTurn = useAppStore(store, (s) => s.userTurn);
  const assistantBuffer = useAppStore(store, (s) => s.assistantBuffer);
  const width = useAppStore(store, (s) => s.width);
  const height = useAppStore(store, (s) => s.height);

  const bodyLines = assistantBuffer
    ? markdown
      ? markdown(assistantBuffer, width)
      : assistantBuffer.split('\n')
    : [];

  const maxRows = Math.max(1, height - reservedRows);
  const visible = buildVisibleLines({ transcriptLines, userTurn, bodyLines, maxRows });

  // 计算裁剪后仍可见的 splash 行数：splash 位于 transcriptLines 最前，超高时从顶部裁剪，
  // 故最先滚出。visible 的前 visibleSplash 行即 splash，需用 truncate 防拆行。
  const total = transcriptLines.length + userTurn.length + bodyLines.length;
  const removedFromTop = Math.max(0, total - maxRows);
  const visibleSplash = Math.max(0, splashCount - removedFromTop);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.map((line, i) => (
        // 行内容已含 ANSI 样式（splash/markdown），直接透传给 <Text>。index 作 key（行序即身份）。
        // splash 行（前 visibleSplash 行）用 wrap="truncate"：定宽 ASCII 框即便与真实终端
        // 有宽度误差也只右截断，绝不换行拆成多行；普通正文用默认 wrap 保证不丢内容。
        <Text key={i} wrap={i < visibleSplash ? 'truncate' : 'wrap'}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

export default Transcript;
