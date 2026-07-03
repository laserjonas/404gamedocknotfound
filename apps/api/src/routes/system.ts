import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LogLevel } from '@gamedock/shared';
import type { AppContext } from '../context.js';
import { requireRole } from '../plugins/auth.js';
import { checkDependencies } from '../services/systemStats.js';
import { toAuditDto } from '../db/repositories/audit.js';
import { conflict, badRequest } from '../errors.js';

/** How long to wait after a successful update job before exiting, so the job's
 * "succeeded" status and final log lines are durably written and can reach
 * the client before the process (and its SSE connections) go away. */
const RESTART_DELAY_MS = 2000;

// dist/routes/system.js -> dist/routes -> dist -> apps/api -> package.json
// (and src/routes/system.ts -> src -> apps/api -> package.json in dev), so
// this resolves correctly both compiled and under tsx.
const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
const gamedockVersion = (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string })
  .version;

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Unauthenticated liveness probe (no sensitive data).
  app.get('/api/system/health', async () => {
    const commit = await ctx.selfUpdate.getCurrentCommit();
    return { status: 'ok', uptime: process.uptime(), version: gamedockVersion, commit };
  });

  app.get('/api/system/stats', { preHandler: requireRole('viewer') }, async () => {
    const base = await ctx.systemStats.collect();
    const totalInstances = await ctx.repos.instances.count();
    return {
      ...base,
      runningInstances: ctx.processes.runningCount(),
      totalInstances,
    };
  });

  app.get('/api/system/stats/history', { preHandler: requireRole('viewer') }, async () => {
    return ctx.metricsHistory.recent();
  });

  app.get('/api/system/dependencies', { preHandler: requireRole('viewer') }, async () => {
    return checkDependencies(ctx.config.steamcmdPath);
  });

  app.get('/api/system/audit', { preHandler: requireRole('admin') }, async (request) => {
    const { limit } = request.query as { limit?: string };
    const parsed = Math.min(Math.max(parseInt(limit ?? '100', 10) || 100, 1), 500);
    const rows = await ctx.repos.audit.list(parsed);
    return rows.map(toAuditDto);
  });

  app.get('/api/system/events', { preHandler: requireRole('viewer') }, async () => {
    // Recent instance lifecycle events for the dashboard.
    const rows = await ctx.repos.audit.list(50);
    return rows
      .filter((row) => row.action.startsWith('instance.') || row.action.startsWith('backup.'))
      .map(toAuditDto);
  });

  // --- self-update ---------------------------------------------------------

  app.get('/api/system/update', { preHandler: requireRole('admin') }, async () => {
    return ctx.selfUpdate.checkForUpdate();
  });

  app.post('/api/system/update', { preHandler: requireRole('admin') }, async (request) => {
    if (await ctx.repos.jobs.findActiveByType('system_update')) {
      throw conflict('An update is already in progress');
    }

    const job = await ctx.jobs.enqueue(
      'system_update',
      null,
      request.auth!.user.username,
      async (handle) => {
        const commit = await ctx.selfUpdate.applyUpdate((line) => handle.log(line));
        handle.log(`Restarting in ${RESTART_DELAY_MS / 1000}s to run commit ${commit}...`);
        setTimeout(() => process.exit(0), RESTART_DELAY_MS);
      },
    );
    await ctx.audit({
      userId: request.auth?.user.id,
      username: request.auth?.user.username,
      action: 'system.update_started',
      targetType: 'system',
    });
    return { job: await ctx.jobs.dto(job) };
  });

  // --- logging ---------------------------------------------------------------

  app.get('/api/system/logs', { preHandler: requireRole('admin') }, async (request) => {
    const { limit, level, component } = request.query as {
      limit?: string;
      level?: string;
      component?: string;
    };
    const parsedLimit = Math.min(Math.max(parseInt(limit ?? '500', 10) || 500, 1), 2000);
    return {
      level: ctx.logs.getLevel(),
      entries: ctx.logs.recent(parsedLimit, level as LogLevel | undefined, component),
    };
  });

  app.get(
    '/api/system/logs/stream',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write(':ok\n\n');

      const unsubscribe = ctx.logs.subscribe((entry) => {
        reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
      });
      const keepAlive = setInterval(() => reply.raw.write(':ka\n\n'), 25000);

      request.raw.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
      });

      await new Promise<void>((resolve) => request.raw.on('close', () => resolve()));
    },
  );

  app.patch('/api/system/logs/level', { preHandler: requireRole('admin') }, async (request) => {
    const parsed = z.object({ level: z.string() }).safeParse(request.body);
    if (!parsed.success) throw badRequest('level is required');
    await ctx.logs.setLevel(parsed.data.level);
    await ctx.audit({
      userId: request.auth?.user.id,
      username: request.auth?.user.username,
      action: 'system.log_level_changed',
      targetType: 'system',
      detail: parsed.data.level,
    });
    return { level: ctx.logs.getLevel() };
  });
}
