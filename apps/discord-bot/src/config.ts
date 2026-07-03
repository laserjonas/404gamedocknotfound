import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { z } from 'zod';
import dotenv from 'dotenv';

/**
 * Find the nearest .env walking up from cwd - same helper as apps/api's
 * config.ts, so running via `pnpm --filter @gamedock/discord-bot dev` from
 * a repo checkout picks up a repo-root .env, while a production systemd
 * unit with WorkingDirectory=/opt/gamedock/apps/discord-bot picks up its
 * own dedicated .env (checked first, since it's closer to cwd).
 */
function findEnvFile(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const envFile = findEnvFile();
if (envFile) {
  dotenv.config({ path: envFile });
}
const configBaseDir = envFile ? dirname(envFile) : process.cwd();

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, 'DISCORD_BOT_TOKEN is required (Discord Developer Portal)'),
  DISCORD_GUILD_ID: z
    .string()
    .min(1, 'DISCORD_GUILD_ID is required (the Discord server to operate in)'),
  GAMEDOCK_API_URL: z
    .string()
    .url('GAMEDOCK_API_URL must be a full URL, e.g. https://gamedock.example.com'),
  GAMEDOCK_API_TOKEN: z
    .string()
    .min(1, 'GAMEDOCK_API_TOKEN is required (an admin-level GameDock API token)'),
  GAMEDOCK_BOT_DATA_DIR: z.string().default('./data'),
  RECONCILE_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  UPDATE_CHECK_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
});

export interface BotConfig {
  discordBotToken: string;
  discordGuildId: string;
  gamedockApiUrl: string;
  gamedockApiToken: string;
  dataDir: string;
  reconcileIntervalMs: number;
  updateCheckIntervalMs: number;
}

/**
 * All of these are required for the bot to do its one job - unlike
 * GameDock's own optional integrations (e.g. self-update's repo URL),
 * there's no meaningful degraded mode, so this throws (not a "not
 * configured" flag) exactly like GAMEDOCK_SESSION_SECRET's production
 * check in apps/api/src/config.ts.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => i.message).join('; ');
    throw new Error(
      `Invalid discord-bot configuration: ${detail}. See docs/DISCORD_BOT.md for setup.`,
    );
  }
  const e = parsed.data;
  return {
    discordBotToken: e.DISCORD_BOT_TOKEN,
    discordGuildId: e.DISCORD_GUILD_ID,
    gamedockApiUrl: e.GAMEDOCK_API_URL.replace(/\/+$/, ''),
    gamedockApiToken: e.GAMEDOCK_API_TOKEN,
    dataDir: resolve(configBaseDir, e.GAMEDOCK_BOT_DATA_DIR),
    reconcileIntervalMs: e.RECONCILE_INTERVAL_MINUTES * 60 * 1000,
    updateCheckIntervalMs: e.UPDATE_CHECK_INTERVAL_MINUTES * 60 * 1000,
  };
}
