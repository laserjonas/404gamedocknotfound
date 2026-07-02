import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireRole } from '../plugins/auth.js';

/** Global SSE stream: instance status changes, job updates, audit events. */
export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/events/stream', { preHandler: requireRole('viewer') }, async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(':ok\n\n');

    const unsubscribe = ctx.events.onEvent((event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const keepAlive = setInterval(() => reply.raw.write(':ka\n\n'), 25000);

    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });

    await new Promise<void>((resolve) => request.raw.on('close', () => resolve()));
  });
}
