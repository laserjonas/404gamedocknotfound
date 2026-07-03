import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generate } from 'otplib';
import { AuthService } from './service.js';
import { hashPassword } from './passwords.js';
import { generateTotpSecret } from './totp.js';
import type { UserRepository, UserRow } from '../db/repositories/users.js';
import type { SessionRepository, SessionRow } from '../db/repositories/sessions.js';

function fakeUsers(initial: UserRow[] = []): UserRepository {
  const rows = new Map(initial.map((r) => [r.id, r]));
  return {
    findById: async (id: string) => rows.get(id),
    findByUsername: async (username: string) =>
      [...rows.values()].find((r) => r.username.toLowerCase() === username.toLowerCase()),
    update: async (id: string, patch: Record<string, unknown>) => {
      const row = rows.get(id);
      if (!row) return;
      if ('totpSecret' in patch) row.totp_secret = patch.totpSecret as string | null;
      if ('totpEnabled' in patch) row.totp_enabled = patch.totpEnabled ? 1 : 0;
      if ('disabled' in patch) row.disabled = patch.disabled ? 1 : 0;
    },
    recordLogin: async () => {},
  } as unknown as UserRepository;
}

function fakeSessions(): SessionRepository {
  const rows = new Map<string, SessionRow>();
  return {
    create: async (params: {
      userId: string;
      tokenHash: string;
      csrfToken: string;
      expiresAt: string;
    }) => {
      const row: SessionRow = {
        id: randomUUID(),
        user_id: params.userId,
        token_hash: params.tokenHash,
        csrf_token: params.csrfToken,
        created_at: new Date().toISOString(),
        expires_at: params.expiresAt,
        ip: null,
        user_agent: null,
      };
      rows.set(row.token_hash, row);
      return row;
    },
    findByTokenHash: async (hash: string) => rows.get(hash),
    deleteByTokenHash: async (hash: string) => void rows.delete(hash),
    deleteForUser: async () => {},
    deleteExpired: async () => 0,
  } as unknown as SessionRepository;
}

async function makeUser(overrides: Partial<UserRow> = {}): Promise<UserRow> {
  return {
    id: randomUUID(),
    username: 'alice',
    password_hash: await hashPassword('correct-horse-battery'),
    role: 'admin',
    disabled: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_login_at: null,
    totp_secret: null,
    totp_enabled: 0,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuthService.login', () => {
  it('completes in one step for an account without 2FA', async () => {
    const user = await makeUser();
    const service = new AuthService(fakeUsers([user]), fakeSessions());

    const outcome = await service.login('alice', 'correct-horse-battery', {});

    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.result.user.username).toBe('alice');
      expect(outcome.result.sessionToken).toBeTruthy();
    }
  });

  it('rejects a wrong password without revealing which part was wrong', async () => {
    const user = await makeUser();
    const service = new AuthService(fakeUsers([user]), fakeSessions());

    await expect(service.login('alice', 'wrong-password', {})).rejects.toThrow(
      /Invalid username or password/,
    );
  });

  it('returns a totp_required challenge (no session yet) for a 2FA-enabled account', async () => {
    const secret = generateTotpSecret();
    const user = await makeUser({ totp_secret: secret, totp_enabled: 1 });
    const service = new AuthService(fakeUsers([user]), fakeSessions());

    const outcome = await service.login('alice', 'correct-horse-battery', {});

    expect(outcome.status).toBe('totp_required');
    if (outcome.status === 'totp_required') {
      expect(outcome.challengeToken).toBeTruthy();
    }
  });
});

describe('AuthService.completeTotpLogin', () => {
  it('completes login with a valid code for the pending challenge', async () => {
    const secret = generateTotpSecret();
    const user = await makeUser({ totp_secret: secret, totp_enabled: 1 });
    const service = new AuthService(fakeUsers([user]), fakeSessions());

    const outcome = await service.login('alice', 'correct-horse-battery', {});
    if (outcome.status !== 'totp_required') throw new Error('expected totp_required');

    const code = await generate({ secret });
    const result = await service.completeTotpLogin(outcome.challengeToken, code);

    expect(result.user.username).toBe('alice');
    expect(result.sessionToken).toBeTruthy();
  });

  it('rejects an invalid code and does not complete the login', async () => {
    const secret = generateTotpSecret();
    const user = await makeUser({ totp_secret: secret, totp_enabled: 1 });
    const service = new AuthService(fakeUsers([user]), fakeSessions());

    const outcome = await service.login('alice', 'correct-horse-battery', {});
    if (outcome.status !== 'totp_required') throw new Error('expected totp_required');

    await expect(service.completeTotpLogin(outcome.challengeToken, '000000')).rejects.toThrow(
      /Invalid verification code/,
    );
  });

  it('rejects an unknown or already-used challenge token', async () => {
    const service = new AuthService(fakeUsers([]), fakeSessions());
    await expect(service.completeTotpLogin('not-a-real-token', '123456')).rejects.toThrow(
      /expired/,
    );
  });
});

describe('AuthService 2FA setup', () => {
  it('begins setup, stores an unconfirmed secret, then confirms and enables it', async () => {
    const user = await makeUser();
    const users = fakeUsers([user]);
    const service = new AuthService(users, fakeSessions());

    const setup = await service.beginTotpSetup(user.id);
    expect(setup.secret).toBeTruthy();
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\//);
    expect(setup.qrCodeDataUrl).toMatch(/^data:image\/png/);

    // Not enabled yet until confirmed.
    const midway = await users.findById(user.id);
    expect(midway?.totp_enabled).toBe(0);
    expect(midway?.totp_secret).toBe(setup.secret);

    const code = await generate({ secret: setup.secret });
    await service.confirmTotpSetup(user.id, code);

    const after = await users.findById(user.id);
    expect(after?.totp_enabled).toBe(1);
  });

  it('rejects confirmation with the wrong code and leaves 2FA disabled', async () => {
    const user = await makeUser();
    const users = fakeUsers([user]);
    const service = new AuthService(users, fakeSessions());

    await service.beginTotpSetup(user.id);
    await expect(service.confirmTotpSetup(user.id, '000000')).rejects.toThrow(
      /Invalid verification code/,
    );

    const after = await users.findById(user.id);
    expect(after?.totp_enabled).toBe(0);
  });

  it('disables 2FA and clears the stored secret', async () => {
    const secret = generateTotpSecret();
    const user = await makeUser({ totp_secret: secret, totp_enabled: 1 });
    const users = fakeUsers([user]);
    const service = new AuthService(users, fakeSessions());

    await service.disableTotp(user.id);

    const after = await users.findById(user.id);
    expect(after?.totp_enabled).toBe(0);
    expect(after?.totp_secret).toBeNull();
  });
});
