// PendingDiffs：渲染待展示的代码变更（蓝图维度 ②）。
//
// 读取 store.diffs（由 bridge 在工具产出 diff 时 pushDiff）与 store.diffMode，
// 逐个用 DiffBlock 呈现。无 diff 时整块不渲染（不挤占主区）。
// diffMode 切换：App 在「非输入态」下监听 Ctrl+D（输入态下 Ctrl+D 仍用于退出 REPL）。

import React from 'react';
import { Box } from 'ink';
import type { AppStoreApi } from '../store';
import { useAppStore } from '../hooks';
import { DiffBlock } from './DiffBlock';

export interface PendingDiffsProps {
  store: AppStoreApi;
}

export function PendingDiffs({ store }: PendingDiffsProps): React.ReactElement | null {
  const diffs = useAppStore(store, (s) => s.diffs);
  const mode = useAppStore(store, (s) => s.diffMode);
  if (diffs.length === 0) return null;
  return (
    <Box flexDirection="column">
      {diffs.map((patch, i) => (
        <DiffBlock key={i} patch={patch} mode={mode} />
      ))}
    </Box>
  );
}

export default PendingDiffs;
