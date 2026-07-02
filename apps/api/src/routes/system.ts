import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireRole } from '../plugins/auth.js';
import { checkDependencies } from '../services/systemStats.js';
import { toAuditDto } from '../db/repositories/audit.js';

// dist/routes/system.js -> dist/routes -> dist -> apps/api -> package.json
// (and src/routes/system.ts -> src -> apps/api -> package.json in dev), so
// this resolves correctly both compiled and under tsx.
const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
const gamedockVersion = (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string })
  .version;

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Unauthenticated liveness probe (no sensitive data).
  app.get('/api/system/health', async () => {
    return { status: 'ok', uptime: process.uptime(), version: gamedockVersion };
  });

  app.get('/api/system/stats', { preHandler: requireRole('viewer') }, async () => {
    const base = await ctx.systemStats.collect();
    return {
      ...base,
      runningInstances: ctx.processes.runningCount(),
      totalInstances: ctx.repos.instances.list().length,
    };
  });

  app.get('/api/system/dependencies', { preHandler: requireRole('viewer') }, async () => {
    return checkDependencies(ctx.config.steamcmdPath);
  });

  app.get('/api/system/audit', { preHandler: requireRole('admin') }, async (request) => {
    const { limit } = request.query as { limit?: string };
    const parsed = Math.min(Math.max(parseInt(limit ?? '100', 10) || 100, 1), 500);
    return ctx.repos.audit.list(parsed).map(toAuditDto);
  });

  app.get('/api/system/events', { preHandler: requireRole('viewer') }, async () => {
    // Recent instance lifecycle events for the dashboard.
    return ctx.repos.audit
      .list(50)
      .filter((row) => row.action.startsWith('instance.') || row.action.startsWith('backup.'))
      .map(toAuditDto);
  });
}
