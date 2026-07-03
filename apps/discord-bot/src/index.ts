import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { runMigrations } from './db/migrations.js';
import { RoleQuotaRepository } from './db/repositories/roleQuotas.js';
import { RequestRepository } from './db/repositories/requests.js';
import { GameDockClient } from './gamedockClient.js';
import { reconcileRequests } from './reconcile.js';
import { startBot } from './discord/client.js';

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main(): Promise<void> {
  const config = loadConfig();

  const db = createDatabase(config.dataDir);
  runMigrations(db);
  const roleQuotas = new RoleQuotaRepository(db);
  const requests = new RequestRepository(db);

  const gamedock = new GameDockClient(config.gamedockApiUrl, config.gamedockApiToken);

  const runReconcile = () => {
    reconcileRequests(gamedock, requests)
      .then((count) => {
        if (count > 0) log(`Reconciliation freed up ${count} stale quota slot(s)`);
      })
      .catch((err: Error) => log(`Reconciliation failed: ${err.message}`));
  };
  const reconcileTimer = setInterval(runReconcile, config.reconcileIntervalMs);
  reconcileTimer.unref();
  runReconcile();

  await startBot(config, { gamedock, roleQuotas, requests }, log);
  log('GameDock Discord bot started');
}

main().catch((err: Error) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
