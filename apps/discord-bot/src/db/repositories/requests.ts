import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { nowIso } from '../database.js';

export type RequestStatus = 'provisioning' | 'active' | 'failed' | 'reconciled_deleted';

export interface RequestRow {
  id: string;
  discord_user_id: string;
  discord_guild_id: string;
  instance_id: string;
  instance_name: string;
  template_id: string;
  status: RequestStatus;
  created_at: string;
}

/** Counts against a user's quota; 'failed'/'reconciled_deleted' don't. */
const ACTIVE_STATUSES: RequestStatus[] = ['provisioning', 'active'];

export class RequestRepository {
  constructor(private db: BetterSqlite3.Database) {}

  create(params: {
    discordUserId: string;
    discordGuildId: string;
    instanceId: string;
    instanceName: string;
    templateId: string;
    status: RequestStatus;
  }): RequestRow {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO requests (id, discord_user_id, discord_guild_id, instance_id, instance_name, template_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.discordUserId,
        params.discordGuildId,
        params.instanceId,
        params.instanceName,
        params.templateId,
        params.status,
        nowIso(),
      );
    return this.findById(id)!;
  }

  findById(id: string): RequestRow | undefined {
    return this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow | undefined;
  }

  countActiveForUser(discordUserId: string): number {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM requests WHERE discord_user_id = ? AND status IN (${placeholders})`,
      )
      .get(discordUserId, ...ACTIVE_STATUSES) as { n: number };
    return row.n;
  }

  updateStatus(id: string, status: RequestStatus): void {
    this.db.prepare('UPDATE requests SET status = ? WHERE id = ?').run(status, id);
  }

  /** Rows still counted as active/provisioning - what reconciliation checks against GameDock's real instance list. */
  listActive(): RequestRow[] {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT * FROM requests WHERE status IN (${placeholders})`)
      .all(...ACTIVE_STATUSES) as RequestRow[];
  }
}
