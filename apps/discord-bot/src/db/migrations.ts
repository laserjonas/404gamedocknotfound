import type BetterSqlite3 from 'better-sqlite3';

interface Migration {
  id: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial-schema',
    sql: `
      CREATE TABLE role_quotas (
        discord_role_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        max_servers INTEGER NOT NULL,
        allowed_template_ids TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE requests (
        id TEXT PRIMARY KEY,
        discord_user_id TEXT NOT NULL,
        discord_guild_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        instance_name TEXT NOT NULL,
        template_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('provisioning', 'active', 'failed', 'reconciled_deleted')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_requests_discord_user ON requests(discord_user_id);
    `,
  },
];

export function runMigrations(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT id FROM _migrations').all() as { id: number }[]).map((r) => r.id),
  );

  for (const migration of [...MIGRATIONS].sort((a, b) => a.id - b.id)) {
    if (applied.has(migration.id)) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
    });
    apply();
  }
}
