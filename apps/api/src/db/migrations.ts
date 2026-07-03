import type { DatabaseClient } from './database.js';
import type { Logger } from '../logger.js';

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
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);

      CREATE TABLE game_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        definition TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE server_instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        template_id TEXT NOT NULL,
        template_definition TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'not_installed',
        installed INTEGER NOT NULL DEFAULT 0,
        auto_start INTEGER NOT NULL DEFAULT 0,
        start_executable TEXT,
        start_args TEXT,
        last_pid INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE instance_ports (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        port INTEGER NOT NULL,
        protocol TEXT NOT NULL CHECK (protocol IN ('tcp', 'udp', 'both'))
      );
      CREATE INDEX idx_instance_ports_instance ON instance_ports(instance_id);

      CREATE TABLE instance_env_vars (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        UNIQUE(instance_id, key)
      );

      CREATE TABLE instance_variables (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        UNIQUE(instance_id, key)
      );

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        instance_id TEXT,
        progress REAL,
        message TEXT,
        log TEXT NOT NULL DEFAULT '',
        created_by TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX idx_jobs_instance ON jobs(instance_id);
      CREATE INDEX idx_jobs_status ON jobs(status);

      CREATE TABLE backups (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_backups_instance ON backups(instance_id);

      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        username TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_audit_created ON audit_logs(created_at);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: 'instance-automation',
    sql: `
      ALTER TABLE server_instances ADD COLUMN crash_restart INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE server_instances ADD COLUMN backup_interval_hours INTEGER;
      ALTER TABLE server_instances ADD COLUMN backup_retention_count INTEGER;
    `,
  },
  {
    id: 3,
    name: 'totp',
    sql: `
      ALTER TABLE users ADD COLUMN totp_secret TEXT;
      ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 4,
    name: 'instance-user-isolation',
    sql: `
      ALTER TABLE server_instances ADD COLUMN linux_username TEXT;
      ALTER TABLE server_instances ADD COLUMN linux_uid INTEGER;
    `,
  },
  {
    id: 5,
    name: 'webauthn-credentials',
    sql: `
      CREATE TABLE webauthn_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        credential_id TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT,
        device_type TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
        backed_up INTEGER NOT NULL DEFAULT 0,
        nickname TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX idx_webauthn_credentials_user ON webauthn_credentials(user_id);
    `,
  },
];

export async function runMigrations(db: DatabaseClient, logger?: Logger): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    (await db.all<{ id: number }>('SELECT id FROM _migrations')).map((r) => r.id),
  );

  for (const migration of MIGRATIONS.sort((a, b) => a.id - b.id)) {
    if (applied.has(migration.id)) continue;
    logger?.info({ migration: migration.name }, 'applying database migration');
    await db.transaction(async () => {
      await db.exec(migration.sql);
      await db.run('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)', [
        migration.id,
        migration.name,
        new Date().toISOString(),
      ]);
    });
  }
}
