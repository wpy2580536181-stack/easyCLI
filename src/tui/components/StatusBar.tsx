// StatusBar：屏幕最底状态条（Phase 3 视觉层次重做）。
//
// 等价旧 src/cli/statusbar.ts 的字段，但视觉上拆成「独立状态条」：
//   - 顶部一条细分割线（灰 ─）把状态条与上方 Transcript/StatusLine 分层；
//   - 左组：模型(青) · 分支(灰) · [ctx%(灰/≥80黄)] · 累计 token(绿) · 时长(灰)，`·` 分隔；
//   - 右端：● 模式（正常绿 / 规划黄）右对齐——用 flexGrow 撑开。
//
// 每秒刷新由 useClock→tickClock 驱动（订阅 clock 切片触发重渲染）。
//
// 设计依据：用户 Phase 3（Charm/clack 视觉层次）。

import React from 'react';
import { Box, Text } from 'ink';
import type { AppStoreApi } from '../store';
import { useAppStore } from '../hooks';
import { formatDuration } from '../format';

export interface StatusBarProps {
  store: AppStoreApi;
}

const Sep = (): React.ReactElement => <Text color="gray"> · </Text>;

export function StatusBar({ store }: StatusBarProps): React.ReactElement | null {
  const enabled = useAppStore(store, (s) => s.statuslineEnabled);
  const model = useAppStore(store, (s) => s.model);
  const branch = useAppStore(store, (s) => s.branch);
  const mode = useAppStore(store, (s) => s.mode);
  const tokenText = useAppStore(store, (s) => s.tokenText);
  const showCtx = useAppStore(store, (s) => s.showCtx);
  const ctxPct = useAppStore(store, (s) => s.ctxPct);
  const startedAt = useAppStore(store, (s) => s.startedAt);
  const width = useAppStore(store, (s) => s.width);
  // 订阅 clock：useClock 每秒 tick，驱动时长刷新（等价旧类 setInterval 每秒 render）。
  useAppStore(store, (s) => s.clock);

  // --no-statusline：整条不渲染（对齐旧 enabled=false）。
  if (!enabled) return null;

  const w = width || 80;

  // 左组：上下文信息（保持 · 分隔与字段文案，满足既有测试）。
  const left: React.ReactElement[] = [];
  left.push(<Text key="model" color="cyan" bold>{model}</Text>);
  left.push(<Text key="branch" color="gray">{branch}</Text>);
  if (showCtx && ctxPct != null) {
    left.push(
      <Text key="ctx" color={ctxPct >= 80 ? 'yellow' : 'gray'}>
        {ctxPct}% ctx
      </Text>,
    );
  }
  left.push(<Text key="token" color="green">{tokenText}</Text>);
  left.push(<Text key="dur" color="gray">{formatDuration(Date.now() - startedAt)}</Text>);

  // 右端：模式指示（● 圆点 + 文案），正常绿 / 规划黄。
  const modeNode = (
    <Text key="mode" color={mode === 'plan' ? 'yellow' : 'green'}>
      {'● '}
      {mode === 'plan' ? '规划' : '正常'}
    </Text>
  );

  const leftRow = (
    <Box>
      {left.map((seg, i) => (
        <React.Fragment key={seg.key}>
          {i > 0 && <Sep />}
          {seg}
        </React.Fragment>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column">
      {/* 顶部细分割线：把状态条与上方内容分层 */}
      <Box width={w}>
        <Text color="gray">{'─'.repeat(Math.max(0, w))}</Text>
      </Box>
      {/* 左组 + 撑开 + 右端模式 */}
      <Box width={w}>
        {leftRow}
        <Box flexGrow={1} />
        {modeNode}
      </Box>
    </Box>
  );
}

export default StatusBar;
