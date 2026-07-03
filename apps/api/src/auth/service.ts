import { createHash, randomBytes } from 'node:crypto';
import type { Role, UserDto } from '@gamedock/shared';
import { ROLE_LEVELS } from '@gamedock/shared';
import type { UserRepository, UserRow } from '../db/repositories/users.js';
import { toUserDto } from '../db/repositories/users.js';
import type { SessionRepository, SessionRow } from '../db/repositories/sessions.js';
import { dummyVerify, verifyPassword } from './passwords.js';
import { unauthorized } from '../errors.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface AuthResult {
  user: UserDto;
  sessionToken: string;
  csrfToken: string;
}

export interface AuthenticatedSession {
  user: UserRow;
  session: SessionRow;
}

/** Simple in-memory login throttle: 5 failures per key per 15 minutes. */
class LoginThrottle {
  private failures = new Map<string, { count: number; firstAt: number }>();
  private readonly windowMs = 15 * 60 * 1000;
  private readonly maxFailures = 5;

  isBlocked(key: string): boolean {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (Date.now() - entry.firstAt > this.windowMs) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= this.maxFailures;
  }

  recordFailure(key: string): void {
    const entry = this.failures.get(key);
    if (!entry || Date.now() - entry.firstAt > this.windowMs) {
      this.failures.set(key, { count: 1, firstAt: Date.now() });
    } else {
      entry.count += 1;
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}

export class AuthService {
  private throttle = new LoginThrottle();

  constructor(
    private users: UserRepository,
    private sessions: SessionRepository,
  ) {}

  async login(
    username: string,
    password: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<AuthResult> {
    const throttleKey = `${meta.ip ?? 'unknown'}:${username.toLowerCase()}`;
    if (this.throttle.isBlocked(throttleKey)) {
      throw unauthorized('Too many failed login attempts. Try again in a few minutes.');
    }

    const user = await this.users.findByUsername(username);
    if (!user || user.disabled === 1) {
      await dummyVerify();
      this.throttle.recordFailure(throttleKey);
      throw unauthorized('Invalid username or password');
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      this.throttle.recordFailure(throttleKey);
      throw unauthorized('Invalid username or password');
    }

    this.throttle.reset(throttleKey);
    await this.users.recordLogin(user.id);

    const sessionToken = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    await this.sessions.create({
      userId: user.id,
      tokenHash: hashToken(sessionToken),
      csrfToken,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { user: toUserDto(user), sessionToken, csrfToken };
  }

  async validateSession(sessionToken: string): Promise<AuthenticatedSession | null> {
    const session = await this.sessions.findByTokenHash(hashToken(sessionToken));
    if (!session) return null;
    if (new Date(session.expires_at).getTime() < Date.now()) {
      await this.sessions.deleteByTokenHash(session.token_hash);
      return null;
    }
    const user = await this.users.findById(session.user_id);
    if (!user || user.disabled === 1) return null;
    return { user, session };
  }

  async logout(sessionToken: string): Promise<void> {
    await this.sessions.deleteByTokenHash(hashToken(sessionToken));
  }

  async logoutAllForUser(userId: string): Promise<void> {
    await this.sessions.deleteForUser(userId);
  }

  async cleanupExpired(): Promise<void> {
    await this.sessions.deleteExpired();
  }
}

export function roleAtLeast(userRole: Role, required: Role): boolean {
  return ROLE_LEVELS[userRole] >= ROLE_LEVELS[required];
}
