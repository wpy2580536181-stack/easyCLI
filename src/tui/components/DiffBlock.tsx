// DiffBlock：代码变更可视化（蓝图维度 ②）。
//
// 默认行内(unified) + 可切并排(split)；新增绿/删除红/修改黄/上下文灰，
// 全部取自 TOKENS（与 StatusBar/InputBox 共用同一配色真理来源）。
// 组件只负责「按 kind 上色 + 画 gutter 色条 + 行号」；解析由 diff.ts 纯函数完成。

import React from 'react';
import { Box, Text } from 'ink';
import { TOKENS } from '../tokens';
import { parseUnifiedDiff, diffStats, toSplitPairs, type DiffLine } from '../diff';

export interface DiffBlockProps {
  /** unified diff 文本（可含蓝图自定义 `~` 修改标记）。 */
  patch: string;
  /** 视图：行内 / 并排。由父级（待定 diff）按 store.diffMode 控制。 */
  mode: 'unified' | 'split';
}

const GUTTER: Record<string, string | undefined> = {
  add: TOKENS.success,
  del: TOKENS.error,
  mod: TOKENS.warning,
  ctx: undefined,
  file: undefined,
  hunk: undefined,
};
const TEXT_COLOR: Record<string, string> = {
  add: TOKENS.success,
  del: TOKENS.error,
  mod: TOKENS.warning,
  ctx: TOKENS.subtext,
  file: TOKENS.subtext,
  hunk: TOKENS.subtext,
};
const PREFIX: Record<string, string> = { add: '+', del: '-', mod: '~', ctx: ' ', file: ' ', hunk: ' ' };

function firstPath(lines: DiffLine[]): string {
  const f = lines.find((l) => l.kind === 'file');
  return f ? f.text.replace(/^a\//, '').replace(/^b\//, '') : 'changes';
}

export function DiffBlock({ patch, mode }: DiffBlockProps): React.ReactElement {
  const lines = parseUnifiedDiff(patch);
  const stats = diffStats(lines);
  const path = firstPath(lines);
  const unchanged = lines.length > 0 && stats.add + stats.del + stats.mod === 0;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={TOKENS.subtext} paddingX={1} marginY={1}>
      <Box>
        <Text color={TOKENS.subtext}>
          {`@@ ${path}  (${mode})  —  ${mode === 'unified' ? '行内 diff' : '并排 diff'}`}
        </Text>
      </Box>

      {mode === 'unified' ? (
        <Box flexDirection="column">
          {lines.map((l, i) => (
            <Box key={i}>
              <Box width={1} backgroundColor={GUTTER[l.kind]} />
              <Text color={TEXT_COLOR[l.kind]}>
                {PREFIX[l.kind] + l.text}
              </Text>
            </Box>
          ))}
        </Box>
      ) : (
        <SplitView lines={lines} />
      )}

      <Box>
        <Text color={TOKENS.subtext}>
          {unchanged
            ? '无差异'
            : `+ ${stats.add}  - ${stats.del}  ~ ${stats.mod}   (${stats.add + stats.del + stats.mod} 行变更)`}
          {'   '}
          <Text color={TOKENS.primary}>{mode === 'unified' ? 'Ctrl+D 切并排视图' : 'Ctrl+D 切行内视图'}</Text>
        </Text>
      </Box>
    </Box>
  );
}

function SplitView({ lines }: { lines: DiffLine[] }): React.ReactElement {
  const pairs = toSplitPairs(lines);
  return (
    <Box flexDirection="row">
      <Box flexGrow={1} flexDirection="column" borderStyle="single" borderRight>
        {pairs.map((p, i) => (
          <Box key={`l${i}`}>
            <Box width={1} backgroundColor={GUTTER[p.oldLine?.kind ?? 'ctx']} />
            <Text color={TEXT_COLOR[p.oldLine?.kind ?? 'ctx']}>
              {PREFIX[p.oldLine?.kind ?? 'ctx'] + (p.oldLine?.text ?? '')}
            </Text>
          </Box>
        ))}
      </Box>
      <Box flexGrow={1} flexDirection="column">
        {pairs.map((p, i) => (
          <Box key={`r${i}`}>
            <Box width={1} backgroundColor={GUTTER[p.newLine?.kind ?? 'ctx']} />
            <Text color={TEXT_COLOR[p.newLine?.kind ?? 'ctx']}>
              {PREFIX[p.newLine?.kind ?? 'ctx'] + (p.newLine?.text ?? '')}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export default DiffBlock;
