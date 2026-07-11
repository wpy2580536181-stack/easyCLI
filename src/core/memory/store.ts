import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// node:sqlite 是 Node 22 内置实验模块；用 createRequire 在运行时加载，
// 避开打包器/测试运行器对 `node:` 前缀的静态误解析（vite 会把它当裸包 `sqlite` 去找）。
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

export interface MemoryRecord {
  id: number;
  fact: string;
  source: string;
  createdAt: string;
  /** 结构化字段（Phase 20 增强，旧行可能为 undefined） */
  name?: string;
  description?: string;
  /** user | feedback | project | reference（默认 'user'） */
  type?: string;
}

/** remember 的可选结构化元数据 */
export interface MemoryMeta {
  name?: string;
  description?: string;
  type?: string;
}

/**
 * 长期记忆仓库（Phase 4，决策 7：独立于上下文压缩）。
 * 用 Node 22 内置的 node:sqlite（DatabaseSync，零依赖）持久化「跨会话事实」。
 *
 * 关键约定：
 * - `:memory:` 用于测试，不落盘；
 * - 生产路径默认 ~/.config/agent-cli/memory.db；
 * - 只存「事实」，检索靠最近 N 条或_like_ 模糊搜索，足够学习项目；
 *   语义检索（向量/RAG）已在第 6 期实现，见 src/core/rag。
 * - Phase 20：表结构向前兼容扩展 name/description/type 三列（幂等 ALTER）。
 */
export class MemoryStore {
  private readonly db: SqliteDb;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fact TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'agent',
        created_at TEXT NOT NULL
      )`,
    );
    // Phase 20：向前兼容迁移——旧库缺列才 ALTER（O(1) 元数据操作，安全幂等）
    this.migrateSchema();
  }

  private migrateSchema(): void {
    const cols = this.db.prepare('PRAGMA table_info(memory)').all() as { name: string }[];
    const has = (c: string) => cols.some((x) => x.name === c);
    if (!has('name')) this.db.exec("ALTER TABLE memory ADD COLUMN name TEXT DEFAULT ''");
    if (!has('description')) this.db.exec("ALTER TABLE memory ADD COLUMN description TEXT DEFAULT ''");
    if (!has('type')) this.db.exec("ALTER TABLE memory ADD COLUMN type TEXT DEFAULT 'user'");
  }

  /** 记住一条事实，返回自增 id。meta 提供结构化字段（name/description/type） */
  remember(fact: string, source = 'agent', meta?: MemoryMeta): number {
    const stmt = this.db.prepare(
      'INSERT INTO memory (fact, source, created_at, name, description, type) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const res = stmt.run(
      fact,
      source,
      new Date().toISOString(),
      meta?.name ?? '',
      meta?.description ?? '',
      meta?.type ?? 'user',
    );
    return Number(res.lastInsertRowid);
  }

  /** 取最近 limit 条（倒序） */
  recall(limit = 20): MemoryRecord[] {
    const rows = this.db
      .prepare('SELECT id, fact, source, created_at, name, description, type FROM memory ORDER BY id DESC LIMIT ?')
      .all(limit) as MemoryRow[];
    return rows.map(toRecord);
  }

  /** 模糊搜索（fact 包含 query 子串） */
  search(query: string, limit = 20): MemoryRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, fact, source, created_at, name, description, type FROM memory WHERE fact LIKE ? ORDER BY id DESC LIMIT ?',
      )
      .all(`%${query}%`, limit) as MemoryRow[];
    return rows.map(toRecord);
  }

  /**
   * 取全部记忆的轻量目录（id/name/description/type），供自动提取去重与语义召回清单。
   * 不取 fact 全文，省 token。
   */
  listAll(limit = 200): Pick<MemoryRecord, 'id' | 'name' | 'description' | 'type'>[] {
    const rows = this.db
      .prepare('SELECT id, name, description, type FROM memory ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ id: number; name: string; description: string; type: string }>;
    return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, type: r.type }));
  }

  /** 按 id 批量取全文（语义召回选中后读取 body） */
  getByIds(ids: number[]): MemoryRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT id, fact, source, created_at, name, description, type FROM memory WHERE id IN (${placeholders})`,
      )
      .all(...ids) as MemoryRow[];
    return rows.map(toRecord);
  }

  /** 清空（测试/重置用） */
  clear(): void {
    this.db.exec('DELETE FROM memory');
  }
}

interface MemoryRow {
  id: number;
  fact: string;
  source: string;
  created_at: string;
  name?: string;
  description?: string;
  type?: string;
}

function toRecord(r: MemoryRow): MemoryRecord {
  return {
    id: r.id,
    fact: r.fact,
    source: r.source,
    createdAt: r.created_at,
    name: r.name,
    description: r.description,
    type: r.type,
  };
}
