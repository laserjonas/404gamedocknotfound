import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

/** A minimal, self-contained env object - loadConfig ignores the real process.env/.env file when given one. */
function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    GAMEDOCK_DATA_DIR: mkdtempSync(join(tmpdir(), 'gamedock-config-test-')),
    GAMEDOCK_SESSION_SECRET: 'a'.repeat(32),
    ...overrides,
  };
}

describe('loadConfig - GAMEDOCK_PUBLIC_ORIGIN / passkey RP config', () => {
  it('falls back to the Vite dev server origin/localhost when unset in development', () => {
    const config = loadConfig(baseEnv({ GAMEDOCK_NODE_ENV: 'development' }));
    expect(config.publicOrigin).toBe('http://localhost:5173');
    expect(config.rpId).toBe('localhost');
  });

  it('requires GAMEDOCK_PUBLIC_ORIGIN in production', () => {
    expect(() => loadConfig(baseEnv({ GAMEDOCK_NODE_ENV: 'production' }))).toThrow(
      /GAMEDOCK_PUBLIC_ORIGIN must be set in production/,
    );
  });

  it('parses a configured origin into publicOrigin (full origin) and rpId (hostname only)', () => {
    const config = loadConfig(
      baseEnv({
        GAMEDOCK_NODE_ENV: 'production',
        GAMEDOCK_PUBLIC_ORIGIN: 'https://gamedock.example.com',
      }),
    );
    expect(config.publicOrigin).toBe('https://gamedock.example.com');
    expect(config.rpId).toBe('gamedock.example.com');
  });

  it('strips a non-default port from the origin but keeps the bare hostname as rpId', () => {
    const config = loadConfig(
      baseEnv({
        GAMEDOCK_NODE_ENV: 'production',
        GAMEDOCK_PUBLIC_ORIGIN: 'https://gamedock.example.com:8443',
      }),
    );
    expect(config.publicOrigin).toBe('https://gamedock.example.com:8443');
    expect(config.rpId).toBe('gamedock.example.com');
  });

  it('rejects a malformed GAMEDOCK_PUBLIC_ORIGIN with a clear error', () => {
    expect(() => loadConfig(baseEnv({ GAMEDOCK_PUBLIC_ORIGIN: 'not-a-valid-url' }))).toThrow(
      /must be a valid absolute URL/,
    );
  });
});
