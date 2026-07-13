// SplashTitle：TTY 下的品牌大标题头部（固定钉在 Transcript 上方，不随历史滚动）。
//
// 用 ink-big-text（底层 cfonts）渲染大字「easyCLI」，并借 Ink 的 <Text color> 真正上色
// （裸 ANSI 会被 Ink 的 <Text> 剥离，故不能走 transcript 文本行模型）。窄终端（<62 列）
// 回退到更紧凑的 chrome 字体避免溢出换行。
//
// 设计依据：docs/ink-ui-research.md Phase 1。

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

  return (
    <Box flexDirection="column" alignItems="center" width={cols}>
      <BigText text="easyCLI" font={font} colors={['cyan', 'magenta']} />
      <Text color="gray">
        {tagline ?? `v${version} · AI-assisted CLI agent`}
      </Text>
      <Text> </Text>
    </Box>
  );
}

export default SplashTitle;
