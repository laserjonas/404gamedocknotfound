import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireRole } from '../plugins/auth.js';
import { badRequest } from '../errors.js';

const createSchema = z.object({
  name: z.string().min(1).max(64),
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
});

export function registerApiTokenRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/auth/tokens', { preHandler: requireRole('viewer') }, async (request) => {
    return ctx.auth.listApiTokens(request.auth!.user.id);
  });

  app.post('/api/auth/tokens', { preHandler: requireRole('viewer') }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('A token name is required');
    const { token, dto } = await ctx.auth.createApiToken(
      request.auth!.user.id,
      parsed.data.name,
      parsed.data.expiresInDays ?? null,
    );
    await ctx.audit({
      userId: request.auth!.user.id,
      username: request.auth!.user.username,
      action: 'auth.token_created',
      detail: dto.name,
    });
    reply.code(201);
    return { ...dto, token };
  });

  app.delete('/api/auth/tokens/:id', { preHandler: requireRole('viewer') }, async (request) => {
    const { id } = request.params as { id: string };
    await ctx.auth.removeApiToken(request.auth!.user.id, id);
    await ctx.audit({
      userId: request.auth!.user.id,
      username: request.auth!.user.username,
      action: 'auth.token_removed',
    });
    return { ok: true };
  });
}
