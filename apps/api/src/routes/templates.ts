import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireRole } from '../plugins/auth.js';

export function registerTemplateRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/templates', { preHandler: requireRole('viewer') }, async () => {
    return ctx.templates.list();
  });

  app.get('/api/templates/:id', { preHandler: requireRole('viewer') }, async (request) => {
    const { id } = request.params as { id: string };
    return ctx.templates.get(id);
  });
}
