import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '../database.js';
import { nowIso } from '../database.js';

export interface WebauthnCredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_type: 'singleDevice' | 'multiDevice';
  backed_up: number;
  nickname: string;
  created_at: string;
  last_used_at: string | null;
}

export class WebauthnCredentialRepository {
  constructor(private db: DatabaseClient) {}

  async create(params: {
    userId: string;
    credentialId: string;
    publicKey: string;
    counter: number;
    transports: string | null;
    deviceType: 'singleDevice' | 'multiDevice';
    backedUp: boolean;
    nickname: string;
  }): Promise<WebauthnCredentialRow> {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO webauthn_credentials
         (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, nickname, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        params.userId,
        params.credentialId,
        params.publicKey,
        params.counter,
        params.transports,
        params.deviceType,
        params.backedUp ? 1 : 0,
        params.nickname,
        nowIso(),
      ],
    );
    return (await this.db.get<WebauthnCredentialRow>(
      'SELECT * FROM webauthn_credentials WHERE id = ?',
      [id],
    ))!;
  }

  async listForUser(userId: string): Promise<WebauthnCredentialRow[]> {
    return this.db.all<WebauthnCredentialRow>(
      'SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at',
      [userId],
    );
  }

  async findByCredentialId(credentialId: string): Promise<WebauthnCredentialRow | undefined> {
    return this.db.get<WebauthnCredentialRow>(
      'SELECT * FROM webauthn_credentials WHERE credential_id = ?',
      [credentialId],
    );
  }

  async countForUser(userId: string): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM webauthn_credentials WHERE user_id = ?',
      [userId],
    );
    return row?.count ?? 0;
  }

  async updateCounter(id: string, counter: number): Promise<void> {
    await this.db.run(
      'UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?',
      [counter, nowIso(), id],
    );
  }

  /** Scoped to userId in the SQL itself - never trust a client-supplied id alone. */
  async deleteForUser(userId: string, id: string): Promise<{ changes: number }> {
    return this.db.run('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?', [
      id,
      userId,
    ]);
  }

  /** Admin lost-all-devices recovery path (parallel to disabling TOTP). */
  async deleteAllForUser(userId: string): Promise<void> {
    await this.db.run('DELETE FROM webauthn_credentials WHERE user_id = ?', [userId]);
  }
}
