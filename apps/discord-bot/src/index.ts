import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { runMigrations } from './db/migrations.js';
import { RoleQuotaRepository } from './db/repositories/roleQuotas.js';
import { RequestRepository } from './db/repositories/requests.js';
import { GameDockClient } from './gamedockClient.js';
import { reconcileRequests } from './reconcile.js';
import { evaluateDeployCheck, INITIAL_DEPLOY_CHECK_STATE } from './deployCheck.js';
import type { DeployCheckState } from './deployCheck.js';
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

  // self-update only restarts the main API process (a separate systemd
  // unit) - this notices when GameDock reports a new deployed commit and
  // exits so this bot's own Restart=always brings it back up on the
  // matching, freshly-rsynced code.
  let deployCheckState: DeployCheckState = INITIAL_DEPLOY_CHECK_STATE;
  const runDeployCheck = () => {
    gamedock
      .getHealth()
      .then((health) => {
        const { restart, nextState } = evaluateDeployCheck(deployCheckState, health.commit);
        deployCheckState = nextState;
        if (restart) {
          log(`GameDock was updated to commit ${health.commit} - restarting to match...`);
          process.exit(0);
        }
      })
      .catch((err: Error) => log(`Deploy check failed: ${err.message}`));
  };
  const deployCheckTimer = setInterval(runDeployCheck, config.updateCheckIntervalMs);
  deployCheckTimer.unref();
  runDeployCheck();

  await startBot(config, { gamedock, roleQuotas, requests }, log);
  log('GameDock Discord bot started');
}

main().catch((err: Error) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
