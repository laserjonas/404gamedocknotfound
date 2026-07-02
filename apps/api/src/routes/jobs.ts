import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireRole } from '../plugins/auth.js';
import { notFound } from '../errors.js';

export function registerJobRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/jobs', { preHandler: requireRole('viewer') }, async (request) => {
    const { instanceId, limit } = request.query as { instanceId?: string; limit?: string };
    const parsedLimit = Math.min(Math.max(parseInt(limit ?? '50', 10) || 50, 1), 200);
    return ctx.repos.jobs.list(parsedLimit, instanceId).map((row) => ctx.jobs.dto(row));
  });

  app.get('/api/jobs/:id', { preHandler: requireRole('viewer') }, async (request) => {
    const { id } = request.params as { id: string };
    const row = ctx.repos.jobs.findById(id);
    if (!row) throw notFound('Job not found');
    return { ...ctx.jobs.dto(row), log: row.log };
  });

  // Live job log stream (SSE): replays the stored log, then follows.
  app.get('/api/jobs/:id/stream', { preHandler: requireRole('viewer') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = ctx.repos.jobs.findById(id);
    if (!row) throw notFound('Job not found');

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(':ok\n\n');

    if (row.log) {
      reply.raw.write(`data: ${JSON.stringify({ text: row.log })}\n\n`);
    }

    const unsubscribe = ctx.events.onJobLog(id, (text) => {
      reply.raw.write(`data: ${JSON.stringify({ text })}\n\n`);
    });
    const unsubscribeEvents = ctx.events.onEvent((event) => {
      if (event.kind === 'job_update' && event.job.id === id) {
        reply.raw.write(`event: job\ndata: ${JSON.stringify(event.job)}\n\n`);
      }
    });
    const keepAlive = setInterval(() => reply.raw.write(':ka\n\n'), 25000);

    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      unsubscribeEvents();
    });

    await new Promise<void>((resolve) => request.raw.on('close', () => resolve()));
  });
}
