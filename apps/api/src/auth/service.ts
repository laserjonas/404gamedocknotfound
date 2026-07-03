import { createHash, randomBytes } from 'node:crypto';
import type { ApiTokenDto, PasskeyDto, Role, UserDto } from '@gamedock/shared';
import { ROLE_LEVELS } from '@gamedock/shared';
import type { UserRepository, UserRow } from '../db/repositories/users.js';
import { toUserDto } from '../db/repositories/users.js';
import type { SessionRepository, SessionRow } from '../db/repositories/sessions.js';
import type { ApiTokenRepository, ApiTokenRow } from '../db/repositories/apiTokens.js';
import type {
  WebauthnCredentialRepository,
  WebauthnCredentialRow,
} from '../db/repositories/webauthnCredentials.js';
import { dummyVerify, verifyPassword } from './passwords.js';
import {
  buildTotpEnrollment,
  generateRecoveryCodes,
  generateTotpSecret,
  looksLikeRecoveryCode,
  verifyTotpCode,
} from './totp.js';
import {
  base64urlToBuffer,
  buildAuthenticationOptions,
  buildRegistrationOptions,
  bufferToBase64url,
  handleToUserId,
  parseTransports,
  verifyAuthentication,
  verifyRegistration,
} from './passkey.js';
import { badRequest, unauthorized } from '../errors.js';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TOTP_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface AuthResult {
  user: UserDto;
  sessionToken: string;
  csrfToken: string;
}

/** Login completes in one step, or two if the account has 2FA enabled. */
export type LoginOutcome =
  { status: 'ok'; result: AuthResult } | { status: 'totp_required'; challengeToken: string };

/**
 * `session` is null for API-token authentication - there's no CSRF vector
 * (a bearer token is never automatically attached to a request the way a
 * cookie is), and no session row to expose a CSRF token from.
 */
export interface AuthenticatedSession {
  user: UserRow;
  session: SessionRow | null;
}

const API_TOKEN_PREFIX = 'gd_';

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
  /** One pending registration per user at a time - overwritten on retry, same as beginTotpSetup. */
  private passkeyRegistrationChallenges = new Map<
    string,
    { challenge: string; expiresAt: number }
  >();
  /**
   * Keyed by the WebAuthn challenge value itself, not a second minted token:
   * generateAuthenticationOptions() already produces a random, single-use
   * challenge that round-trips through the ceremony automatically, so
   * inventing a second correlation id (the way TOTP's challengeToken has
   * to, since TOTP has none of its own) would just duplicate it.
   */
  private passkeyLoginChallenges = new Map<string, { expiresAt: number }>();

  constructor(
    private users: UserRepository,
    private sessions: SessionRepository,
    private webauthnCredentials: WebauthnCredentialRepository,
    private apiTokens: ApiTokenRepository,
    private webauthn: { rpId: string; origin: string },
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

    const usingRecoveryCode = looksLikeRecoveryCode(code);
    const ok = usingRecoveryCode
      ? await this.consumeRecoveryCode(user, code)
      : await verifyTotpCode(user.totp_secret, code);
    if (!ok) {
      this.throttle.recordFailure(throttleKey);
      throw unauthorized(
        usingRecoveryCode ? 'Invalid or already-used recovery code' : 'Invalid verification code',
      );
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

  /** Verifies the first code from the authenticator app, turns 2FA on, and issues recovery codes. */
  async confirmTotpSetup(userId: string, code: string): Promise<string[]> {
    const user = await this.users.findById(userId);
    if (!user?.totp_secret) {
      throw badRequest('No pending 2FA setup for this account - start setup again');
    }
    const ok = await verifyTotpCode(user.totp_secret, code);
    if (!ok) throw badRequest('Invalid verification code');
    await this.users.update(userId, { totpEnabled: true });
    return this.regenerateRecoveryCodes(userId);
  }

  /** Turns 2FA off (self-service after password re-entry, or an admin resetting another account). */
  async disableTotp(userId: string): Promise<void> {
    await this.users.update(userId, {
      totpSecret: null,
      totpEnabled: false,
      totpRecoveryCodes: null,
    });
  }

  /** Issues a fresh batch of recovery codes, invalidating any unused ones. Shown once, in plaintext. */
  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const user = await this.users.findById(userId);
    if (!user || user.totp_enabled !== 1) {
      throw badRequest('Enable 2FA before generating recovery codes');
    }
    const codes = generateRecoveryCodes();
    await this.users.update(userId, { totpRecoveryCodes: codes.map(hashToken) });
    return codes;
  }

  /** One-time-use: consumes and invalidates a recovery code if it matches. */
  private async consumeRecoveryCode(user: UserRow, code: string): Promise<boolean> {
    if (!user.totp_recovery_codes) return false;
    const hashes = JSON.parse(user.totp_recovery_codes) as string[];
    const hash = hashToken(code.trim().toUpperCase());
    const index = hashes.indexOf(hash);
    if (index === -1) return false;
    hashes.splice(index, 1);
    await this.users.update(user.id, { totpRecoveryCodes: hashes });
    // Keep the in-memory row in sync - completeLogin() below builds its DTO
    // from this same object, and would otherwise report the pre-consumption count.
    user.totp_recovery_codes = JSON.stringify(hashes);
    return true;
  }

  // --- Passkeys (self-service registration) ----------------------------------

  private toPasskeyDto(row: WebauthnCredentialRow): PasskeyDto {
    return {
      id: row.id,
      nickname: row.nickname,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      deviceType: row.device_type,
    };
  }

  async listPasskeys(userId: string): Promise<PasskeyDto[]> {
    const rows = await this.webauthnCredentials.listForUser(userId);
    return rows.map((row) => this.toPasskeyDto(row));
  }

  async beginPasskeyRegistration(userId: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const user = await this.users.findById(userId);
    if (!user) throw unauthorized();
    const existing = await this.webauthnCredentials.listForUser(userId);
    const options = await buildRegistrationOptions({
      rpID: this.webauthn.rpId,
      userId: user.id,
      username: user.username,
      existingCredentialIds: existing.map((row) => row.credential_id),
    });
    this.passkeyRegistrationChallenges.set(userId, {
      challenge: options.challenge,
      expiresAt: Date.now() + PASSKEY_CHALLENGE_TTL_MS,
    });
    return options;
  }

  async finishPasskeyRegistration(
    userId: string,
    response: RegistrationResponseJSON,
    nickname: string,
  ): Promise<PasskeyDto> {
    const pending = this.passkeyRegistrationChallenges.get(userId);
    if (!pending || pending.expiresAt < Date.now()) {
      this.passkeyRegistrationChallenges.delete(userId);
      throw badRequest('Passkey setup expired - start again');
    }

    const verification = await verifyRegistration({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: this.webauthn.origin,
      expectedRPID: this.webauthn.rpId,
    });
    this.passkeyRegistrationChallenges.delete(userId);
    if (!verification.verified || !verification.registrationInfo) {
      throw badRequest('Could not verify the new passkey');
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const row = await this.webauthnCredentials.create({
      userId,
      credentialId: credential.id,
      publicKey: bufferToBase64url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ? JSON.stringify(credential.transports) : null,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      nickname: nickname.trim().slice(0, 64) || 'Passkey',
    });
    return this.toPasskeyDto(row);
  }

  async removePasskey(userId: string, id: string): Promise<void> {
    const { changes } = await this.webauthnCredentials.deleteForUser(userId, id);
    if (changes === 0) throw badRequest('Passkey not found');
  }

  /** Admin lost-all-devices recovery path (parallel to disableTotp). */
  async removeAllPasskeysForUser(userId: string): Promise<void> {
    await this.webauthnCredentials.deleteAllForUser(userId);
  }

  // --- Passkeys (usernameless login) ------------------------------------------

  async beginPasskeyLogin(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const options = await buildAuthenticationOptions(this.webauthn.rpId);
    this.passkeyLoginChallenges.set(options.challenge, {
      expiresAt: Date.now() + PASSKEY_CHALLENGE_TTL_MS,
    });
    return options;
  }

  async completePasskeyLogin(
    response: AuthenticationResponseJSON,
    meta: { ip?: string; userAgent?: string },
  ): Promise<AuthResult> {
    const credentialRow = await this.webauthnCredentials.findByCredentialId(response.id);
    if (!credentialRow) throw unauthorized('Passkey not recognized');

    // Defense-in-depth per SimpleWebAuthn's discoverable-credential guidance -
    // the primary lookup above is already unambiguous (credential_id is
    // globally unique), this just cross-checks the assertion agrees.
    const handleUserId = response.response.userHandle
      ? handleToUserId(response.response.userHandle)
      : null;
    if (handleUserId && handleUserId !== credentialRow.user_id) {
      throw unauthorized('Passkey not recognized');
    }

    const user = await this.users.findById(credentialRow.user_id);
    if (!user || user.disabled === 1) throw unauthorized('Passkey not recognized');

    let challengeAccepted = false;
    const verification = await verifyAuthentication({
      response,
      // One-time-use lookup: only a challenge we actually issued and haven't
      // already consumed passes, and it's deleted the instant it's checked.
      expectedChallenge: (challenge) => {
        const pending = this.passkeyLoginChallenges.get(challenge);
        if (!pending || pending.expiresAt < Date.now()) return false;
        this.passkeyLoginChallenges.delete(challenge);
        challengeAccepted = true;
        return true;
      },
      expectedOrigin: this.webauthn.origin,
      expectedRPID: this.webauthn.rpId,
      credential: {
        id: credentialRow.credential_id,
        publicKey: base64urlToBuffer(credentialRow.public_key),
        counter: credentialRow.counter,
        transports: parseTransports(credentialRow.transports),
      },
    });
    if (!challengeAccepted) throw unauthorized('Login challenge expired - please try again');
    if (!verification.verified) throw unauthorized('Could not verify passkey');

    await this.webauthnCredentials.updateCounter(
      credentialRow.id,
      verification.authenticationInfo.newCounter,
    );
    return this.completeLogin(user, meta);
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

  // --- API tokens (self-service, for scripting/automation) -------------------

  private toApiTokenDto(row: ApiTokenRow): ApiTokenDto {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
    };
  }

  async listApiTokens(userId: string): Promise<ApiTokenDto[]> {
    const rows = await this.apiTokens.listForUser(userId);
    return rows.map((row) => this.toApiTokenDto(row));
  }

  /** Returns the raw token exactly once - only its hash is ever stored. */
  async createApiToken(
    userId: string,
    name: string,
    expiresInDays: number | null,
  ): Promise<{ token: string; dto: ApiTokenDto }> {
    const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    // expiresInDays is validated (positive, capped) at the route layer; a
    // negative value here is only ever exercised by tests, to construct an
    // already-expired token for validateApiToken()'s expiry check.
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
    const row = await this.apiTokens.create({
      userId,
      name: name.trim().slice(0, 64) || 'Token',
      tokenHash: hashToken(token),
      expiresAt,
    });
    return { token, dto: this.toApiTokenDto(row) };
  }

  async removeApiToken(userId: string, id: string): Promise<void> {
    const { changes } = await this.apiTokens.deleteForUser(userId, id);
    if (changes === 0) throw badRequest('Token not found');
  }

  /** Admin lost-all-tokens recovery path (parallel to resetTotp/resetPasskeys). */
  async removeAllApiTokensForUser(userId: string): Promise<void> {
    await this.apiTokens.deleteAllForUser(userId);
  }

  /** Authenticates an `Authorization: Bearer <token>` request. No session/CSRF involved. */
  async validateApiToken(rawToken: string): Promise<AuthenticatedSession | null> {
    if (!rawToken.startsWith(API_TOKEN_PREFIX)) return null;
    const row = await this.apiTokens.findByTokenHash(hashToken(rawToken));
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
    const user = await this.users.findById(row.user_id);
    if (!user || user.disabled === 1) return null;
    await this.apiTokens.updateLastUsed(row.id);
    return { user, session: null };
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
    for (const [userId, pending] of this.passkeyRegistrationChallenges) {
      if (pending.expiresAt < now) this.passkeyRegistrationChallenges.delete(userId);
    }
    for (const [challenge, pending] of this.passkeyLoginChallenges) {
      if (pending.expiresAt < now) this.passkeyLoginChallenges.delete(challenge);
    }
  }
}

export function roleAtLeast(userRole: Role, required: Role): boolean {
  return ROLE_LEVELS[userRole] >= ROLE_LEVELS[required];
}
