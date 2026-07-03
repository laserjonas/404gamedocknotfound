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

  async create(params: {
    userId: string;
    tokenHash: string;
    csrfToken: string;
    expiresAt: string;
    ip?: string;
    userAgent?: string;
  }): Promise<SessionRow> {
    const id = randomUUID();
    await this.db.run(
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
    return (await this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [id]))!;
  }

  async findByTokenHash(tokenHash: string): Promise<SessionRow | undefined> {
    return this.db.get<SessionRow>('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]);
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    await this.db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }

  async deleteExpired(): Promise<number> {
    return (await this.db.run('DELETE FROM sessions WHERE expires_at < ?', [nowIso()])).changes;
  }
}
