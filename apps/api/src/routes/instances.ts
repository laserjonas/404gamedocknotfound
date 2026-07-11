import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireRole } from '../plugins/auth.js';
import { badRequest } from '../errors.js';

const portSchema = z.object({
  name: z.string().min(1).max(64),
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(['tcp', 'udp', 'both']),
});

const createSchema = z.object({
  name: z.string().min(2).max(64),
  templateId: z.string().min(1).max(64),
  variables: z.record(z.string().max(1024)).optional(),
  ports: z.array(portSchema).max(32).optional(),
});

const cloneSchema = z.object({
  name: z.string().min(2).max(64),
});

const updateSchema = z.object({
  name: z.string().min(2).max(64).optional(),
  autoStart: z.boolean().optional(),
  startExecutable: z.string().max(512).nullable().optional(),
  startArgs: z.array(z.string().max(2048)).max(128).nullable().optional(),
  envVars: z.record(z.string().max(2048)).optional(),
  variables: z.record(z.string().max(1024)).optional(),
  ports: z.array(portSchema).max(32).optional(),
  crashRestart: z.boolean().optional(),
  backupIntervalHours: z.number().int().min(1).max(8760).nullable().optional(),
  backupRetentionCount: z.number().int().min(1).max(1000).nullable().optional(),
  restartIntervalHours: z.number().int().min(1).max(8760).nullable().optional(),
  memoryMaxMb: z.number().int().min(128).max(1048576).nullable().optional(),
  cpuQuotaPercent: z.number().int().min(5).max(6400).nullable().optional(),
});

const commandSchema = z.object({
  command: z.string().min(1).max(1000),
});

export function registerInstanceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auditAction = async (
    request: { auth: { user: { id: string; username: string } } | null },
    action: string,
    instanceId: string,
    detail?: string,
  ) => {
    await ctx.audit({
      userId: request.auth?.user.id,
      username: request.auth?.user.username,
      action,
      targetType: 'instance',
      targetId: instanceId,
      detail,
    });
  };

  app.get('/api/instances', { preHandler: requireRole('viewer') }, async () => {
    return ctx.instances.listDtos();
  });

  app.get('/api/instances/:id', { preHandler: requireRole('viewer') }, async (request) => {
    const { id } = request.params as { id: string };
    const row = await ctx.instances.getRow(id);
    return ctx.instances.toDto(row, true);
  });

  app.post('/api/instances', { preHandler: requireRole('admin') }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    const row = await ctx.instances.create(parsed.data);
    await auditAction(request, 'instance.create', row.id, `${row.name} (${row.template_id})`);
    reply.code(201);
    return ctx.instances.toDto(row);
  });

  app.post(
    '/api/instances/:id/clone',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = cloneSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest('A name for the clone is required');
      const row = await ctx.instances.clone(id, parsed.data.name);
      await auditAction(request, 'instance.clone', row.id, `cloned from ${id} as ${row.name}`);
      reply.code(201);
      return ctx.instances.toDto(row);
    },
  );

  app.patch('/api/instances/:id', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    const row = await ctx.instances.update(id, parsed.data);
    await auditAction(request, 'instance.update', id, Object.keys(parsed.data).join(', '));
    return ctx.instances.toDto(row);
  });

  app.delete('/api/instances/:id', { preHandler: requireRole('admin') }, async (request) => {
    const { id } = request.params as { id: string };
    const row = await ctx.instances.getRow(id);
    const job = await ctx.instances.enqueueDelete(id, request.auth!.user.username);
    await auditAction(request, 'instance.delete', id, row.name);
    return { job: await ctx.jobs.dto(job) };
  });

  // --- actions -----------------------------------------------------------------

  app.post(
    '/api/instances/:id/install',
    { preHandler: requireRole('operator') },
    async (request) => {
      const { id } = request.params as { id: string };
      const job = await ctx.instances.enqueueInstall(id, request.auth!.user.username, false);
      await auditAction(request, 'instance.install', id);
      return { job: await ctx.jobs.dto(job) };
    },
  );

  app.post(
    '/api/instances/:id/update',
    { preHandler: requireRole('operator') },
    async (request) => {
      const { id } = request.params as { id: string };
      const job = await ctx.instances.enqueueInstall(id, request.auth!.user.username, true);
      await auditAction(request, 'instance.update_files', id);
      return { job: await ctx.jobs.dto(job) };
    },
  );

  app.post('/api/instances/:id/start', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    await ctx.instances.start(id);
    await auditAction(request, 'instance.start', id);
    return { ok: true };
  });

  app.post('/api/instances/:id/stop', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    await auditAction(request, 'instance.stop', id);
    await ctx.instances.stop(id);
    return { ok: true };
  });

  app.post(
    '/api/instances/:id/restart',
    { preHandler: requireRole('operator') },
    async (request) => {
      const { id } = request.params as { id: string };
      await auditAction(request, 'instance.restart', id);
      await ctx.instances.restart(id);
      return { ok: true };
    },
  );

  app.post('/api/instances/:id/kill', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    await auditAction(request, 'instance.kill', id);
    await ctx.instances.kill(id);
    return { ok: true };
  });

  app.post(
    '/api/instances/:id/command',
    { preHandler: requireRole('operator') },
    async (request) => {
      const { id } = request.params as { id: string };
      const parsed = commandSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest('A command string is required');
      await ctx.instances.sendCommand(id, parsed.data.command);
      // Not truncated to a display-friendly length here (unlike other audit
      // details) - this is also the source of the console's recall history,
      // so a resent command must come back byte-for-byte.
      await auditAction(request, 'instance.command', id, parsed.data.command);
      return { ok: true };
    },
  );

  app.get(
    '/api/instances/:id/commands/history',
    { preHandler: requireRole('viewer') },
    async (request) => {
      const { id } = request.params as { id: string };
      await ctx.instances.getRow(id);
      const rows = await ctx.repos.audit.listCommandHistory(id);
      return rows
        .filter((row) => row.detail !== null)
        .map((row) => ({ command: row.detail!, sentAt: row.created_at }));
    },
  );

  // --- logs ---------------------------------------------------------------------

  app.get('/api/instances/:id/logs', { preHandler: requireRole('viewer') }, async (request) => {
    const { id } = request.params as { id: string };
    await ctx.instances.getRow(id);
    const live = ctx.processes.recentLines(id);
    if (live.length > 0) {
      return { lines: live, source: 'live' };
    }
    const fileLines = await ctx.processes.recentLinesFromFile(id);
    return {
      lines: fileLines.map((line) => ({ ts: 0, stream: 'stdout' as const, line })),
      source: 'file',
    };
  });

  // Live console stream (SSE).
  app.get(
    '/api/instances/:id/logs/stream',
    { preHandler: requireRole('viewer') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await ctx.instances.getRow(id);

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write(':ok\n\n');

      // Replay + live frames both carry an ARRAY of console lines: the
      // buffered history goes out as one frame, and live output arrives one
      // frame per process-manager poll tick, pre-serialized once in the hub
      // no matter how many viewers are attached.
      const backlog = ctx.processes.recentLines(id);
      if (backlog.length > 0) {
        reply.raw.write(`data: ${JSON.stringify(backlog)}\n\n`);
      }

      const unsubscribe = ctx.events.onConsole(id, (_lines, frame) => {
        // Skip frames for a stalled client instead of buffering without bound.
        if (reply.raw.writableLength > 1_000_000) return;
        reply.raw.write(frame);
      });
      const keepAlive = setInterval(() => reply.raw.write(':ka\n\n'), 25000);

      request.raw.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
      });

      // Keep the connection open; fastify must not try to send a response.
      await new Promise<void>((resolve) => request.raw.on('close', () => resolve()));
    },
  );
}
