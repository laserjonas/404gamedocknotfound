import BetterSqlite3 from 'better-sqlite3';
import { sqlitePathFromUrl } from '../config.js';

/**
 * Thin database abstraction. All repositories talk to this interface only,
 * so a PostgreSQL adapter can be added later without touching business logic.
 * SQL is written in the common subset (TEXT ids, ISO date strings, INTEGER bools).
 *
 * The interface is async even though the current (and only) implementation,
 * SqliteClient, is synchronous under the hood - `pg` and other network
 * database drivers are async-only, so this shape is what a future Postgres
 * backend needs. Every method already resolving synchronously today costs
 * nothing at runtime (an already-settled Promise resolves on the next
 * microtask) and means adding a second DatabaseClient implementation later
 * won't require touching any repository or service code again.
 */
export interface DatabaseClient {
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /**
   * Runs `fn` inside a transaction, committing on success and rolling back if
   * it throws. `fn` may itself await further DatabaseClient calls - the
   * transaction only commits after `fn`'s returned promise settles, which is
   * why this can't just be a thin wrapper around better-sqlite3's own
   * (fully synchronous) `Database.transaction()` helper: that helper commits
   * as soon as the callback *returns* a value, and an async callback returns
   * a pending Promise immediately, before any of its awaited work has run -
   * committing an effectively-empty transaction while the real writes still
   * happen afterwards, outside any transaction at all. Driving BEGIN/COMMIT/
   * ROLLBACK explicitly avoids that trap and is also the same shape a
   * Postgres-backed client needs (BEGIN/COMMIT over one awaited connection).
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Dynamic SQL (IN (?,?,...) placeholder lists, partial UPDATE set lists)
 * produces an unbounded number of distinct statement strings; past this size
 * the cache is simply reset - refilling costs one prepare per statement.
 */
const STATEMENT_CACHE_MAX = 256;

class SqliteClient implements DatabaseClient {
  private db: BetterSqlite3.Database;
  private statements = new Map<string, BetterSqlite3.Statement>();

  constructor(filePath: string) {
    this.db = new BetterSqlite3(filePath);
    this.db.pragma('journal_mode = WAL');
    // NORMAL (instead of FULL) skips the fsync on every commit; with WAL the
    // database can never be corrupted by it - a power loss can only drop the
    // most recent commits. The standard pairing for WAL, and a large win for
    // write-heavy paths like job log flushing.
    this.db.pragma('synchronous = NORMAL');
    // Keep the -wal file from staying huge after a burst of writes.
    this.db.pragma('journal_size_limit = 67108864');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
  }

  /**
   * Statements are cached per SQL string - preparing is the expensive part
   * of a better-sqlite3 query, and the app's SQL is a small fixed set.
   * SQLite transparently recompiles cached statements if the schema changes
   * (migrations), so caching across runMigrations() is safe.
   */
  private prepare(sql: string): BetterSqlite3.Statement {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      if (this.statements.size >= STATEMENT_CACHE_MAX) this.statements.clear();
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const info = this.prepare(sql).run(...params);
    return { changes: info.changes };
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.prepare(sql).all(...params) as T[];
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const result = await fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async close(): Promise<void> {
    try {
      // Gives SQLite's query planner fresh statistics; cheap on shutdown.
      this.db.pragma('optimize');
    } catch {
      // never block shutdown on this
    }
    this.db.close();
  }
}

export function createDatabase(databaseUrl: string, dataDir: string): DatabaseClient {
  const filePath = sqlitePathFromUrl(databaseUrl, dataDir);
  return new SqliteClient(filePath);
}

export const nowIso = (): string => new Date().toISOString();
