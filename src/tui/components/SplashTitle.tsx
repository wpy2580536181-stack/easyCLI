// SplashTitle：TTY 下的品牌电影级大标题头部（固定钉在 Transcript 上方，不随历史滚动）。
//
// 用 ink-big-text（底层 cfonts）渲染大字「easyCLI」，并借 Ink 的 <Text color> 真正上色
// （裸 ANSI 会被 Ink 的 <Text> 剥离，故不能走 transcript 文本行模型——这正是 ink-big-text
// 存在的意义：它是 cfonts 在 Ink 里唯一能正确上色的桥）。
//
// 电影感来源（Phase 3）：三色渐变 cyan→magenta→white + 字间距 letterSpacing + 标语 +
// 标题与信息框之间一条细分割线做视觉分层。窄终端（<62 列）回退 chrome 字体避免溢出。
//
// 设计依据：用户 Phase 3 计划（cfonts 电影级 splash + 视觉层次）。

import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { createRequire } from 'node:module';
import BigText from 'ink-big-text';

const require = createRequire(import.meta.url);
let pkg: { version?: string };
try {
  pkg = require('../../../package.json') as { version?: string };
} catch {
  pkg = {};
}

export interface SplashTitleProps {
  /** 标语副标题（可选）。 */
  tagline?: string;
}

export function SplashTitle({ tagline }: SplashTitleProps = {}): React.ReactElement {
  // 窄终端回退：block 字体约 59 列宽，chrome 约 26 列宽。
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const font = cols < 62 ? 'chrome' : 'block';
  const version = pkg.version ?? '0.0.0';

  // 电影级分隔线：标题与下方信息框之间的视觉分层（细、克制的灰色横线）。
  const rule = '─'.repeat(Math.min(48, Math.max(12, cols - 16)));

  return (
    <Box flexDirection="column" alignItems="center" width={cols}>
      <BigText
        text="easyCLI"
        font={font}
        colors={['cyan', 'magenta', 'white']}
        letterSpacing={1}
      />
      <Text color="gray">
        {tagline ?? `v${version} · your from-scratch AI terminal agent`}
      </Text>
      <Text color="gray">{rule}</Text>
      <Text> </Text>
    </Box>
  );
}

export default SplashTitle;
