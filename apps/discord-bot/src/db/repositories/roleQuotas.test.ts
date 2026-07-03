import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { createDatabase } from '../database.js';
import { runMigrations } from '../migrations.js';
import { RoleQuotaRepository } from './roleQuotas.js';

describe('RoleQuotaRepository', () => {
  let dir: string;
  let db: BetterSqlite3.Database;
  let repo: RoleQuotaRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gamedock-discord-bot-test-'));
    db = createDatabase(dir);
    runMigrations(db);
    repo = new RoleQuotaRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('upserts a new role quota and reads it back', () => {
    const row = repo.upsert({
      discordRoleId: 'role-1',
      label: 'Gold',
      maxServers: 3,
      allowedTemplateIds: ['valheim', 'minecraft-java'],
    });

    expect(row.discord_role_id).toBe('role-1');
    expect(JSON.parse(row.allowed_template_ids)).toEqual(['valheim', 'minecraft-java']);

    const found = repo.findByRoleId('role-1');
    expect(found?.max_servers).toBe(3);
  });

  it('upserting the same role id updates in place rather than duplicating', () => {
    repo.upsert({
      discordRoleId: 'role-1',
      label: 'Gold',
      maxServers: 3,
      allowedTemplateIds: ['valheim'],
    });
    repo.upsert({
      discordRoleId: 'role-1',
      label: 'Gold',
      maxServers: 5,
      allowedTemplateIds: ['rust'],
    });

    expect(repo.list()).toHaveLength(1);
    expect(repo.findByRoleId('role-1')?.max_servers).toBe(5);
  });

  it('findForRoleIds returns only matching rows, in any combination', () => {
    repo.upsert({
      discordRoleId: 'role-1',
      label: 'Gold',
      maxServers: 3,
      allowedTemplateIds: ['valheim'],
    });
    repo.upsert({
      discordRoleId: 'role-2',
      label: 'Bronze',
      maxServers: 1,
      allowedTemplateIds: ['minecraft-java'],
    });

    expect(repo.findForRoleIds([])).toEqual([]);
    expect(repo.findForRoleIds(['role-2'])).toHaveLength(1);
    expect(repo.findForRoleIds(['role-1', 'role-2', 'role-does-not-exist'])).toHaveLength(2);
  });

  it('removes a role quota', () => {
    repo.upsert({
      discordRoleId: 'role-1',
      label: 'Gold',
      maxServers: 3,
      allowedTemplateIds: ['valheim'],
    });

    expect(repo.remove('role-1').changes).toBe(1);
    expect(repo.findByRoleId('role-1')).toBeUndefined();
    expect(repo.remove('role-1').changes).toBe(0);
  });
});
