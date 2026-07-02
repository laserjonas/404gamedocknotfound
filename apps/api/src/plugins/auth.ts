import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@gamedock/shared';
import type { AuthService, AuthenticatedSession } from '../auth/service.js';
import { roleAtLeast } from '../auth/service.js';
import { forbidden, unauthorized } from '../errors.js';

export const SESSION_COOKIE = 'gamedock_session';
export const CSRF_HEADER = 'x-csrf-token';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthenticatedSession | null;
  }
}

/** Reads the session cookie and attaches the authenticated session (or null). */
export function buildAuthHook(authService: AuthService) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    request.auth = null;
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    request.auth = authService.validateSession(token);
  };
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
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const headerToken = request.headers[CSRF_HEADER];
      if (typeof headerToken !== 'string' || headerToken !== request.auth.session.csrf_token) {
        throw forbidden('Missing or invalid CSRF token');
      }
    }
  };
}
