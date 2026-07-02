import { randomUUID } from 'node:crypto';
import type { AuditLogDto } from '@gamedock/shared';
import type { DatabaseClient } from '../database.js';
import { nowIso } from '../database.js';

export interface AuditRow {
  id: string;
  user_id: string | null;
  username: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: string | null;
  created_at: string;
}

export function toAuditDto(row: AuditRow): AuditLogDto {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

export class AuditRepository {
  constructor(private db: DatabaseClient) {}

  add(entry: {
    userId?: string | null;
    username?: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    detail?: string;
  }): AuditRow {
    const id = randomUUID();
    this.db.run(
      `INSERT INTO audit_logs (id, user_id, username, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        entry.userId ?? null,
        entry.username ?? null,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.detail?.slice(0, 2000) ?? null,
        nowIso(),
      ],
    );
    return this.db.get<AuditRow>('SELECT * FROM audit_logs WHERE id = ?', [id])!;
  }

  list(limit = 100): AuditRow[] {
    return this.db.all<AuditRow>('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?', [
      limit,
    ]);
  }
}
