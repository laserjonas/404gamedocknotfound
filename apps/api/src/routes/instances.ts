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
});

const commandSchema = z.object({
  command: z.string().min(1).max(1000),
});

export function registerInstanceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auditAction = (
    request: { auth: { user: { id: string; username: string } } | null },
    action: string,
    instanceId: string,
    detail?: string,
  ) => {
    ctx.audit({
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
    const row = ctx.instances.getRow(id);
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
    auditAction(request, 'instance.create', row.id, `${row.name} (${row.template_id})`);
    reply.code(201);
    return ctx.instances.toDto(row);
  });

  app.patch('/api/instances/:id', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    const row = await ctx.instances.update(id, parsed.data);
    auditAction(request, 'instance.update', id, Object.keys(parsed.data).join(', '));
    return ctx.instances.toDto(row);
  });

  app.delete('/api/instances/:id', { preHandler: requireRole('admin') }, async (request) => {
    const { id } = request.params as { id: string };
    const row = ctx.instances.getRow(id);
    const job = ctx.instances.enqueueDelete(id, request.auth!.user.username);
    auditAction(request, 'instance.delete', id, row.name);
    return { job: ctx.jobs.dto(job) };
  });

  // --- actions -----------------------------------------------------------------

  app.post(
    '/api/instances/:id/install',
    { preHandler: requireRole('operator') },
    async (request) => {
      const { id } = request.params as { id: string };
      const job = ctx.instances.enqueueInstall(id, request.auth!.user.username, false);
      auditAction(request, 'instance.install', id);
      return { job: ctx.jobs.dto(job) };
    },
  );

  app.post(
    '/api/instances/:id/update',
    { preHandler: requireRole('operator') },
    async (request) => {
      const { id } = request.params as { id: string };
      const job = ctx.instances.enqueueInstall(id, request.auth!.user.username, true);
      auditAction(request, 'instance.update_files', id);
      return { job: ctx.jobs.dto(job) };
    },
  );

  app.post('/api/instances/:id/start', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    ctx.instances.start(id);
    auditAction(request, 'instance.start', id);
    return { ok: true };
  });

  app.post('/api/instances/:id/stop', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    auditAction(request, 'instance.stop', id);
    await ctx.instances.stop(id);
    return { ok: true };
  });

  app.post(
    '/api/instances/:id/restart',
    { preHandler: requireRole('operator') },
    async (request) => {
      const { id } = request.params as { id: string };
      auditAction(request, 'instance.restart', id);
      await ctx.instances.restart(id);
      return { ok: true };
    },
  );

  app.post('/api/instances/:id/kill', { preHandler: requireRole('operator') }, async (request) => {
    const { id } = request.params as { id: string };
    auditAction(request, 'instance.kill', id);
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
      ctx.instances.sendCommand(id, parsed.data.command);
      auditAction(request, 'instance.command', id, parsed.data.command.slice(0, 200));
      return { ok: true };
    },
  );

  // --- logs ---------------------------------------------------------------------

  app.get('/api/instances/:id/logs', { preHandler: requireRole('viewer') }, async (request) => {
    const { id } = request.params as { id: string };
    ctx.instances.getRow(id);
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
      ctx.instances.getRow(id);

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write(':ok\n\n');

      for (const line of ctx.processes.recentLines(id)) {
        reply.raw.write(`data: ${JSON.stringify(line)}\n\n`);
      }

      const unsubscribe = ctx.events.onConsole(id, (line) => {
        reply.raw.write(`data: ${JSON.stringify(line)}\n\n`);
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
