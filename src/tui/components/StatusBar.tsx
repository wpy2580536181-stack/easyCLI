// StatusBar：屏幕最底状态条。
//
// 等价于旧 src/cli/statusbar.ts 的 build()：字段用 ` · ` 分隔——
//   模型(青) · 分支(灰) · [ctx%(灰/≥80黄)] · ¥成本(绿) · 时长(灰) · 模式(绿正常/黄规划)
//
// 变化：不再绝对定位 `ESC[rows;1H` + setCaret 手工协调，改由 Yoga 布局钉在底部；
// 每秒刷新由 useClock→tickClock 驱动（订阅 clock 切片触发重渲染），
// 取代旧类的 setInterval(render)。
//
// 设计依据：docs/tui-ink-design.md §4.2.4。

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
  const costText = useAppStore(store, (s) => s.costText);
  const showCtx = useAppStore(store, (s) => s.showCtx);
  const ctxPct = useAppStore(store, (s) => s.ctxPct);
  const startedAt = useAppStore(store, (s) => s.startedAt);
  // 订阅 clock：useClock 每秒 tick，驱动时长刷新（等价旧类 setInterval 每秒 render）。
  useAppStore(store, (s) => s.clock);

  // --no-statusline：整条不渲染（对齐旧 enabled=false）。
  if (!enabled) return null;

  const segs: React.ReactElement[] = [];
  segs.push(<Text key="model" color="cyan">{model}</Text>);
  segs.push(<Text key="branch" color="gray">{branch}</Text>);
  if (showCtx && ctxPct != null) {
    segs.push(
      <Text key="ctx" color={ctxPct >= 80 ? 'yellow' : 'gray'}>
        {ctxPct}% ctx
      </Text>,
    );
  }
  segs.push(<Text key="cost" color="green">{costText}</Text>);
  segs.push(<Text key="dur" color="gray">{formatDuration(Date.now() - startedAt)}</Text>);
  // 模式标签：正常(绿) / 规划(黄)，纯文本着色（Phase 1，未引入 @inkjs/ui）。
  segs.push(
    <Text key="mode" color={mode === 'plan' ? 'yellow' : 'green'}>
      {mode === 'plan' ? '规划' : '正常'}
    </Text>,
  );

  return (
    <Box>
      {segs.map((seg, i) => (
        <React.Fragment key={seg.key}>
          {i > 0 && <Sep />}
          {seg}
        </React.Fragment>
      ))}
    </Box>
  );
}

export default StatusBar;
