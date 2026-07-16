// Sidebar：左侧文件树 + 会话面板（蓝图维度 ①③）。
//
// 固定宽栏，展示 FILES（git 状态角标 M/A/D/R/?/U + 暂存 ✓）与 SESSIONS（对话树）。
// 窄屏（<90 列）或 sidebarOpen=false 时整栏不渲染（维度 ⑦ 尺寸自适应）。
// 数据由 bridge 注入 store.files / store.sessions；缺省为空时给出占位提示。

import React from 'react';
import { Box, Text } from 'ink';
import type { AppStoreApi } from '../store';
import { useAppStore } from '../hooks';
import { TOKENS } from '../tokens';
import type { FileStatusKind } from '../store';

const SIDEBAR_W = 28;

const STATUS_COLOR: Record<FileStatusKind, string> = {
  M: TOKENS.warning,
  A: TOKENS.success,
  D: TOKENS.error,
  R: TOKENS.brand,
  '?': TOKENS.subtext,
  U: TOKENS.error,
};

export interface SidebarProps {
  store: AppStoreApi;
}

export function Sidebar({ store }: SidebarProps): React.ReactElement | null {
  const open = useAppStore(store, (s) => s.sidebarOpen);
  const width = useAppStore(store, (s) => s.width);
  const height = useAppStore(store, (s) => s.height);
  const files = useAppStore(store, (s) => s.files);
  const sessions = useAppStore(store, (s) => s.sessions);
  const branch = useAppStore(store, (s) => s.branch);

  // 尺寸自适应：窄屏不显示侧栏（蓝图维度 ⑦）。
  if (!open || width < 90) return null;

  return (
    <Box
      flexDirection="column"
      width={SIDEBAR_W}
      height={height}
      paddingX={1}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      borderRight
      borderColor={TOKENS.subtext}
    >
      <Text color={TOKENS.subtext}>{`FILES · ${branch || 'main'}`}</Text>
      <Box height={1} />
      {files.length === 0 ? (
        <Text color={TOKENS.subtext}>  (暂无变更)</Text>
      ) : (
        files.map((f, i) => (
          <Box key={i}>
            <Text color={STATUS_COLOR[f.status]}>{f.status}</Text>
            <Text color={f.staged ? TOKENS.text : TOKENS.subtext}>{` ${f.path}`}</Text>
            {f.staged && <Text color={TOKENS.success}> ✓</Text>}
          </Box>
        ))
      )}

      <Box height={1} />
      <Text color={TOKENS.subtext}>SESSIONS</Text>
      <Box height={1} />
      {sessions.length === 0 ? (
        <Text color={TOKENS.subtext}>  (暂无会话)</Text>
      ) : (
        sessions.map((s, i) => (
          <Box key={i}>
            <Text color={s.active ? TOKENS.primary : TOKENS.subtext}>
              {`${s.active ? '▸ ' : '  '}${s.title}`}
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}

export default Sidebar;
