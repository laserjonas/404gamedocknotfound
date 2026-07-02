import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireRole } from '../plugins/auth.js';

export function registerSteamRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/steam/catalog', { preHandler: requireRole('viewer') }, async (request) => {
    const { search, limit, offset } = request.query as {
      search?: string;
      limit?: string;
      offset?: string;
    };
    const parsedLimit = Math.min(Math.max(parseInt(limit ?? '50', 10) || 50, 1), 200);
    const parsedOffset = Math.max(parseInt(offset ?? '0', 10) || 0, 0);
    return ctx.steamCatalog.search(search ?? '', parsedLimit, parsedOffset);
  });
}
