// Approval：HITL 审批覆盖层（y/n/a）。
//
// 等价于旧 src/cli/line-editor.ts 的 ask()：
//   - 显示提问，用户键入答案（缓冲显示），Enter 以 trim 后的缓冲 resolve；
//   - 防抖窗口内忽略首回车（避免确认框刚弹出被残留/自动重复回车误放行）；
//   - Ctrl+C → resolve 'n'（拒绝）；Ctrl+D → resolve ''（视为放弃）。
//
// 变化：不再 raw mode 手写回显；Ink useInput 收键，Yoga 定位为覆盖层。
//
// 设计依据：docs/tui-ink-design.md §4.2.7。

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppStoreApi } from '../store';
import { useAppStore } from '../hooks';

export interface ApprovalProps {
  store: AppStoreApi;
}

export function Approval({ store }: ApprovalProps): React.ReactElement | null {
  const approval = useAppStore(store, (s) => s.approval);
  const [buffer, setBuffer] = useState('');

  useInput(
    (ch, key) => {
      const st = store.getState();
      const cur = st.approval;
      if (!cur) return;

      if (key.ctrl && ch === 'c') {
        setBuffer('');
        st.resolveApproval('n');
        return;
      }
      if (key.ctrl && ch === 'd') {
        setBuffer('');
        st.resolveApproval('');
        return;
      }
      if (key.return) {
        // 防抖窗口内：忽略首回车。
        if (cur.readyAt && Date.now() < cur.readyAt) return;
        const ans = buffer.trim();
        setBuffer('');
        st.resolveApproval(ans);
        return;
      }
      if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
        return;
      }
      if (ch && !key.ctrl && !key.meta) {
        setBuffer((b) => b + ch);
      }
    },
    { isActive: !!approval },
  );

  if (!approval) return null;

  return (
    <Box flexDirection="column">
      <Text color="yellow">需要审批：</Text>
      <Text color="gray">{approval.question}</Text>
      <Box>
        <Text color="gray">{'  '}</Text>
        <Text color="yellow">{buffer}</Text>
      </Box>
    </Box>
  );
}

export default Approval;
