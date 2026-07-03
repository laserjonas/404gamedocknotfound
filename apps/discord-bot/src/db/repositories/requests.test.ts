import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { createDatabase } from '../database.js';
import { runMigrations } from '../migrations.js';
import { RequestRepository } from './requests.js';

describe('RequestRepository', () => {
  let dir: string;
  let db: BetterSqlite3.Database;
  let repo: RequestRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gamedock-discord-bot-test-'));
    db = createDatabase(dir);
    runMigrations(db);
    repo = new RequestRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a request and reads it back', () => {
    const row = repo.create({
      discordUserId: 'user-1',
      discordGuildId: 'guild-1',
      instanceId: 'instance-1',
      instanceName: 'discord-user-1-valheim-abc',
      templateId: 'valheim',
      status: 'provisioning',
    });

    expect(repo.findById(row.id)?.status).toBe('provisioning');
  });

  it('counts only provisioning/active requests toward a user’s quota', () => {
    repo.create({
      discordUserId: 'user-1',
      discordGuildId: 'guild-1',
      instanceId: 'instance-1',
      instanceName: 'a',
      templateId: 'valheim',
      status: 'active',
    });
    repo.create({
      discordUserId: 'user-1',
      discordGuildId: 'guild-1',
      instanceId: 'instance-2',
      instanceName: 'b',
      templateId: 'valheim',
      status: 'failed',
    });
    repo.create({
      discordUserId: 'user-2',
      discordGuildId: 'guild-1',
      instanceId: 'instance-3',
      instanceName: 'c',
      templateId: 'valheim',
      status: 'active',
    });

    expect(repo.countActiveForUser('user-1')).toBe(1); // the 'failed' one doesn't count
    expect(repo.countActiveForUser('user-2')).toBe(1);
    expect(repo.countActiveForUser('user-does-not-exist')).toBe(0);
  });

  it('updateStatus moves a request out of listActive() once no longer active', () => {
    const row = repo.create({
      discordUserId: 'user-1',
      discordGuildId: 'guild-1',
      instanceId: 'instance-1',
      instanceName: 'a',
      templateId: 'valheim',
      status: 'provisioning',
    });

    expect(repo.listActive().map((r) => r.id)).toEqual([row.id]);

    repo.updateStatus(row.id, 'reconciled_deleted');

    expect(repo.listActive()).toEqual([]);
    expect(repo.findById(row.id)?.status).toBe('reconciled_deleted');
  });
});
