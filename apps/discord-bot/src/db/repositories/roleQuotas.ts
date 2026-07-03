import type BetterSqlite3 from 'better-sqlite3';
import { nowIso } from '../database.js';

export interface RoleQuotaRow {
  discord_role_id: string;
  label: string;
  max_servers: number;
  /** JSON array of GameDock template ids. */
  allowed_template_ids: string;
  updated_at: string;
}

export class RoleQuotaRepository {
  constructor(private db: BetterSqlite3.Database) {}

  upsert(params: {
    discordRoleId: string;
    label: string;
    maxServers: number;
    allowedTemplateIds: string[];
  }): RoleQuotaRow {
    this.db
      .prepare(
        `INSERT INTO role_quotas (discord_role_id, label, max_servers, allowed_template_ids, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(discord_role_id) DO UPDATE SET
           label = excluded.label,
           max_servers = excluded.max_servers,
           allowed_template_ids = excluded.allowed_template_ids,
           updated_at = excluded.updated_at`,
      )
      .run(
        params.discordRoleId,
        params.label,
        params.maxServers,
        JSON.stringify(params.allowedTemplateIds),
        nowIso(),
      );
    return this.findByRoleId(params.discordRoleId)!;
  }

  findByRoleId(discordRoleId: string): RoleQuotaRow | undefined {
    return this.db
      .prepare('SELECT * FROM role_quotas WHERE discord_role_id = ?')
      .get(discordRoleId) as RoleQuotaRow | undefined;
  }

  findForRoleIds(discordRoleIds: string[]): RoleQuotaRow[] {
    if (discordRoleIds.length === 0) return [];
    const placeholders = discordRoleIds.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT * FROM role_quotas WHERE discord_role_id IN (${placeholders})`)
      .all(...discordRoleIds) as RoleQuotaRow[];
  }

  list(): RoleQuotaRow[] {
    return this.db.prepare('SELECT * FROM role_quotas ORDER BY label').all() as RoleQuotaRow[];
  }

  remove(discordRoleId: string): { changes: number } {
    const info = this.db
      .prepare('DELETE FROM role_quotas WHERE discord_role_id = ?')
      .run(discordRoleId);
    return { changes: info.changes };
  }
}
