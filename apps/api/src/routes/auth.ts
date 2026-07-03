import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LoginResponseDto } from '@gamedock/shared';
import type { AppContext } from '../context.js';
import { SESSION_COOKIE, requireRole, sendLoginResponse } from '../plugins/auth.js';
import { toUserDto } from '../db/repositories/users.js';
import { verifyPassword } from '../auth/passwords.js';
import { badRequest, unauthorized } from '../errors.js';

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

const totpLoginSchema = z.object({
  challengeToken: z.string().min(1).max(256),
  code: z.string().min(1).max(16),
});

const totpConfirmSchema = z.object({
  code: z.string().min(1).max(16),
});

const totpDisableSchema = z.object({
  password: z.string().min(1).max(256),
});

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/auth/login', async (request, reply): Promise<LoginResponseDto> => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Username and password are required');

    const outcome = await ctx.auth.login(parsed.data.username, parsed.data.password, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    if (outcome.status === 'totp_required') {
      return { status: 'totp_required', challengeToken: outcome.challengeToken };
    }
    const success = await sendLoginResponse(reply, ctx, outcome.result);
    return { status: 'ok', ...success };
  });

  app.post('/api/auth/login/totp', async (request, reply): Promise<LoginResponseDto> => {
    const parsed = totpLoginSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('A verification code is required');

    const result = await ctx.auth.completeTotpLogin(parsed.data.challengeToken, parsed.data.code);
    const success = await sendLoginResponse(reply, ctx, result);
    return { status: 'ok', ...success };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      if (request.auth) {
        await ctx.audit({
          userId: request.auth.user.id,
          username: request.auth.user.username,
          action: 'auth.logout',
        });
      }
      await ctx.auth.logout(token);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireRole('viewer') }, async (request) => {
    const auth = request.auth;
    if (!auth) throw unauthorized();
    return { user: toUserDto(auth.user), csrfToken: auth.session.csrf_token };
  });

  // --- 2FA self-service ------------------------------------------------------

  app.post('/api/auth/totp/setup', { preHandler: requireRole('viewer') }, async (request) => {
    return ctx.auth.beginTotpSetup(request.auth!.user.id);
  });

  app.post('/api/auth/totp/confirm', { preHandler: requireRole('viewer') }, async (request) => {
    const parsed = totpConfirmSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('A verification code is required');
    await ctx.auth.confirmTotpSetup(request.auth!.user.id, parsed.data.code);
    await ctx.audit({
      userId: request.auth!.user.id,
      username: request.auth!.user.username,
      action: 'auth.totp_enabled',
    });
    return { ok: true };
  });

  app.post('/api/auth/totp/disable', { preHandler: requireRole('viewer') }, async (request) => {
    const parsed = totpDisableSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Your current password is required');
    const ok = await verifyPassword(parsed.data.password, request.auth!.user.password_hash);
    if (!ok) throw unauthorized('Incorrect password');
    await ctx.auth.disableTotp(request.auth!.user.id);
    await ctx.audit({
      userId: request.auth!.user.id,
      username: request.auth!.user.username,
      action: 'auth.totp_disabled',
    });
    return { ok: true };
  });
}
