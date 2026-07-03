import { describe, expect, it } from 'vitest';
import type { InstanceDto } from '@gamedock/shared';
import { reconcileRequests } from './reconcile.js';
import type { GameDockClient } from './gamedockClient.js';
import type { RequestRepository, RequestRow, RequestStatus } from './db/repositories/requests.js';

function instance(id: string): InstanceDto {
  return {
    id,
    name: id,
    templateId: 'valheim',
    templateName: 'Valheim',
    status: 'running',
    installed: true,
    autoStart: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startExecutable: null,
    startArgs: null,
    ports: [],
    envVars: {},
    variables: {},
    pid: null,
    crashRestart: false,
    backupIntervalHours: null,
    backupRetentionCount: null,
    restartIntervalHours: null,
    lastScheduledRestartAt: null,
  };
}

function requestRow(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    id: 'req-1',
    discord_user_id: 'user-1',
    discord_guild_id: 'guild-1',
    instance_id: 'instance-1',
    instance_name: 'discord-user-1-valheim-abc',
    template_id: 'valheim',
    status: 'active',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function fakeRequests(rows: RequestRow[]): {
  repo: Pick<RequestRepository, 'listActive' | 'updateStatus'>;
  updates: { id: string; status: RequestStatus }[];
} {
  const updates: { id: string; status: RequestStatus }[] = [];
  return {
    repo: {
      listActive: () => rows,
      updateStatus: (id: string, status: RequestStatus) => {
        updates.push({ id, status });
      },
    },
    updates,
  };
}

describe('reconcileRequests', () => {
  it('does nothing when there are no active requests', async () => {
    const { repo, updates } = fakeRequests([]);
    const client: Pick<GameDockClient, 'listInstances'> = { listInstances: async () => [] };

    const count = await reconcileRequests(client, repo);

    expect(count).toBe(0);
    expect(updates).toEqual([]);
  });

  it('marks a request reconciled_deleted when its instance no longer exists in GameDock', async () => {
    const { repo, updates } = fakeRequests([
      requestRow({ id: 'req-1', instance_id: 'instance-1' }),
      requestRow({ id: 'req-2', instance_id: 'instance-2' }),
    ]);
    const client: Pick<GameDockClient, 'listInstances'> = {
      listInstances: async () => [instance('instance-1')], // instance-2 is gone
    };

    const count = await reconcileRequests(client, repo);

    expect(count).toBe(1);
    expect(updates).toEqual([{ id: 'req-2', status: 'reconciled_deleted' }]);
  });

  it('leaves requests alone when their instance still exists', async () => {
    const { repo, updates } = fakeRequests([
      requestRow({ id: 'req-1', instance_id: 'instance-1' }),
    ]);
    const client: Pick<GameDockClient, 'listInstances'> = {
      listInstances: async () => [instance('instance-1')],
    };

    const count = await reconcileRequests(client, repo);

    expect(count).toBe(0);
    expect(updates).toEqual([]);
  });
});
