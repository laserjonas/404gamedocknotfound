import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '../database.js';
import { nowIso } from '../database.js';

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_token: string;
  created_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
}

export class SessionRepository {
  constructor(private db: DatabaseClient) {}

  create(params: {
    userId: string;
    tokenHash: string;
    csrfToken: string;
    expiresAt: string;
    ip?: string;
    userAgent?: string;
  }): SessionRow {
    const id = randomUUID();
    this.db.run(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        params.userId,
        params.tokenHash,
        params.csrfToken,
        nowIso(),
        params.expiresAt,
        params.ip ?? null,
        params.userAgent?.slice(0, 256) ?? null,
      ],
    );
    return this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [id])!;
  }

  findByTokenHash(tokenHash: string): SessionRow | undefined {
    return this.db.get<SessionRow>('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]);
  }

  deleteByTokenHash(tokenHash: string): void {
    this.db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  }

  deleteForUser(userId: string): void {
    this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }

  deleteExpired(): number {
    return this.db.run('DELETE FROM sessions WHERE expires_at < ?', [nowIso()]).changes;
  }
}
