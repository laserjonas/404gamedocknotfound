import type { DatabaseClient } from '../database.js';

export class SettingsRepository {
  constructor(private db: DatabaseClient) {}

  async get(key: string): Promise<string | undefined> {
    return (await this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]))
      ?.value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
    );
  }

  async all(): Promise<Record<string, string>> {
    const rows = await this.db.all<{ key: string; value: string }>(
      'SELECT key, value FROM settings',
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
}
