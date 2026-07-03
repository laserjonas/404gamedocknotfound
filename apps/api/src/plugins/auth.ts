import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthSuccessDto, Role } from '@gamedock/shared';
import type { AuthResult, AuthService, AuthenticatedSession } from '../auth/service.js';
import { roleAtLeast } from '../auth/service.js';
import type { AppContext } from '../context.js';
import { forbidden, unauthorized } from '../errors.js';

export const SESSION_COOKIE = 'gamedock_session';
export const CSRF_HEADER = 'x-csrf-token';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthenticatedSession | null;
  }
}

const BEARER_PREFIX = 'Bearer ';

/**
 * Reads the session cookie (browser/SPA) or, if absent, an
 * `Authorization: Bearer <token>` header (scripting/automation) and
 * attaches the authenticated session (or null).
 */
export function buildAuthHook(authService: AuthService) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    request.auth = null;
    const cookieToken = request.cookies[SESSION_COOKIE];
    if (cookieToken) {
      request.auth = await authService.validateSession(cookieToken);
      return;
    }
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith(BEARER_PREFIX)) {
      request.auth = await authService.validateApiToken(
        authHeader.slice(BEARER_PREFIX.length).trim(),
      );
    }
  };
}

/**
 * Sets the session cookie, audit-logs the login, and returns the response
 * body - the shared terminal for every login method (password/TOTP,
 * passkey), matching how AuthService's own `completeLogin` is the shared
 * terminal on the service side.
 */
export async function sendLoginResponse(
  reply: FastifyReply,
  ctx: AppContext,
  result: AuthResult,
): Promise<AuthSuccessDto> {
  await ctx.audit({
    userId: result.user.id,
    username: result.user.username,
    action: 'auth.login',
  });
  reply.setCookie(SESSION_COOKIE, result.sessionToken, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: ctx.config.secureCookies,
    maxAge: 7 * 24 * 60 * 60,
  });
  return { user: result.user, csrfToken: result.csrfToken };
}

/**
 * Route-level guard. Verifies authentication, role, and (for mutating
 * requests) the CSRF token bound to the session.
 */
export function requireRole(role: Role) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!request.auth) {
      throw unauthorized();
    }
    if (!roleAtLeast(request.auth.user.role, role)) {
      throw forbidden(`This action requires the ${role} role`);
    }
    // API-token auth has no cookie, so it isn't a CSRF vector - a bearer
    // token is never automatically attached to a request the way a
    // cookie is, and there's no session to hold a CSRF token anyway.
    if (request.auth.session === null) return;
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const headerToken = request.headers[CSRF_HEADER];
      if (typeof headerToken !== 'string' || headerToken !== request.auth.session.csrf_token) {
        throw forbidden('Missing or invalid CSRF token');
      }
    }
  };
}
