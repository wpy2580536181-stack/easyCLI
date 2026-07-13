// Transcript 视口计算（纯函数，无 React / ink）。
//
// 等价于旧 status.ts 的裁剪逻辑，但支持应用内滚动：
//   content = [...transcriptLines, ...userTurn, ...body]
//   - scrollOffset === 0：贴底，显示末尾 maxRows 行（旧行为）；
//   - scrollOffset > 0：视口上移 N 行（从底部算），用于回看历史。

/** 超长时从顶部裁剪，保留末尾 maxRows 行。 */
export function cropLines(lines: string[], maxRows: number): string[] {
  if (maxRows <= 0) return [];
  return lines.length > maxRows ? lines.slice(lines.length - maxRows) : lines;
}

export interface VisibleInput {
  transcriptLines: string[];
  userTurn: string[];
  bodyLines: string[];
  maxRows: number;
  /** 距底部上滚行数；0 = 贴底（默认）。 */
  scrollOffset?: number;
}

/**
 * 拼 transcript + 本轮用户输入 + 流式正文，并按 scrollOffset 截取视口窗口。
 * - 内容不足 maxRows：整段显示；
 * - 否则取 [total - maxRows - off, total - off) 这一段（off 已夹取到合法范围）。
 */
export function buildVisibleLines(input: VisibleInput): string[] {
  const content = [...input.transcriptLines, ...input.userTurn, ...input.bodyLines];
  const total = content.length;
  const maxRows = input.maxRows;
  if (maxRows <= 0) return [];
  if (total <= maxRows) return content; // 全部装得下，整段显示（贴顶）
  const off = Math.max(0, Math.min(input.scrollOffset ?? 0, total - maxRows));
  const end = total - off;
  const start = Math.max(0, end - maxRows);
  return content.slice(start, end);
}
