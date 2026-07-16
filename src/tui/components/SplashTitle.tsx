// SplashTitle：TTY 下的品牌电影级大标题头部（固定钉在 Transcript 上方，不随历史滚动）。
//
// 用 cfonts 渲染大字「easyCLI」，逐行拆分为独立 <Text> 组件（而非 ink-big-text 的单个
// <Text> 包裹整段 ANSI），让 Ink 能逐行追踪光标、正确清除旧帧，避免重渲染时帧堆叠。
//
// 电影感来源（Phase 3）：三色渐变 cyan→magenta→white + 字间距 letterSpacing + 标题与信息框
// 之间一条细分割线做视觉分层。窄终端（<62 列）回退 chrome 字体避免溢出。

import React, { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import CFonts from 'cfonts';

/** 缓存 cfonts 输出：同一 font 只算一次，避免每秒 re-render 重复调用 cfonts。 */
const fontCache = new Map<string, string[]>();

function getBigTextLines(font: string): string[] {
  const cached = fontCache.get(font);
  if (cached) return cached;
  const result = CFonts.render('easyCLI', {
    font,
    colors: ['cyan', 'magenta', 'white'],
    letterSpacing: 1,
    lineHeight: 1,
    space: false, // 去掉首尾空行，减少占用高度
  });
  const lines = result.string.split('\n').filter((l) => l.length > 0 || result.string.indexOf('\n') >= 0);
  // 过滤纯空行（cfonts 有时在首尾产生空行）
  const trimmed = lines.filter((l, i, arr) => {
    if (i === 0 && l.trim() === '') return false;
    if (i === arr.length - 1 && l.trim() === '') return false;
    return true;
  });
  fontCache.set(font, trimmed);
  return trimmed;
}

export function SplashTitle(): React.ReactElement {
  // 窄终端回退：block 字体约 59 列宽，chrome 约 26 列宽。
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const font = cols < 62 ? 'chrome' : 'block';

  // 缓存 cfonts 输出：只在 font 变化时重算（font 仅由终端宽度决定，极少变化）。
  const bigLines = useMemo(() => getBigTextLines(font), [font]);

  // 电影级分隔线：标题与下方信息框之间的视觉分层（细、克制的灰色横线）。
  const rule = '─'.repeat(Math.min(48, Math.max(12, cols - 16)));

  return (
    <Box flexDirection="column" alignItems="center" width={cols}>
      {bigLines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      <Text color="gray">{rule}</Text>
      <Text> </Text>
    </Box>
  );
}

export default React.memo(SplashTitle);
