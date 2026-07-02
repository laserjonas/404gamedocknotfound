import { join } from 'node:path';
import type * as NodeFs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, existsSync: existsSyncMock };
});

const { ensureJavaRuntime } = await import('./javaRuntime.js');

const originalPlatform = process.platform;

function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return fn().finally(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  existsSyncMock.mockReset();
});

describe('ensureJavaRuntime', () => {
  it('returns the cached java path without any network calls when already provisioned', async () => {
    existsSyncMock.mockReturnValue(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const javaBin = await withPlatform('linux', () =>
      ensureJavaRuntime({
        runtimeDir: '/var/lib/gamedock/runtimes',
        majorVersion: 21,
        onLog: () => {},
      }),
    );

    expect(javaBin).toBe(join('/var/lib/gamedock/runtimes', 'jdk-21', 'bin', 'java'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when Adoptium has no build for the requested major version', async () => {
    existsSyncMock.mockReturnValue(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => [] })),
    );

    await expect(
      withPlatform('linux', () =>
        ensureJavaRuntime({
          runtimeDir: '/var/lib/gamedock/runtimes',
          majorVersion: 999,
          onLog: () => {},
        }),
      ),
    ).rejects.toThrow(/No Eclipse Temurin build found/);
  });

  it('rejects when the Adoptium API request fails', async () => {
    existsSyncMock.mockReturnValue(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' })),
    );

    await expect(
      withPlatform('linux', () =>
        ensureJavaRuntime({
          runtimeDir: '/var/lib/gamedock/runtimes',
          majorVersion: 21,
          onLog: () => {},
        }),
      ),
    ).rejects.toThrow(/Failed to look up a Java 21 build/);
  });

  it('refuses to auto-provision on non-Linux platforms', async () => {
    existsSyncMock.mockReturnValue(false);
    await expect(
      withPlatform('win32', () =>
        ensureJavaRuntime({
          runtimeDir: 'C:/gamedock/runtimes',
          majorVersion: 21,
          onLog: () => {},
        }),
      ),
    ).rejects.toThrow(/only implemented for Linux/);
  });
});
