// 代码差异解析与渲染模型（纯函数，无 React / ink 依赖）。
//
// 对应蓝图维度 ②「代码差异展示」：解析 unified diff（以及蓝图自定义 `~` 修改标记），
// 输出可供 Ink 组件上色的结构化行；并支持行内(unified) 与并排(split) 两种视图。
// 配色由调用方用 TOKENS 上色，本模块只负责「分诊 + 配对」，不碰颜色。

export type DiffKind = 'file' | 'hunk' | 'add' | 'del' | 'ctx' | 'mod';

export interface DiffLine {
  kind: DiffKind;
  /** 行文本（不含首字符 +/-/~/空格 前缀；组件自行绘制 gutter）。 */
  text: string;
  /** mod 行的旧版本文本（仅 mod 有），用于 split 视图左栏。 */
  oldText?: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffStats {
  add: number;
  del: number;
  mod: number;
}

/**
 * 解析 unified diff 文本为结构化行。
 * - `+++ ` / `--- ` / `diff --git` / `index ` → file 标记
 * - `@@ ... @@` → hunk 标记
 * - `+`（非 `+++`）→ add
 * - `-`（非 `---`）→ del
 * - `~` → mod（蓝图自定义「修改」标记，整行即新版本）
 * - 其余 → ctx（上下文）
 * 相邻 del→add 合并为一行 `mod`（文本取新版本，oldText 存旧版本），匹配蓝图
 * 「~ return next() // 旧: next(sess)」的呈现，且让 footer 的 ~ 计数准确。
 */
export function parseUnifiedDiff(patch: string): DiffLine[] {
  const raw = patch.split('\n');
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      out.push({ kind: 'file', text: line.replace(/^(\+\+\+|---) /, '') });
      continue;
    }
    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
      }
      out.push({ kind: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('~')) {
      out.push({ kind: 'mod', text: line.slice(1), oldNo: oldNo, newNo: newNo });
      newNo++;
      continue;
    }
    if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1), newNo: newNo });
      newNo++;
      continue;
    }
    if (line.startsWith('-')) {
      // 前瞻：下一行是 add → 合并为 mod
      const next = raw[i + 1];
      if (next && next.startsWith('+')) {
        out.push({
          kind: 'mod',
          text: next.slice(1),
          oldText: line.slice(1),
          oldNo: oldNo,
          newNo: newNo,
        });
        newNo++;
        i++; // 跳过下一行（已被合并）
        continue;
      }
      out.push({ kind: 'del', text: line.slice(1), oldNo: oldNo });
      oldNo++;
      continue;
    }
    if (line === '') {
      out.push({ kind: 'ctx', text: '' });
      oldNo++;
      newNo++;
      continue;
    }
    out.push({ kind: 'ctx', text: line.replace(/^ /, ''), oldNo: oldNo, newNo: newNo });
    oldNo++;
    newNo++;
  }
  return out;
}

/** 统计 add / del / mod 行数（供 footer「+a -d ~m」）。 */
export function diffStats(lines: DiffLine[]): DiffStats {
  let add = 0;
  let del = 0;
  let mod = 0;
  for (const l of lines) {
    if (l.kind === 'add') add++;
    else if (l.kind === 'del') del++;
    else if (l.kind === 'mod') mod++;
  }
  return { add, del, mod };
}

export interface SplitPair {
  oldLine?: DiffLine;
  newLine?: DiffLine;
  isCtx: boolean;
}

/**
 * 将行序列转为并排视图的逐行配对：
 * - ctx/file/hunk → 两侧同行
 * - mod → 左旧(按 del 呈现) / 右新
 * - 孤立 del → 仅左；孤立 add → 仅右
 */
export function toSplitPairs(lines: DiffLine[]): SplitPair[] {
  const pairs: SplitPair[] = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.kind === 'ctx' || ln.kind === 'file' || ln.kind === 'hunk') {
      pairs.push({ oldLine: ln, newLine: ln, isCtx: true });
      i++;
    } else if (ln.kind === 'mod') {
      pairs.push({
        oldLine: { ...ln, kind: 'del', text: ln.oldText ?? ln.text },
        newLine: ln,
        isCtx: false,
      });
      i++;
    } else if (ln.kind === 'del') {
      if (lines[i + 1] && lines[i + 1].kind === 'add') {
        pairs.push({ oldLine: ln, newLine: lines[i + 1], isCtx: false });
        i += 2;
      } else {
        pairs.push({ oldLine: ln, isCtx: false });
        i++;
      }
    } else if (ln.kind === 'add') {
      pairs.push({ newLine: ln, isCtx: false });
      i++;
    } else {
      pairs.push({ oldLine: ln, newLine: ln, isCtx: true });
      i++;
    }
  }
  return pairs;
}
