import { loadConfig } from './config.js';
import { createLogger, LogRingBuffer } from './logger.js';
import { createContext } from './context.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logBuffer = new LogRingBuffer();
  const { logger, registry } = createLogger(config.isProduction, logBuffer);

  if (process.getuid?.() === 0) {
    logger.error(
      'GameDock must not run as root. Create a dedicated user (see docs/INSTALL_DEBIAN.md).',
    );
    process.exit(1);
  }

  const ctx = await createContext(config, logger, registry, logBuffer);

  // Jobs cannot survive restarts; mark leftovers as failed.
  await ctx.jobs.recoverAfterRestart();

  const app = await buildApp(ctx);

  if ((await ctx.repos.users.count()) === 0) {
    logger.warn('No users exist yet. Create the first admin with: pnpm gamedock user:create-admin');
  }

  await app.listen({ host: config.host, port: config.port });
  logger.info(`GameDock Manager listening on http://${config.host}:${config.port}`);

  // Start instances flagged for auto-start (also clears stale statuses).
  await ctx.instances.autoStartAll();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down, stopping game servers gracefully...');
    try {
      await app.close();
      await ctx.shutdown();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
