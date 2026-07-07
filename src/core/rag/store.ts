// Phase 6（RAG）：向量检索仓库（RagStore）。
// 复用 Phase 4 的 node:sqlite + createRequire 模式；向量以 BLOB 存库。
//
// 设计：
// - 语料来自一组「源」（文件或目录），reindex() 清空并按全局 IDF 重建索引；
// - 每块 = 一段文本 + 其嵌入向量 + 所属源；
// - 检索时把 query 嵌入，与库内所有块向量做余弦，取 top-k。
// 线性扫描 O(N·D) 对学习项目足够；生产会用 ANN 索引（HNSW）或向量数据库。

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tokenize, cosine, computeIdf } from './embed';
import { chunkText } from './chunk';
import { HandwrittenEmbedder, type Embedder } from './embedder';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string, options?: unknown) => SqliteDb;
};

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
    all(...params: unknown[]): unknown[];
  };
}

export interface RagChunk {
  id: number;
  source: string;
  text: string;
  score: number;
}

export interface RagStatus {
  docs: number;
  chunks: number;
  dim: number;
}

function vecToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function bufferToVec(b: Uint8Array | Buffer): Float32Array {
  const u = b instanceof Buffer ? new Uint8Array(b) : b;
  return new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4);
}

function* walk(dir: string, depth = 0): Generator<string> {
  if (depth > 12) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, depth + 1);
    else if (e.isFile()) yield full;
  }
}

/**
 * RAG 向量仓库：维护「源列表 → 分块 → 嵌入 → 持久化 → 检索」。
 * 不变量：reindex 后，rag_idf 与所有 rag_chunks 的向量使用同一套全局 IDF，保证可比。
 */
export class RagStore {
  private readonly db: SqliteDb;
  private sources: string[] = [];
  /** 可插拔嵌入器——默认手写 TF-IDF，可换 API 嵌入器（Phase 11） */
  private readonly embedder: Embedder;
  private readonly dim: number;

  constructor(path: string, embedder?: Embedder) {
    this.embedder = embedder ?? new HandwrittenEmbedder();
    this.dim = this.embedder.dim;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS rag_docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        title TEXT,
        ctime TEXT NOT NULL
      );
       CREATE TABLE IF NOT EXISTS rag_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        source TEXT NOT NULL,
        text TEXT NOT NULL,
        vec BLOB NOT NULL
      );
       CREATE TABLE IF NOT EXISTS rag_idf (
        term TEXT PRIMARY KEY,
        val REAL NOT NULL
      );`,
    );
  }

  /** 设置语料源（文件或目录路径列表），供 reindex 使用 */
  setSources(sources: string[]): void {
    this.sources = sources;
  }

  /** 追加一个源并重索引（/rag ingest 用） */
  async addSource(path: string): Promise<{ docs: number; chunks: number }> {
    if (!this.sources.includes(path)) this.sources.push(path);
    return this.reindex();
  }

  /** 当前已配置的来源列表 */
  getSources(): string[] {
    return [...this.sources];
  }

  /** 清空索引（docs/chunks/idf） */
  clear(): void {
    this.db.exec('DELETE FROM rag_docs; DELETE FROM rag_chunks; DELETE FROM rag_idf;');
  }

  /** 把一组源（文件/目录）全量重建索引：分块 → 全局 IDF → 嵌入 → 落库 */
  async reindex(): Promise<{ docs: number; chunks: number }> {
    this.clear();
    const docs: { source: string; text: string }[] = [];
    for (const src of this.sources) {
      try {
        const st = statSync(src);
        if (st.isDirectory()) {
          for (const f of walk(src)) {
            try {
              docs.push({ source: f, text: readFileSync(f, 'utf8') });
            } catch {
              /* 跳过不可读文件 */
            }
          }
        } else if (st.isFile()) {
          docs.push({ source: src, text: readFileSync(src, 'utf8') });
        }
      } catch {
        /* 源不存在则跳过 */
      }
    }

    // 1) 全量分块
    const chunks: { source: string; text: string }[] = [];
    for (const d of docs) {
      for (const piece of chunkText(d.text)) chunks.push({ source: d.source, text: piece });
    }

    // 2) 全局 IDF（跨所有块统计文档频率 df）——手写 TF-IDF 需要；API 嵌入会忽略
    const df = new Map<string, number>();
    const termSets = chunks.map((c) => new Set(tokenize(c.text)));
    for (const set of termSets) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
    const idf = computeIdf(df, termSets.length);

    // 3) 嵌入（每条相互独立，可并行；手写实现其实是同步包 Promise，并行退化顺序也无妨）
    const vectors = await Promise.all(
      chunks.map((c) => this.embedder.embed(c.text, idf)),
    );

    // 4) 写 docs / chunks(含向量) / idf
    const insDoc = this.db.prepare('INSERT INTO rag_docs (source, title, ctime) VALUES (?, ?, ?)');
    const insChunk = this.db.prepare(
      'INSERT INTO rag_chunks (doc_id, idx, source, text, vec) VALUES (?, ?, ?, ?, ?)',
    );
    const insIdf = this.db.prepare('INSERT OR REPLACE INTO rag_idf (term, val) VALUES (?, ?)');

    let cursor = 0;
    for (const d of docs) {
      const res = insDoc.run(d.source, d.source.split('/').pop() ?? d.source, new Date().toISOString());
      const docId = Number(res.lastInsertRowid);
      const pieces = chunkText(d.text);
      for (let i = 0; i < pieces.length; i++) {
        const vec = vectors[cursor++]!;
        insChunk.run(docId, i, d.source, pieces[i]!, vecToBuffer(vec));
      }
    }
    for (const [term, val] of idf) insIdf.run(term, val);

    return { docs: docs.length, chunks: chunks.length };
  }

  private loadIdf(): Map<string, number> {
    const rows = this.db.prepare('SELECT term, val FROM rag_idf').all() as { term: string; val: number }[];
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.term, r.val);
    return m;
  }

  /**
   * 语义检索：把 query 嵌入（用库内全局 IDF），与所有块向量算余弦，取 top-k。
   * @param query 查询文本
   * @param k     返回条数，默认 5
   * @param threshold 余弦阈值（默认 0，即返回所有候选里最高的 k 条）
   */
  async search(query: string, k = 5, threshold = 0): Promise<RagChunk[]> {
    const qVec = await this.embedder.embed(query, this.loadIdf());
    const rows = this.db
      .prepare('SELECT id, source, text, vec FROM rag_chunks')
      .all() as { id: number; source: string; text: string; vec: Uint8Array | Buffer }[];
    const scored: RagChunk[] = [];
    for (const r of rows) {
      const score = cosine(qVec, bufferToVec(r.vec));
      if (score >= threshold) scored.push({ id: r.id, source: r.source, text: r.text, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  /** 把检索结果拼成可注入上下文的字符串 */
  static toContext(results: RagChunk[]): string {
    if (results.length === 0) return '（未检索到相关内容）';
    return results
      .map((r, i) => `【参考 ${i + 1}｜来源:${r.source}｜相关度:${r.score.toFixed(3)}】\n${r.text}`)
      .join('\n\n');
  }

  status(): RagStatus {
    const docs = (this.db.prepare('SELECT COUNT(*) AS n FROM rag_docs').all() as { n: number }[])[0]!.n;
    const chunks = (this.db.prepare('SELECT COUNT(*) AS n FROM rag_chunks').all() as { n: number }[])[0]!.n;
    return { docs, chunks, dim: this.dim };
  }
}
