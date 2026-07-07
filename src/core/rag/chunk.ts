// Phase 6（RAG）：文本分块。把长文档切成有重叠、尽量不劈断句子的片段，
// 便于后续逐块嵌入与检索——块越小，检索粒度越细、注入上下文越精准。

export interface ChunkOptions {
  /** 每块目标字符数，默认 400 */
  size?: number;
  /** 相邻块重叠字符数，默认 80（重叠可避免跨块语义被截断） */
  overlap?: number;
}

/**
 * 把文本切成若干块：
 * - 优先在句末/空行/句号处切断，避免把一句话劈成两半；
 * - 块之间保留 overlap 重叠，缓解「答案恰好横跨切分点」导致检索不到的问题。
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const size = opts.size ?? 400;
  const overlap = opts.overlap ?? 80;
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  // 短文本整段作为一块
  if (clean.length <= size) return [clean];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    // 在非末尾处切分时，向前找最近的「自然边界」（空行 > 换行 > 句号）
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const lastBreak = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
        window.lastIndexOf('。'),
        window.lastIndexOf('.'),
      );
      if (lastBreak > size * 0.4) end = start + lastBreak; // 至少切到 40% 处，避免无限前移
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
