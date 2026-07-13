// Phase 6（RAG）：向量检索仓库（RagStore）。
// 复用 Phase 4 的 node:sqlite + createRequire 模式；向量以 BLOB 存库。
//
// 设计：
// - 语料来自一组「源」（文件或目录），reindex() 清空并按全局 IDF 重建索引；
// - 每块 = 一段文本 + 其嵌入向量 + 所属源；
// - 检索时把 query 嵌入，与库内所有块向量做余弦，取 top-k。
// 线性扫描 O(N·D) 对学习项目足够；生产会用 ANN 索引（HNSW）或向量数据库。

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import fg from 'fast-glob';
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
      );
       CREATE TABLE IF NOT EXISTS rag_file_meta (
        source TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        doc_id INTEGER NOT NULL
      );`,
    );
  }

  /** 设置语料源（文件或目录路径列表），供 reindex 使用 */
  setSources(sources: string[]): void {
    this.sources = sources;
  }

  /** 追加一个源并增量索引（/rag ingest 用） */
  async addSource(path: string): Promise<{ docs: number; chunks: number }> {
    if (!this.sources.includes(path)) this.sources.push(path);
    const r = await this.syncIndex();
    return { docs: r.docs, chunks: r.chunks };
  }

  /** 当前已配置的来源列表 */
  getSources(): string[] {
    return [...this.sources];
  }

  /** 清空索引（docs/chunks/idf/file_meta） */
  clear(): void {
    this.db.exec(
      'DELETE FROM rag_docs; DELETE FROM rag_chunks; DELETE FROM rag_idf; DELETE FROM rag_file_meta;',
    );
  }

  /** 把一组源（文件/目录）全量重建索引：分块 → 全局 IDF → 嵌入 → 落库 */
  async reindex(): Promise<{ docs: number; chunks: number }> {
    this.clear();
    const docs: { source: string; text: string }[] = [];
    for (const src of this.sources) {
      try {
        const st = statSync(src);
        if (st.isDirectory()) {
          for (const rel of fg.sync('**', { cwd: src, dot: true, onlyFiles: true })) {
            const f = join(src, rel);
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
    const insMeta = this.db.prepare(
      'INSERT OR REPLACE INTO rag_file_meta (source, mtime, size, doc_id) VALUES (?, ?, ?, ?)',
    );
    for (const d of docs) {
      const res = insDoc.run(d.source, d.source.split('/').pop() ?? d.source, new Date().toISOString());
      const docId = Number(res.lastInsertRowid);
      const pieces = chunkText(d.text);
      for (let i = 0; i < pieces.length; i++) {
        const vec = vectors[cursor++]!;
        insChunk.run(docId, i, d.source, pieces[i]!, vecToBuffer(vec));
      }
      // 记录源文件 mtime/size，供后续增量 syncIndex 判脏
      try {
        const fs = statSync(d.source);
        insMeta.run(d.source, Math.floor(fs.mtimeMs), fs.size, docId);
      } catch {
        insMeta.run(d.source, 0, 0, docId);
      }
    }
    for (const [term, val] of idf) insIdf.run(term, val);

    return { docs: docs.length, chunks: chunks.length };
  }

  /**
   * 增量重建索引：只重新嵌入「新增 / 修改（mtime 或 size 变化）/ 删除」的文件，
   * 未变动的文件复用既有向量，避免每次启动或每次查询都全量重嵌入。
   * 默认手写 TF-IDF 重嵌入成本尚可，但换成 API 嵌入器后全量重建会非常贵——这正是
   * 增量 syncIndex 的主要收益点。靠 rag_file_meta 表记录每个源文件的 mtime/size 判脏。
   *
   * - 没有任何变动时直接返回（changed:false），零嵌入开销；
   * - 有变动时仅基于「未变的既有块文本 + 脏文件新文本」重算全局 IDF（只分词、不重嵌入），
   *   然后只嵌入脏文件。
   */
  async syncIndex(): Promise<{ docs: number; chunks: number; changed: boolean }> {
    const meta = this.loadMeta();
    const st = this.status();
    // 旧库兼容：已有块但无元信息（老版本没 file_meta 表）→ 全量重建以补齐 meta，之后走增量
    if (meta.size === 0 && st.chunks > 0) {
      await this.reindex();
      const s = this.status();
      return { docs: s.docs, chunks: s.chunks, changed: true };
    }

    const disk = this.listSourceFiles();
    const diskMap = new Map(disk.map((d) => [d.source, d]));
    const dirty = disk.filter((d) => {
      const m = meta.get(d.source);
      return !m || m.mtime !== d.mtime || m.size !== d.size;
    });
    const removed = [...meta.keys()].filter((s) => !diskMap.has(s));

    if (dirty.length === 0 && removed.length === 0) {
      return { docs: st.docs, chunks: st.chunks, changed: false };
    }

    // 1) 删除已移除 / 已变更文件的旧块与文档行（+meta）
    const delDoc = this.db.prepare('DELETE FROM rag_docs WHERE id = ?');
    const delChunk = this.db.prepare('DELETE FROM rag_chunks WHERE doc_id = ?');
    const delMeta = this.db.prepare('DELETE FROM rag_file_meta WHERE source = ?');
    for (const s of removed) {
      const m = meta.get(s)!;
      delChunk.run(m.docId);
      delDoc.run(m.docId);
      delMeta.run(s);
    }
    for (const d of dirty) {
      const m = meta.get(d.source);
      if (m) {
        delChunk.run(m.docId);
        delDoc.run(m.docId);
        delMeta.run(d.source);
      }
    }

    // 2) 重算全局 IDF（基于「未变的既有块文本 + 脏文件新文本」，仅分词不计嵌入）
    const idf = this.computeIdfOverCorpus(dirty);

    // 3) 仅嵌入并插入脏文件
    const insDoc = this.db.prepare('INSERT INTO rag_docs (source, title, ctime) VALUES (?, ?, ?)');
    const insChunk = this.db.prepare(
      'INSERT INTO rag_chunks (doc_id, idx, source, text, vec) VALUES (?, ?, ?, ?, ?)',
    );
    const insMeta = this.db.prepare(
      'INSERT OR REPLACE INTO rag_file_meta (source, mtime, size, doc_id) VALUES (?, ?, ?, ?)',
    );
    for (const d of dirty) {
      let text: string;
      try {
        text = readFileSync(d.source, 'utf8');
      } catch {
        continue;
      }
      const pieces = chunkText(text);
      const res = insDoc.run(d.source, d.source.split('/').pop() ?? d.source, new Date().toISOString());
      const docId = Number(res.lastInsertRowid);
      const vecs = await Promise.all(pieces.map((p) => this.embedder.embed(p, idf)));
      pieces.forEach((p, i) => insChunk.run(docId, i, d.source, p, vecToBuffer(vecs[i]!)));
      insMeta.run(d.source, d.mtime, d.size, docId);
    }

    const s = this.status();
    return { docs: s.docs, chunks: s.chunks, changed: true };
  }

  /** 懒加载门控：距上次同步超过 maxAgeMs 才真正 syncIndex，避免每次查询/每轮都扫盘 */
  private lastSyncAt = 0;
  async ensureFresh(maxAgeMs = 30_000): Promise<void> {
    const now = Date.now();
    if (this.lastSyncAt === 0 || now - this.lastSyncAt > maxAgeMs) {
      await this.syncIndex();
      this.lastSyncAt = Date.now();
    }
  }

  private loadMeta(): Map<string, { mtime: number; size: number; docId: number }> {
    const rows = this.db
      .prepare('SELECT source, mtime, size, doc_id FROM rag_file_meta')
      .all() as { source: string; mtime: number; size: number; doc_id: number }[];
    const m = new Map<string, { mtime: number; size: number; docId: number }>();
    for (const r of rows) m.set(r.source, { mtime: r.mtime, size: r.size, docId: r.doc_id });
    return m;
  }

  /** 展开所有源（文件/目录）为「文件路径 → mtime/size」清单 */
  private listSourceFiles(): { source: string; mtime: number; size: number }[] {
    const out: { source: string; mtime: number; size: number }[] = [];
    for (const src of this.sources) {
      let st: ReturnType<typeof statSync> | undefined;
      try {
        st = statSync(src);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        for (const rel of fg.sync('**', { cwd: src, dot: true, onlyFiles: true })) {
          try {
            const f = join(src, rel);
            const fs = statSync(f);
            out.push({ source: f, mtime: Math.floor(fs.mtimeMs), size: fs.size });
          } catch {
            /* 跳过不可读 */
          }
        }
      } else if (st.isFile()) {
        out.push({ source: src, mtime: Math.floor(st.mtimeMs), size: st.size });
      }
    }
    return out;
  }

  /** 基于「未变的既有块文本 + 脏文件新文本」重算全局 IDF，并写回 rag_idf 表 */
  private computeIdfOverCorpus(dirty: { source: string }[]): Map<string, number> {
    const termSets: Set<string>[] = [];
    const existing = this.db
      .prepare('SELECT text FROM rag_chunks')
      .all() as { text: string }[];
    for (const r of existing) termSets.push(new Set(tokenize(r.text)));
    for (const d of dirty) {
      let text: string;
      try {
        text = readFileSync(d.source, 'utf8');
      } catch {
        continue;
      }
      for (const piece of chunkText(text)) termSets.push(new Set(tokenize(piece)));
    }
    const df = new Map<string, number>();
    for (const set of termSets) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
    const idf = computeIdf(df, termSets.length);
    this.db.exec('DELETE FROM rag_idf;');
    const insIdf = this.db.prepare('INSERT OR REPLACE INTO rag_idf (term, val) VALUES (?, ?)');
    for (const [term, val] of idf) insIdf.run(term, val);
    return idf;
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
    await this.ensureFresh(); // 懒加载：首次/过期时才增量同步，平时零成本
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
