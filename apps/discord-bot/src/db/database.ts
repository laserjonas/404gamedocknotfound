import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

/**
 * Small, single-purpose local cache (role quotas + request tracking) - no
 * async DatabaseClient wrapper like apps/api's (that exists there for
 * future Postgres portability, which isn't a goal for this bot).
 */
export function createDatabase(dataDir: string): BetterSqlite3.Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new BetterSqlite3(join(dataDir, 'discord-bot.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export const nowIso = (): string => new Date().toISOString();
