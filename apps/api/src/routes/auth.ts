import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { SESSION_COOKIE, requireRole } from '../plugins/auth.js';
import { toUserDto } from '../db/repositories/users.js';
import { badRequest, unauthorized } from '../errors.js';

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: ctx.config.secureCookies,
    maxAge: 7 * 24 * 60 * 60,
  };

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Username and password are required');

    const result = await ctx.auth.login(parsed.data.username, parsed.data.password, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    ctx.audit({
      userId: result.user.id,
      username: result.user.username,
      action: 'auth.login',
    });

    reply.setCookie(SESSION_COOKIE, result.sessionToken, cookieOptions);
    return { user: result.user, csrfToken: result.csrfToken };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      if (request.auth) {
        ctx.audit({
          userId: request.auth.user.id,
          username: request.auth.user.username,
          action: 'auth.logout',
        });
      }
      ctx.auth.logout(token);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireRole('viewer') }, async (request) => {
    const auth = request.auth;
    if (!auth) throw unauthorized();
    return { user: toUserDto(auth.user), csrfToken: auth.session.csrf_token };
  });
}
