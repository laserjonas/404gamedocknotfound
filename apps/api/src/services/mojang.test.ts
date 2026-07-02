import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveMinecraftServerJarUrl } from './mojang.js';

const MANIFEST = {
  latest: { release: '1.21.4', snapshot: '24w46a' },
  versions: [
    { id: '24w46a', url: 'https://example.test/24w46a.json' },
    { id: '1.21.4', url: 'https://example.test/1.21.4.json' },
    { id: '1.2.4', url: 'https://example.test/1.2.4.json' },
  ],
};

function stubFetch(versionMetaByUrl: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('version_manifest_v2.json')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => MANIFEST } as Response;
      }
      const body = versionMetaByUrl[url];
      if (body === undefined) {
        return { ok: false, status: 404, statusText: 'Not Found' } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveMinecraftServerJarUrl', () => {
  it('resolves "latest-release" to the manifest\'s current release', async () => {
    stubFetch({
      'https://example.test/1.21.4.json': {
        downloads: { server: { url: 'https://dl/server.jar' } },
        javaVersion: { majorVersion: 21 },
      },
    });
    const result = await resolveMinecraftServerJarUrl('latest-release');
    expect(result).toEqual({
      version: '1.21.4',
      url: 'https://dl/server.jar',
      javaMajorVersion: 21,
    });
  });

  it('resolves "latest-snapshot" to the manifest\'s current snapshot', async () => {
    stubFetch({
      'https://example.test/24w46a.json': {
        downloads: { server: { url: 'https://dl/snapshot.jar' } },
        javaVersion: { majorVersion: 25 },
      },
    });
    const result = await resolveMinecraftServerJarUrl('latest-snapshot');
    expect(result).toEqual({
      version: '24w46a',
      url: 'https://dl/snapshot.jar',
      javaMajorVersion: 25,
    });
  });

  it('falls back to Java 8 when a version predates the javaVersion field', async () => {
    stubFetch({
      'https://example.test/1.21.4.json': {
        downloads: { server: { url: 'https://dl/server.jar' } },
      },
    });
    const result = await resolveMinecraftServerJarUrl('1.21.4');
    expect(result.javaMajorVersion).toBe(8);
  });

  it('treats an empty selector as "latest-release"', async () => {
    stubFetch({
      'https://example.test/1.21.4.json': {
        downloads: { server: { url: 'https://dl/server.jar' } },
      },
    });
    const result = await resolveMinecraftServerJarUrl('');
    expect(result.version).toBe('1.21.4');
  });

  it('resolves an exact version id', async () => {
    stubFetch({
      'https://example.test/1.21.4.json': {
        downloads: { server: { url: 'https://dl/server.jar' } },
        javaVersion: { majorVersion: 21 },
      },
    });
    const result = await resolveMinecraftServerJarUrl('1.21.4');
    expect(result).toEqual({
      version: '1.21.4',
      url: 'https://dl/server.jar',
      javaMajorVersion: 21,
    });
  });

  it('rejects an unknown version id', async () => {
    stubFetch({});
    await expect(resolveMinecraftServerJarUrl('99.99.99')).rejects.toThrow(
      /Unknown Minecraft version/,
    );
  });

  it('rejects a version with no server download (too old)', async () => {
    stubFetch({ 'https://example.test/1.2.4.json': { downloads: {} } });
    await expect(resolveMinecraftServerJarUrl('1.2.4')).rejects.toThrow(
      /does not provide a server download/,
    );
  });
});
