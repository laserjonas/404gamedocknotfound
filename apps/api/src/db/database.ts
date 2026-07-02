import BetterSqlite3 from 'better-sqlite3';
import { sqlitePathFromUrl } from '../config.js';

/**
 * Thin database abstraction. All repositories talk to this interface only,
 * so a PostgreSQL adapter can be added later without touching business logic.
 * SQL is written in the common subset (TEXT ids, ISO date strings, INTEGER bools).
 */
export interface DatabaseClient {
  run(sql: string, params?: unknown[]): { changes: number };
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

class SqliteClient implements DatabaseClient {
  private db: BetterSqlite3.Database;

  constructor(filePath: string) {
    this.db = new BetterSqlite3(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
  }

  run(sql: string, params: unknown[] = []) {
    const info = this.db.prepare(sql).run(...params);
    return { changes: info.changes };
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

export function createDatabase(databaseUrl: string, dataDir: string): DatabaseClient {
  const filePath = sqlitePathFromUrl(databaseUrl, dataDir);
  return new SqliteClient(filePath);
}

export const nowIso = (): string => new Date().toISOString();
