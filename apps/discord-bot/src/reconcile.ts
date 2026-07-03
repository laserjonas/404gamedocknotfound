import type { GameDockClient } from './gamedockClient.js';
import type { RequestRepository } from './db/repositories/requests.js';

/**
 * Frees up quota slots when an instance was deleted directly in the
 * GameDock web UI instead of through the bot (the bot's own `requests`
 * table would otherwise keep counting it against the requester's quota
 * forever). Mirrors GameDock's own periodic-scan pattern (its backup/
 * restart schedulers in apps/api/src/context.ts).
 */
export async function reconcileRequests(
  client: Pick<GameDockClient, 'listInstances'>,
  requests: Pick<RequestRepository, 'listActive' | 'updateStatus'>,
): Promise<number> {
  const active = requests.listActive();
  if (active.length === 0) return 0;

  const liveInstances = await client.listInstances();
  const liveIds = new Set(liveInstances.map((i) => i.id));

  let reconciled = 0;
  for (const row of active) {
    if (!liveIds.has(row.instance_id)) {
      requests.updateStatus(row.id, 'reconciled_deleted');
      reconciled++;
    }
  }
  return reconciled;
}
