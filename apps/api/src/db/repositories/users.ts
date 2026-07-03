import { randomUUID } from 'node:crypto';
import type { Role, UserDto } from '@gamedock/shared';
import type { DatabaseClient } from '../database.js';
import { nowIso } from '../database.js';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  disabled: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

export class UserRepository {
  constructor(private db: DatabaseClient) {}

  async findById(id: string): Promise<UserRow | undefined> {
    return this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  }

  async findByUsername(username: string): Promise<UserRow | undefined> {
    return this.db.get<UserRow>('SELECT * FROM users WHERE username = ?', [username]);
  }

  async list(): Promise<UserRow[]> {
    return this.db.all<UserRow>('SELECT * FROM users ORDER BY username');
  }

  async count(): Promise<number> {
    const row = await this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM users');
    return row?.c ?? 0;
  }

  async countAdmins(): Promise<number> {
    const row = await this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0",
    );
    return row?.c ?? 0;
  }

  async create(username: string, passwordHash: string, role: Role): Promise<UserRow> {
    const now = nowIso();
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO users (id, username, password_hash, role, disabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
      [id, username, passwordHash, role, now, now],
    );
    return (await this.findById(id))!;
  }

  async update(
    id: string,
    patch: Partial<{ username: string; passwordHash: string; role: Role; disabled: boolean }>,
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.username !== undefined) {
      sets.push('username = ?');
      params.push(patch.username);
    }
    if (patch.passwordHash !== undefined) {
      sets.push('password_hash = ?');
      params.push(patch.passwordHash);
    }
    if (patch.role !== undefined) {
      sets.push('role = ?');
      params.push(patch.role);
    }
    if (patch.disabled !== undefined) {
      sets.push('disabled = ?');
      params.push(patch.disabled ? 1 : 0);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(nowIso(), id);
    await this.db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  async recordLogin(id: string): Promise<void> {
    await this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), id]);
  }

  async delete(id: string): Promise<void> {
    await this.db.run('DELETE FROM users WHERE id = ?', [id]);
  }
}
