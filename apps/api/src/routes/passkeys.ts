import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { AppContext } from '../context.js';
import { requireRole, sendLoginResponse } from '../plugins/auth.js';
import { badRequest } from '../errors.js';

const registerCompleteSchema = z.object({
  nickname: z.string().min(1).max(64),
  response: z.record(z.string(), z.unknown()),
});

const loginCompleteSchema = z.object({
  response: z.record(z.string(), z.unknown()),
});

export function registerPasskeyRoutes(app: FastifyInstance, ctx: AppContext): void {
  // --- Usernameless login (no session yet) -----------------------------------

  app.post('/api/auth/passkeys/login/begin', async () => {
    return ctx.auth.beginPasskeyLogin();
  });

  app.post('/api/auth/passkeys/login/complete', async (request, reply) => {
    const parsed = loginCompleteSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('A passkey response is required');

    const result = await ctx.auth.completePasskeyLogin(
      parsed.data.response as unknown as AuthenticationResponseJSON,
      { ip: request.ip, userAgent: request.headers['user-agent'] },
    );
    return sendLoginResponse(reply, ctx, result);
  });

  // --- Self-service registration/management (already authenticated) ----------

  app.post(
    '/api/auth/passkeys/register/begin',
    { preHandler: requireRole('viewer') },
    async (request) => {
      return ctx.auth.beginPasskeyRegistration(request.auth!.user.id);
    },
  );

  app.post(
    '/api/auth/passkeys/register/complete',
    { preHandler: requireRole('viewer') },
    async (request) => {
      const parsed = registerCompleteSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest('A passkey response and nickname are required');

      const passkey = await ctx.auth.finishPasskeyRegistration(
        request.auth!.user.id,
        parsed.data.response as unknown as RegistrationResponseJSON,
        parsed.data.nickname,
      );
      await ctx.audit({
        userId: request.auth!.user.id,
        username: request.auth!.user.username,
        action: 'auth.passkey_registered',
        detail: passkey.nickname,
      });
      return passkey;
    },
  );

  app.get('/api/auth/passkeys', { preHandler: requireRole('viewer') }, async (request) => {
    return ctx.auth.listPasskeys(request.auth!.user.id);
  });

  app.delete('/api/auth/passkeys/:id', { preHandler: requireRole('viewer') }, async (request) => {
    const { id } = request.params as { id: string };
    await ctx.auth.removePasskey(request.auth!.user.id, id);
    await ctx.audit({
      userId: request.auth!.user.id,
      username: request.auth!.user.username,
      action: 'auth.passkey_removed',
    });
    return { ok: true };
  });
}
