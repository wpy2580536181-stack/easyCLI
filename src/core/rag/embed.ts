// Phase 6（RAG）：纯手写文本嵌入 + 余弦相似度，零依赖、确定性、可测试。
//
// 为什么手写而不引 sentence-transformers / OpenAI embeddings：
// 1. 项目硬约束「纯从零手写、依赖克制」；
// 2. 手写能把 RAG 的每一步（分词 → 哈希降维 → TF-IDF 加权 → 归一化 → 余弦）讲透；
// 3. 不依赖网络/模型权重，单测可确定性回归。
//
// 关键技巧：
// - 「哈希技巧（hashing trick）」：把任意词项映射到固定维度，词汇表无限大也不爆内存，
//   这是 Vowpal Wabbit 等生产系统的经典做法。
// - 字符级 n-gram：中文没有空格，必须靠字符 unigram/bigram 才能度量语义重叠。

export const EMBED_DIM = 1024;

/** 向量类型别名（Float32Array），让「嵌入向量」在签名里语义更清晰 */
export type Embedding = Float32Array;

/** FNV-1a 32 位哈希（稳定、分布均匀） */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 分词：拉丁/数字词 + 字符 unigram/bigram。
 * 字符 n-gram 让中文（无空格）也能被切出可重叠的「词项」，从而度量相似度。
 */
export function tokenize(text: string): string[] {
  const terms: string[] = [];
  const lower = text.toLowerCase();
  const wordRe = /[a-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(lower))) terms.push(m[0]);

  // Array.from 按 Unicode 码点切分，正确处理中文/emoji
  const chars = Array.from(lower);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (/\s/.test(c)) continue;
    terms.push('c:' + c); // unigram
    const nxt = chars[i + 1];
    if (nxt !== undefined && !/\s/.test(nxt)) terms.push('c:' + c + nxt); // bigram
  }
  return terms;
}

/** 余弦相似度（已 L2 归一化时即点积，这里仍按定义算，更稳健） */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 把词项序列嵌入为固定维度稠密向量。
 * @param terms 已分好的词项
 * @param idf   逆文档频率表（可选）；不传则退化为纯 TF（词频）加权
 * @returns L2 归一化后的 Float32Array
 */
export function embed(terms: string[], idf?: Map<string, number>): Float32Array {
  const vec = new Float32Array(EMBED_DIM);
  const tf = new Map<string, number>();
  for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);

  for (const [term, freq] of tf) {
    const idfW = idf ? idf.get(term) ?? 1 : 1;
    const dim = hash32(term) % EMBED_DIM;
    vec[dim]! += freq * idfW;
  }

  let sum = 0;
  for (let i = 0; i < EMBED_DIM; i++) sum += vec[i]! * vec[i]!;
  const len = Math.sqrt(sum);
  if (len > 0) for (let i = 0; i < EMBED_DIM; i++) vec[i]! /= len;
  return vec;
}

/** 由「词项 → 文档频率(df)」计算平滑 IDF：log(1 + N/(1+df)) */
export function computeIdf(termDf: Map<string, number>, totalDocs: number): Map<string, number> {
  const idf = new Map<string, number>();
  for (const [term, df] of termDf) idf.set(term, Math.log(1 + totalDocs / (1 + df)));
  return idf;
}
