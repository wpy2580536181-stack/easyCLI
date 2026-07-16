// TopStatusBar：顶栏状态条（蓝图维度 ⑥⑦，复用 StatusBar 同款字段，但置于顶部）。
//
// 左组：模型(primary) · 分支(subtext) · ctx%(subtext/≥80 warning) · 累计 token(success) · 时长(subtext)
// 右端：● 模式（正常 green / 规划 yellow）。配色统一用 TOKENS（单一真理来源）。
// 每秒由 useClock→tickClock 驱动时长刷新。

import React from 'react';
import { Box, Text } from 'ink';
import type { AppStoreApi } from '../store';
import { useAppStore } from '../hooks';
import { TOKENS } from '../tokens';
import { formatDuration } from '../format';

export interface TopStatusBarProps {
  store: AppStoreApi;
}

export function TopStatusBar({ store }: TopStatusBarProps): React.ReactElement {
  const enabled = useAppStore(store, (s) => s.statuslineEnabled);
  const model = useAppStore(store, (s) => s.model);
  const branch = useAppStore(store, (s) => s.branch);
  const mode = useAppStore(store, (s) => s.mode);
  const tokenText = useAppStore(store, (s) => s.tokenText);
  const showCtx = useAppStore(store, (s) => s.showCtx);
  const ctxPct = useAppStore(store, (s) => s.ctxPct);
  const startedAt = useAppStore(store, (s) => s.startedAt);
  const width = useAppStore(store, (s) => s.width);
  useAppStore(store, (s) => s.clock);

  if (!enabled) return <Box />;

  const w = width || 80;
  const left: React.ReactElement[] = [];
  left.push(<Text key="model" color={TOKENS.primary} bold>{model}</Text>);
  left.push(<Text key="branch" color={TOKENS.subtext}>{branch}</Text>);
  if (showCtx && ctxPct != null) {
    left.push(
      <Text key="ctx" color={ctxPct >= 80 ? TOKENS.warning : TOKENS.subtext}>
        {`${ctxPct}% ctx`}
      </Text>,
    );
  }
  left.push(<Text key="tok" color={TOKENS.success}>{tokenText}</Text>);
  left.push(<Text key="dur" color={TOKENS.subtext}>{formatDuration(Date.now() - startedAt)}</Text>);

  const modeNode = (
    <Text key="mode" color={mode === 'plan' ? TOKENS.warning : TOKENS.success}>
      {`● ${mode === 'plan' ? '规划' : '正常'}`}
    </Text>
  );

  const leftRow = (
    <Box>
      {left.map((seg, i) => (
        <React.Fragment key={seg.key}>
          {i > 0 && <Text color={TOKENS.subtext}> · </Text>}
          {seg}
        </React.Fragment>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column">
      <Box width={w}>
        {leftRow}
        <Box flexGrow={1} />
        {modeNode}
      </Box>
      <Box width={w}>
        <Text color={TOKENS.subtext}>{'─'.repeat(Math.max(0, w))}</Text>
      </Box>
    </Box>
  );
}

export default TopStatusBar;
