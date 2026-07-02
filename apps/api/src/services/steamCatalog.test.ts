import type * as NodeFsPromises from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameTemplate } from '@gamedock/game-templates';
import type { TemplateService } from './templates.js';
import type { Logger } from '../logger.js';

const readFileMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return { ...actual, readFile: readFileMock, writeFile: writeFileMock };
});

const { SteamCatalogService } = await import('./steamCatalog.js');

function fakeTemplates(templates: Partial<GameTemplate>[]): TemplateService {
  return { list: () => templates as GameTemplate[] } as unknown as TemplateService;
}

const fakeLogger = { warn: vi.fn() } as unknown as Logger;

afterEach(() => {
  vi.unstubAllGlobals();
  readFileMock.mockReset();
  writeFileMock.mockReset();
});

describe('SteamCatalogService.search', () => {
  it('fetches and filters the Steam app list, marking template-backed apps as installable', async () => {
    readFileMock.mockRejectedValue(new Error('ENOENT'));
    writeFileMock.mockResolvedValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          applist: {
            apps: [
              { appid: 896660, name: 'Valheim dedicated server' },
              { appid: 258550, name: 'Rust Dedicated Server' },
              { appid: 730, name: 'Counter-Strike 2' }, // no "dedicated server" in name, no template match -> excluded
              { appid: 999999, name: 'Some Random Game' }, // noise -> excluded
            ],
          },
        }),
      })),
    );

    const templates = fakeTemplates([{ id: 'valheim', steam: { appId: 896660, anonymous: true } }]);
    const service = new SteamCatalogService('/data', templates, fakeLogger);

    const result = await service.search('', 50, 0);

    expect(result.total).toBe(2);
    expect(result.items.map((i) => i.appId).sort()).toEqual([258550, 896660]);
    const valheim = result.items.find((i) => i.appId === 896660);
    expect(valheim?.templateId).toBe('valheim');
    const rust = result.items.find((i) => i.appId === 258550);
    expect(rust?.templateId).toBeNull();
    expect(writeFileMock).toHaveBeenCalledOnce();
  });

  it('reuses a fresh on-disk cache without hitting the network', async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        apps: [{ appid: 1, name: 'Foo Dedicated Server' }],
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const service = new SteamCatalogService('/data', fakeTemplates([]), fakeLogger);
    const result = await service.search('', 50, 0);

    expect(result.total).toBe(1);
    expect(result.stale).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to a stale cache when the network refresh fails', async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
        fetchedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        apps: [{ appid: 1, name: 'Old Dedicated Server' }],
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' })),
    );

    const service = new SteamCatalogService('/data', fakeTemplates([]), fakeLogger);
    const result = await service.search('', 50, 0);

    expect(result.total).toBe(1);
    expect(result.stale).toBe(true);
  });

  it('returns an empty result when there is no cache and the network fetch fails', async () => {
    readFileMock.mockRejectedValue(new Error('ENOENT'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' })),
    );

    const service = new SteamCatalogService('/data', fakeTemplates([]), fakeLogger);
    const result = await service.search('', 50, 0);

    expect(result).toEqual({ total: 0, items: [], cachedAt: null, stale: false });
  });

  it('filters by search query against cached entries', async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        apps: [
          { appid: 1, name: 'Valheim Dedicated Server' },
          { appid: 2, name: 'Rust Dedicated Server' },
        ],
      }),
    );
    vi.stubGlobal('fetch', vi.fn());

    const service = new SteamCatalogService('/data', fakeTemplates([]), fakeLogger);
    const result = await service.search('rust', 50, 0);

    expect(result.total).toBe(1);
    expect(result.items[0].name).toBe('Rust Dedicated Server');
  });
});
