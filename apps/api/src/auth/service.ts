import { createHash, randomBytes } from 'node:crypto';
import type { Role, UserDto } from '@gamedock/shared';
import { ROLE_LEVELS } from '@gamedock/shared';
import type { UserRepository, UserRow } from '../db/repositories/users.js';
import { toUserDto } from '../db/repositories/users.js';
import type { SessionRepository, SessionRow } from '../db/repositories/sessions.js';
import { dummyVerify, verifyPassword } from './passwords.js';
import { buildTotpEnrollment, generateTotpSecret, verifyTotpCode } from './totp.js';
import { badRequest, unauthorized } from '../errors.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TOTP_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface AuthResult {
  user: UserDto;
  sessionToken: string;
  csrfToken: string;
}

/** Login completes in one step, or two if the account has 2FA enabled. */
export type LoginOutcome =
  { status: 'ok'; result: AuthResult } | { status: 'totp_required'; challengeToken: string };

export interface AuthenticatedSession {
  user: UserRow;
  session: SessionRow;
}

interface PendingTotpChallenge {
  userId: string;
  expiresAt: number;
  ip?: string;
  userAgent?: string;
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
  private totpChallenges = new Map<string, PendingTotpChallenge>();

  constructor(
    private users: UserRepository,
    private sessions: SessionRepository,
  ) {}

  async login(
    username: string,
    password: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<LoginOutcome> {
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

    if (user.totp_enabled === 1) {
      const challengeToken = randomBytes(32).toString('hex');
      this.totpChallenges.set(challengeToken, {
        userId: user.id,
        expiresAt: Date.now() + TOTP_CHALLENGE_TTL_MS,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return { status: 'totp_required', challengeToken };
    }

    return { status: 'ok', result: await this.completeLogin(user, meta) };
  }

  /** Second step of login when the account has 2FA enabled. */
  async completeTotpLogin(challengeToken: string, code: string): Promise<AuthResult> {
    const pending = this.totpChallenges.get(challengeToken);
    if (!pending || pending.expiresAt < Date.now()) {
      this.totpChallenges.delete(challengeToken);
      throw unauthorized('Login challenge expired - please sign in again');
    }

    const throttleKey = `totp:${pending.userId}`;
    if (this.throttle.isBlocked(throttleKey)) {
      throw unauthorized('Too many failed codes. Try again in a few minutes.');
    }

    const user = await this.users.findById(pending.userId);
    if (!user || user.disabled === 1 || user.totp_enabled !== 1 || !user.totp_secret) {
      this.totpChallenges.delete(challengeToken);
      throw unauthorized('Login challenge is no longer valid - please sign in again');
    }

    const ok = await verifyTotpCode(user.totp_secret, code);
    if (!ok) {
      this.throttle.recordFailure(throttleKey);
      throw unauthorized('Invalid verification code');
    }

    this.throttle.reset(throttleKey);
    this.totpChallenges.delete(challengeToken);
    return this.completeLogin(user, { ip: pending.ip, userAgent: pending.userAgent });
  }

  private async completeLogin(
    user: UserRow,
    meta: { ip?: string; userAgent?: string },
  ): Promise<AuthResult> {
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

  // --- 2FA (self-service setup/teardown) ------------------------------------

  /** Generates a new secret (stored but not yet active) and its QR enrollment data. */
  async beginTotpSetup(
    userId: string,
  ): Promise<{ secret: string; otpauthUrl: string; qrCodeDataUrl: string }> {
    const user = await this.users.findById(userId);
    if (!user) throw unauthorized();
    const secret = generateTotpSecret();
    await this.users.update(userId, { totpSecret: secret });
    const { otpauthUrl, qrCodeDataUrl } = await buildTotpEnrollment(user.username, secret);
    return { secret, otpauthUrl, qrCodeDataUrl };
  }

  /** Verifies the first code from the authenticator app and turns 2FA on. */
  async confirmTotpSetup(userId: string, code: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user?.totp_secret) {
      throw badRequest('No pending 2FA setup for this account - start setup again');
    }
    const ok = await verifyTotpCode(user.totp_secret, code);
    if (!ok) throw badRequest('Invalid verification code');
    await this.users.update(userId, { totpEnabled: true });
  }

  /** Turns 2FA off (self-service after password re-entry, or an admin resetting another account). */
  async disableTotp(userId: string): Promise<void> {
    await this.users.update(userId, { totpSecret: null, totpEnabled: false });
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
    const now = Date.now();
    for (const [token, pending] of this.totpChallenges) {
      if (pending.expiresAt < now) this.totpChallenges.delete(token);
    }
  }
}

export function roleAtLeast(userRole: Role, required: Role): boolean {
  return ROLE_LEVELS[userRole] >= ROLE_LEVELS[required];
}
