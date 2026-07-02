import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SteamCatalogEntryDto, SteamCatalogResponseDto } from '@gamedock/shared';
import type { TemplateService } from './templates.js';
import type { Logger } from '../logger.js';

/**
 * Browsable catalog of Steam dedicated server tools that can be installed via
 * an anonymous SteamCMD login (no Steam account/purchase required) - the only
 * kind GameDock supports (see CLAUDE.md: never store Steam credentials).
 *
 * Valve publishes most dedicated servers as separate free "tool" apps named
 * "<Game> Dedicated Server", which is what the STEAM_APP_LIST heuristic below
 * matches. That naming convention isn't universal, so entries already covered
 * by a GameDock game template are always included too, even if their name
 * doesn't match - the template is the actual proof anonymous install works.
 *
 * The full Steam app list (~250k entries) is fetched from Valve's public,
 * keyless API and cached on disk (filtered down to matches only, so the
 * on-disk/in-memory footprint stays small) since re-fetching it is slow and
 * mostly pointless more than once a day.
 */

const APP_LIST_URL = 'https://api.steampowered.com/ISteamApps/GetAppList/v2/';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEDICATED_SERVER_PATTERN = /dedicated\s*server/i;

interface SteamAppListResponse {
  applist: { apps: { appid: number; name: string }[] };
}

interface CacheFile {
  fetchedAt: string;
  apps: { appid: number; name: string }[];
}

export class SteamCatalogService {
  private cache: CacheFile | null = null;
  private readonly cacheFilePath: string;
  private refreshing: Promise<void> | null = null;

  constructor(
    dataDir: string,
    private templates: TemplateService,
    private logger: Logger,
  ) {
    this.cacheFilePath = join(dataDir, 'steam-app-list-cache.json');
  }

  private async loadCacheFromDisk(): Promise<CacheFile | null> {
    try {
      return JSON.parse(await readFile(this.cacheFilePath, 'utf8')) as CacheFile;
    } catch {
      return null;
    }
  }

  private async fetchAppList(): Promise<CacheFile> {
    const res = await fetch(APP_LIST_URL);
    if (!res.ok) {
      throw new Error(`Steam app list request failed: HTTP ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as SteamAppListResponse;
    const templateAppIds = new Set(
      this.templates
        .list()
        .map((t) => t.steam?.appId)
        .filter((id): id is number => typeof id === 'number'),
    );
    const apps = body.applist.apps.filter(
      (app) => DEDICATED_SERVER_PATTERN.test(app.name) || templateAppIds.has(app.appid),
    );
    return { fetchedAt: new Date().toISOString(), apps };
  }

  /** Ensures a fresh-enough cache is loaded (memory, then disk, then network), without blocking on network more than once concurrently. */
  private async ensureFresh(): Promise<{ cache: CacheFile | null; stale: boolean }> {
    if (!this.cache) {
      this.cache = await this.loadCacheFromDisk();
    }
    const isFresh = this.cache && Date.now() - Date.parse(this.cache.fetchedAt) < CACHE_TTL_MS;
    if (isFresh) {
      return { cache: this.cache, stale: false };
    }

    if (!this.refreshing) {
      this.refreshing = this.fetchAppList()
        .then(async (fresh) => {
          this.cache = fresh;
          await writeFile(this.cacheFilePath, JSON.stringify(fresh), 'utf8');
        })
        .catch((err) => {
          this.logger.warn({ err: (err as Error).message }, 'steam app list refresh failed');
          throw err;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }

    try {
      await this.refreshing;
      return { cache: this.cache, stale: false };
    } catch {
      // Refresh failed - fall back to whatever we had (possibly stale, possibly nothing).
      return { cache: this.cache, stale: this.cache !== null };
    }
  }

  private toDto(app: { appid: number; name: string }): SteamCatalogEntryDto {
    const match = this.templates.list().find((t) => t.steam?.appId === app.appid);
    return {
      appId: app.appid,
      name: app.name,
      templateId: match?.id ?? null,
      headerImageUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${app.appid}/header.jpg`,
      storeUrl: `https://store.steampowered.com/app/${app.appid}/`,
    };
  }

  async search(query: string, limit: number, offset: number): Promise<SteamCatalogResponseDto> {
    const { cache, stale } = await this.ensureFresh();
    if (!cache) {
      return { total: 0, items: [], cachedAt: null, stale: false };
    }

    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? cache.apps.filter((app) => app.name.toLowerCase().includes(needle))
      : cache.apps;

    // Entries already backed by a GameDock template first, then alphabetical.
    const templateAppIds = new Set(
      this.templates
        .list()
        .map((t) => t.steam?.appId)
        .filter((id): id is number => typeof id === 'number'),
    );
    const sorted = [...filtered].sort((a, b) => {
      const aSupported = templateAppIds.has(a.appid) ? 0 : 1;
      const bSupported = templateAppIds.has(b.appid) ? 0 : 1;
      if (aSupported !== bSupported) return aSupported - bSupported;
      return a.name.localeCompare(b.name);
    });

    return {
      total: sorted.length,
      items: sorted.slice(offset, offset + limit).map((app) => this.toDto(app)),
      cachedAt: cache.fetchedAt,
      stale,
    };
  }
}
