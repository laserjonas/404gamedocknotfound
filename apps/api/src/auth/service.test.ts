import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generate } from 'otplib';
import { AuthService } from './service.js';
import { hashPassword } from './passwords.js';
import { generateTotpSecret } from './totp.js';
import type { UserRepository, UserRow } from '../db/repositories/users.js';
import type { SessionRepository, SessionRow } from '../db/repositories/sessions.js';
import type {
  WebauthnCredentialRepository,
  WebauthnCredentialRow,
} from '../db/repositories/webauthnCredentials.js';
import type { ApiTokenRepository, ApiTokenRow } from '../db/repositories/apiTokens.js';

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
      if ('totpRecoveryCodes' in patch) {
        const codes = patch.totpRecoveryCodes as string[] | null;
        row.totp_recovery_codes = codes ? JSON.stringify(codes) : null;
      }
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

function fakeWebauthnCredentials(
  initial: WebauthnCredentialRow[] = [],
): WebauthnCredentialRepository {
  const rows = new Map(initial.map((r) => [r.id, r]));
  return {
    create: async (params: {
      userId: string;
      credentialId: string;
      publicKey: string;
      counter: number;
      transports: string | null;
      deviceType: 'singleDevice' | 'multiDevice';
      backedUp: boolean;
      nickname: string;
    }) => {
      const row: WebauthnCredentialRow = {
        id: randomUUID(),
        user_id: params.userId,
        credential_id: params.credentialId,
        public_key: params.publicKey,
        counter: params.counter,
        transports: params.transports,
        device_type: params.deviceType,
        backed_up: params.backedUp ? 1 : 0,
        nickname: params.nickname,
        created_at: new Date().toISOString(),
        last_used_at: null,
      };
      rows.set(row.id, row);
      return row;
    },
    listForUser: async (userId: string) => [...rows.values()].filter((r) => r.user_id === userId),
    findByCredentialId: async (credentialId: string) =>
      [...rows.values()].find((r) => r.credential_id === credentialId),
    countForUser: async (userId: string) =>
      [...rows.values()].filter((r) => r.user_id === userId).length,
    updateCounter: async (id: string, counter: number) => {
      const row = rows.get(id);
      if (row) {
        row.counter = counter;
        row.last_used_at = new Date().toISOString();
      }
    },
    deleteForUser: async (userId: string, id: string) => {
      const row = rows.get(id);
      if (!row || row.user_id !== userId) return { changes: 0 };
      rows.delete(id);
      return { changes: 1 };
    },
    deleteAllForUser: async (userId: string) => {
      for (const [id, row] of rows) if (row.user_id === userId) rows.delete(id);
    },
  } as unknown as WebauthnCredentialRepository;
}

function fakeApiTokens(initial: ApiTokenRow[] = []): ApiTokenRepository {
  const rows = new Map(initial.map((r) => [r.id, r]));
  return {
    create: async (params: {
      userId: string;
      name: string;
      tokenHash: string;
      expiresAt: string | null;
    }) => {
      const row: ApiTokenRow = {
        id: randomUUID(),
        user_id: params.userId,
        name: params.name,
        token_hash: params.tokenHash,
        created_at: new Date().toISOString(),
        last_used_at: null,
        expires_at: params.expiresAt,
      };
      rows.set(row.id, row);
      return row;
    },
    listForUser: async (userId: string) => [...rows.values()].filter((r) => r.user_id === userId),
    findByTokenHash: async (tokenHash: string) =>
      [...rows.values()].find((r) => r.token_hash === tokenHash),
    updateLastUsed: async (id: string) => {
      const row = rows.get(id);
      if (row) row.last_used_at = new Date().toISOString();
    },
    deleteForUser: async (userId: string, id: string) => {
      const row = rows.get(id);
      if (!row || row.user_id !== userId) return { changes: 0 };
      rows.delete(id);
      return { changes: 1 };
    },
    deleteAllForUser: async (userId: string) => {
      for (const [id, row] of rows) if (row.user_id === userId) rows.delete(id);
    },
  } as unknown as ApiTokenRepository;
}

/** Matches the real constructor's 5 collaborators; passkey ceremony tests below only exercise the guard clauses that don't need a real signed WebAuthn response. */
function makeService(
  users: UserRepository,
  sessions: SessionRepository,
  webauthnCredentials: WebauthnCredentialRepository = fakeWebauthnCredentials(),
  apiTokens: ApiTokenRepository = fakeApiTokens(),
): AuthService {
  return new AuthService(users, sessions, webauthnCredentials, apiTokens, {
    rpId: 'localhost',
    origin: 'http://localhost:5173',
  });
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
    totp_recovery_codes: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuthService.login', () => {
  it('completes in one step for an account without 2FA', async () => {
    const user = await makeUser();
    const service = makeService(fakeUsers([user]), fakeSessions());

    const outcome = await service.login('alice', 'correct-horse-battery', {});

    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.result.user.username).toBe('alice');
      expect(outcome.result.sessionToken).toBeTruthy();
    }
  });

  it('rejects a wrong password without revealing which part was wrong', async () => {
    const user = await makeUser();
    const service = makeService(fakeUsers([user]), fakeSessions());

    await expect(service.login('alice', 'wrong-password', {})).rejects.toThrow(
      /Invalid username or password/,
    );
  });

  it('returns a totp_required challenge (no session yet) for a 2FA-enabled account', async () => {
    const secret = generateTotpSecret();
    const user = await makeUser({ totp_secret: secret, totp_enabled: 1 });
    const service = makeService(fakeUsers([user]), fakeSessions());

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
    const service = makeService(fakeUsers([user]), fakeSessions());

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
    const service = makeService(fakeUsers([user]), fakeSessions());

    const outcome = await service.login('alice', 'correct-horse-battery', {});
    if (outcome.status !== 'totp_required') throw new Error('expected totp_required');

    await expect(service.completeTotpLogin(outcome.challengeToken, '000000')).rejects.toThrow(
      /Invalid verification code/,
    );
  });

  it('rejects an unknown or already-used challenge token', async () => {
    const service = makeService(fakeUsers([]), fakeSessions());
    await expect(service.completeTotpLogin('not-a-real-token', '123456')).rejects.toThrow(
      /expired/,
    );
  });
});

describe('AuthService 2FA setup', () => {
  it('begins setup, stores an unconfirmed secret, then confirms and enables it', async () => {
    const user = await makeUser();
    const users = fakeUsers([user]);
    const service = makeService(users, fakeSessions());

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
    const service = makeService(users, fakeSessions());

    await service.beginTotpSetup(user.id);
    await expect(service.confirmTotpSetup(user.id, '000000')).rejects.toThrow(
      /Invalid verification code/,
    );

    const after = await users.findById(user.id);
    expect(after?.totp_enabled).toBe(0);
  });

  it('disables 2FA and clears the stored secret and recovery codes', async () => {
    const secret = generateTotpSecret();
    const user = await makeUser({
      totp_secret: secret,
      totp_enabled: 1,
      totp_recovery_codes: JSON.stringify(['deadbeef']),
    });
    const users = fakeUsers([user]);
    const service = makeService(users, fakeSessions());

    await service.disableTotp(user.id);

    const after = await users.findById(user.id);
    expect(after?.totp_enabled).toBe(0);
    expect(after?.totp_secret).toBeNull();
    expect(after?.totp_recovery_codes).toBeNull();
  });
});

describe('AuthService recovery codes', () => {
  it('issues 10 uniquely-formatted codes on setup confirmation', async () => {
    const user = await makeUser();
    const users = fakeUsers([user]);
    const service = makeService(users, fakeSessions());

    const setup = await service.beginTotpSetup(user.id);
    const code = await generate({ secret: setup.secret });
    const recoveryCodes = await service.confirmTotpSetup(user.id, code);

    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const rc of recoveryCodes) {
      expect(rc).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    }
  });

  it('rejects regenerating codes when 2FA is not enabled', async () => {
    const user = await makeUser();
    const service = makeService(fakeUsers([user]), fakeSessions());

    await expect(service.regenerateRecoveryCodes(user.id)).rejects.toThrow(/Enable 2FA/);
  });

  it('logs in with a recovery code, then rejects that same code on reuse', async () => {
    const user = await makeUser();
    const users = fakeUsers([user]);
    const service = makeService(users, fakeSessions());

    const setup = await service.beginTotpSetup(user.id);
    const setupCode = await generate({ secret: setup.secret });
    const recoveryCodes = await service.confirmTotpSetup(user.id, setupCode);
    const [firstCode] = recoveryCodes;

    const outcome1 = await service.login('alice', 'correct-horse-battery', {});
    if (outcome1.status !== 'totp_required') throw new Error('expected a totp_required challenge');
    const result = await service.completeTotpLogin(outcome1.challengeToken, firstCode);
    expect(result.user.username).toBe('alice');
    // Regression: the returned user DTO must reflect the code just consumed,
    // not the pre-consumption count from before this login.
    expect(result.user.totpRecoveryCodesRemaining).toBe(recoveryCodes.length - 1);

    const outcome2 = await service.login('alice', 'correct-horse-battery', {});
    if (outcome2.status !== 'totp_required') throw new Error('expected a totp_required challenge');
    await expect(service.completeTotpLogin(outcome2.challengeToken, firstCode)).rejects.toThrow(
      /Invalid or already-used recovery code/,
    );
  });

  it('regenerating codes invalidates the previous batch', async () => {
    const user = await makeUser();
    const users = fakeUsers([user]);
    const service = makeService(users, fakeSessions());

    const setup = await service.beginTotpSetup(user.id);
    const setupCode = await generate({ secret: setup.secret });
    const firstBatch = await service.confirmTotpSetup(user.id, setupCode);
    await service.regenerateRecoveryCodes(user.id);

    const outcome = await service.login('alice', 'correct-horse-battery', {});
    if (outcome.status !== 'totp_required') throw new Error('expected a totp_required challenge');
    await expect(service.completeTotpLogin(outcome.challengeToken, firstBatch[0])).rejects.toThrow(
      /Invalid or already-used recovery code/,
    );
  });
});

describe('AuthService API tokens', () => {
  it('creates a token and validates it back to the owning user', async () => {
    const user = await makeUser();
    const service = makeService(fakeUsers([user]), fakeSessions());

    const { token, dto } = await service.createApiToken(user.id, 'CI script', null);
    expect(token).toMatch(/^gd_/);
    expect(dto.name).toBe('CI script');
    expect(dto.expiresAt).toBeNull();

    const session = await service.validateApiToken(token);
    expect(session?.user.id).toBe(user.id);
    expect(session?.session).toBeNull();
  });

  it('rejects a garbage or unknown token', async () => {
    const user = await makeUser();
    const service = makeService(fakeUsers([user]), fakeSessions());
    await service.createApiToken(user.id, 'CI script', null);

    expect(await service.validateApiToken('not-a-real-token')).toBeNull();
    expect(await service.validateApiToken('gd_wrongvalueentirely')).toBeNull();
  });

  it('rejects an expired token', async () => {
    const user = await makeUser();
    const service = makeService(fakeUsers([user]), fakeSessions());

    const { token } = await service.createApiToken(user.id, 'Short-lived', -1);
    expect(await service.validateApiToken(token)).toBeNull();
  });

  it('cannot revoke another user’s token by id', async () => {
    const alice = await makeUser({ username: 'alice' });
    const bob = await makeUser({ username: 'bob' });
    const service = makeService(fakeUsers([alice, bob]), fakeSessions());

    const { dto } = await service.createApiToken(alice.id, 'Alice token', null);
    await expect(service.removeApiToken(bob.id, dto.id)).rejects.toThrow(/not found/i);
  });

  it('revokes its own token, and it stops validating afterward', async () => {
    const user = await makeUser();
    const service = makeService(fakeUsers([user]), fakeSessions());

    const { token, dto } = await service.createApiToken(user.id, 'CI script', null);
    await service.removeApiToken(user.id, dto.id);
    expect(await service.validateApiToken(token)).toBeNull();
  });
});

describe('AuthService passkeys - registration', () => {
  it('begins registration and returns usable, discoverable-credential options', async () => {
    const user = await makeUser();
    const service = makeService(fakeUsers([user]), fakeSessions());

    const options = await service.beginPasskeyRegistration(user.id);

    expect(options.challenge).toBeTruthy();
    expect(options.rp.id).toBe('localhost');
    expect(options.user.name).toBe('alice');
    expect(options.authenticatorSelection?.residentKey).toBe('required');
  });

  it('a second beginPasskeyRegistration call replaces the first pending challenge (one at a time, like beginTotpSetup)', async () => {
    const user = await makeUser();
    const service = makeService(fakeUsers([user]), fakeSessions());

    const first = await service.beginPasskeyRegistration(user.id);
    const second = await service.beginPasskeyRegistration(user.id);
    expect(second.challenge).not.toBe(first.challenge);
  });

  it('rejects finishing registration when there is no pending challenge at all', async () => {
    const user = await makeUser();
    const service = makeService(fakeUsers([user]), fakeSessions());

    await expect(
      service.finishPasskeyRegistration(user.id, { id: 'whatever' } as never, 'My device'),
    ).rejects.toThrow(/expired/i);
  });

  it('excludes already-registered credentials from a fresh registration attempt', async () => {
    const user = await makeUser();
    const credentials = fakeWebauthnCredentials([
      {
        id: randomUUID(),
        user_id: user.id,
        credential_id: 'existing-cred-id',
        public_key: 'unused',
        counter: 0,
        transports: null,
        device_type: 'singleDevice',
        backed_up: 0,
        nickname: 'Existing key',
        created_at: new Date().toISOString(),
        last_used_at: null,
      },
    ]);
    const service = makeService(fakeUsers([user]), fakeSessions(), credentials);

    const options = await service.beginPasskeyRegistration(user.id);
    expect(options.excludeCredentials?.map((c) => c.id)).toContain('existing-cred-id');
  });
});

describe('AuthService passkeys - login', () => {
  it('rejects a login attempt for a credential id that was never registered', async () => {
    const service = makeService(fakeUsers([]), fakeSessions());
    await expect(
      service.completePasskeyLogin(
        { id: 'unknown-credential', response: { userHandle: undefined } } as never,
        {},
      ),
    ).rejects.toThrow(/not recognized/i);
  });

  it('beginPasskeyLogin returns usernameless options (no allowCredentials)', async () => {
    const service = makeService(fakeUsers([]), fakeSessions());
    const options = await service.beginPasskeyLogin();
    expect(options.challenge).toBeTruthy();
    expect(options.allowCredentials ?? []).toHaveLength(0);
  });
});

describe('AuthService passkeys - management', () => {
  it('lists only the calling user’s own passkeys', async () => {
    const alice = await makeUser({ username: 'alice' });
    const bob = await makeUser({ username: 'bob' });
    const credentials = fakeWebauthnCredentials([
      {
        id: randomUUID(),
        user_id: alice.id,
        credential_id: 'alice-cred',
        public_key: 'x',
        counter: 0,
        transports: null,
        device_type: 'singleDevice',
        backed_up: 0,
        nickname: "Alice's phone",
        created_at: new Date().toISOString(),
        last_used_at: null,
      },
      {
        id: randomUUID(),
        user_id: bob.id,
        credential_id: 'bob-cred',
        public_key: 'x',
        counter: 0,
        transports: null,
        device_type: 'singleDevice',
        backed_up: 0,
        nickname: "Bob's key",
        created_at: new Date().toISOString(),
        last_used_at: null,
      },
    ]);
    const service = makeService(fakeUsers([alice, bob]), fakeSessions(), credentials);

    const alicePasskeys = await service.listPasskeys(alice.id);
    expect(alicePasskeys).toHaveLength(1);
    expect(alicePasskeys[0]?.nickname).toBe("Alice's phone");
  });

  it('removePasskey cannot delete another user’s credential by id', async () => {
    const alice = await makeUser({ username: 'alice' });
    const bob = await makeUser({ username: 'bob' });
    const bobCredId = randomUUID();
    const credentials = fakeWebauthnCredentials([
      {
        id: bobCredId,
        user_id: bob.id,
        credential_id: 'bob-cred',
        public_key: 'x',
        counter: 0,
        transports: null,
        device_type: 'singleDevice',
        backed_up: 0,
        nickname: "Bob's key",
        created_at: new Date().toISOString(),
        last_used_at: null,
      },
    ]);
    const service = makeService(fakeUsers([alice, bob]), fakeSessions(), credentials);

    await expect(service.removePasskey(alice.id, bobCredId)).rejects.toThrow(/not found/i);
    expect(await service.listPasskeys(bob.id)).toHaveLength(1);
  });

  it('removeAllPasskeysForUser clears every credential for that user (admin recovery)', async () => {
    const alice = await makeUser({ username: 'alice' });
    const credentials = fakeWebauthnCredentials([
      {
        id: randomUUID(),
        user_id: alice.id,
        credential_id: 'a',
        public_key: 'x',
        counter: 0,
        transports: null,
        device_type: 'singleDevice',
        backed_up: 0,
        nickname: 'One',
        created_at: new Date().toISOString(),
        last_used_at: null,
      },
      {
        id: randomUUID(),
        user_id: alice.id,
        credential_id: 'b',
        public_key: 'x',
        counter: 0,
        transports: null,
        device_type: 'singleDevice',
        backed_up: 0,
        nickname: 'Two',
        created_at: new Date().toISOString(),
        last_used_at: null,
      },
    ]);
    const service = makeService(fakeUsers([alice]), fakeSessions(), credentials);

    expect(await service.listPasskeys(alice.id)).toHaveLength(2);
    await service.removeAllPasskeysForUser(alice.id);
    expect(await service.listPasskeys(alice.id)).toHaveLength(0);
  });
});
