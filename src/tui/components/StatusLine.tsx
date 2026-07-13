// StatusLine：footer 动画行（脉动字形 + 标签 + 实时秒数 + `↓ N tokens` + cache 命中率）。
//
// 等价于旧 src/cli/status.ts 的 footerLine()：
//   思考/工具： `✢ 标签 (Ns)[ · cache N%]`
//   流式：      `✢ 生成回复中… (Ns · ↓ N tokens)[ · cache N%]`
//   旋转字形由 ink-spinner 提供；idle 态高度 0（不渲染）。
//
// 变化：不再整段 transcript 重绘 + footerRow 绝对定位；footer 是独立组件，
// 由 Yoga 钉在 Transcript 下方。动画帧由组件内 setInterval(120ms) 驱动，
// 秒数/token 从 store.anim 派生。
//
// 设计依据：docs/tui-ink-design.md §4.2.5。

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { AppStoreApi } from '../store';
import { useAppStore } from '../hooks';

// 本地动画帧：驱动秒数刷新（idle 时不计费）。spinner 字形由 ink-spinner 自身动画提供。
const FRAME_MS = 120;

export interface StatusLineProps {
  store: AppStoreApi;
}

function cacheColor(pct: number): 'green' | 'yellow' | 'red' {
  return pct >= 70 ? 'green' : pct >= 40 ? 'yellow' : 'red';
}

export function StatusLine({ store }: StatusLineProps): React.ReactElement | null {
  const mode = useAppStore(store, (s) => s.anim.mode);
  const label = useAppStore(store, (s) => s.anim.label);
  const startedAt = useAppStore(store, (s) => s.anim.startedAt);
  const estTokens = useAppStore(store, (s) => s.anim.estTokens);
  const cachePct = useAppStore(store, (s) => s.anim.cachePct);

  // 本地动画帧：驱动秒数刷新（spinner 由 ink-spinner 自身动画提供；idle 时不计费）。
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (mode === 'idle') return;
    const timer = setInterval(() => setFrame((f) => f + 1), FRAME_MS);
    if (typeof timer === 'object' && 'unref' in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
    return () => clearInterval(timer);
  }, [mode]);

  // idle：高度 0，不占行（对齐旧 status.ts stop() 移除 footer 行）。
  if (mode === 'idle') return null;

  const sec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const meta = mode === 'stream' ? `(${sec}s · ↓ ${estTokens} tokens)` : `(${sec}s)`;

  return (
    <Box>
      <Spinner type="dots" />
      <Text> </Text>
      <Text bold color="gray">{label}</Text>
      <Text> </Text>
      <Text color="gray">{meta}</Text>
      {cachePct != null && (
        <>
          <Text color="gray"> · </Text>
          <Text color={cacheColor(cachePct)}>cache {cachePct}%</Text>
        </>
      )}
    </Box>
  );
}

export default StatusLine;
