// Transcript 视口计算（纯函数，无 React / ink）。
//
// 等价于旧 status.ts 的裁剪逻辑：
//   content = [...header, ...userTurn, ...body]
//   visible = content.length > bodyAvail ? content.slice(content.length - bodyAvail) : content
// 即「超长从顶部裁剪」，早期内容滚出屏幕，与真实终端滚动一致。

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
}

/** 拼 transcript + 本轮用户输入 + 流式正文，并裁剪到视口高度。 */
export function buildVisibleLines(input: VisibleInput): string[] {
  const content = [...input.transcriptLines, ...input.userTurn, ...input.bodyLines];
  return cropLines(content, input.maxRows);
}
