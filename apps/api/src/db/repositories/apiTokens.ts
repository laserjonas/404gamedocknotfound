import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '../database.js';
import { nowIso } from '../database.js';

export interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

export class ApiTokenRepository {
  constructor(private db: DatabaseClient) {}

  async create(params: {
    userId: string;
    name: string;
    tokenHash: string;
    expiresAt: string | null;
  }): Promise<ApiTokenRow> {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, params.userId, params.name, params.tokenHash, nowIso(), params.expiresAt],
    );
    return (await this.db.get<ApiTokenRow>('SELECT * FROM api_tokens WHERE id = ?', [id]))!;
  }

  async listForUser(userId: string): Promise<ApiTokenRow[]> {
    return this.db.all<ApiTokenRow>(
      'SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC',
      [userId],
    );
  }

  async findByTokenHash(tokenHash: string): Promise<ApiTokenRow | undefined> {
    return this.db.get<ApiTokenRow>('SELECT * FROM api_tokens WHERE token_hash = ?', [tokenHash]);
  }

  async updateLastUsed(id: string): Promise<void> {
    await this.db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [nowIso(), id]);
  }

  /** Scoped to userId in the SQL itself - never trust a client-supplied id alone. */
  async deleteForUser(userId: string, id: string): Promise<{ changes: number }> {
    return this.db.run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', [id, userId]);
  }

  /** Admin lost-all-tokens recovery path (parallel to resetting TOTP/passkeys). */
  async deleteAllForUser(userId: string): Promise<void> {
    await this.db.run('DELETE FROM api_tokens WHERE user_id = ?', [userId]);
  }
}
