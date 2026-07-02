import { existsSync, mkdirSync } from 'node:fs';
import { resolve, isAbsolute, join, dirname } from 'node:path';
import { z } from 'zod';
import dotenv from 'dotenv';

/**
 * Find the nearest .env walking up from cwd. This keeps the CLI working when
 * pnpm runs it with apps/api as the working directory: the repo-root .env is
 * still found and relative paths in it resolve against the repo root.
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
/** Base directory for resolving relative paths from configuration. */
const configBaseDir = envFile ? dirname(envFile) : process.cwd();

const envSchema = z.object({
  GAMEDOCK_HOST: z.string().default('127.0.0.1'),
  GAMEDOCK_PORT: z.coerce.number().int().min(1).max(65535).default(8340),
  GAMEDOCK_DATA_DIR: z.string().default('./data'),
  GAMEDOCK_INSTANCE_DIR: z.string().optional(),
  GAMEDOCK_BACKUP_DIR: z.string().optional(),
  GAMEDOCK_DATABASE_URL: z.string().default('sqlite:gamedock.sqlite'),
  GAMEDOCK_SESSION_SECRET: z.string().default('dev-only-insecure-secret'),
  GAMEDOCK_STEAMCMD_PATH: z.string().default('steamcmd'),
  GAMEDOCK_NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  GAMEDOCK_MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(10240).default(512),
  GAMEDOCK_SECURE_COOKIES: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  GAMEDOCK_APP_DIR: z.string().optional(),
  GAMEDOCK_UPDATE_REPO_URL: z.string().default(''),
  GAMEDOCK_UPDATE_BRANCH: z.string().default('main'),
});

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  instanceDir: string;
  backupDir: string;
  logDir: string;
  runtimeDir: string;
  databaseUrl: string;
  sessionSecret: string;
  steamcmdPath: string;
  nodeEnv: 'development' | 'production' | 'test';
  isProduction: boolean;
  maxUploadBytes: number;
  secureCookies: boolean;
  appDir: string;
  updateRepoUrl: string;
  updateBranch: string;
}

const INSECURE_SECRETS = new Set(['dev-only-insecure-secret', 'change-me-to-a-long-random-string']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  const e = parsed.data;

  const dataDir = resolve(configBaseDir, e.GAMEDOCK_DATA_DIR);
  const instanceDir = e.GAMEDOCK_INSTANCE_DIR
    ? resolve(configBaseDir, e.GAMEDOCK_INSTANCE_DIR)
    : join(dataDir, 'instances');
  const backupDir = e.GAMEDOCK_BACKUP_DIR
    ? resolve(configBaseDir, e.GAMEDOCK_BACKUP_DIR)
    : join(dataDir, 'backups');
  const logDir = join(dataDir, 'logs');
  const runtimeDir = join(dataDir, 'runtimes');

  const isProduction = e.GAMEDOCK_NODE_ENV === 'production';
  if (isProduction) {
    if (INSECURE_SECRETS.has(e.GAMEDOCK_SESSION_SECRET) || e.GAMEDOCK_SESSION_SECRET.length < 32) {
      throw new Error(
        'GAMEDOCK_SESSION_SECRET must be a random string of at least 32 characters in production. ' +
          'Generate one with: openssl rand -hex 32',
      );
    }
  }

  for (const dir of [dataDir, instanceDir, backupDir, logDir, runtimeDir]) {
    mkdirSync(dir, { recursive: true });
  }

  return {
    host: e.GAMEDOCK_HOST,
    port: e.GAMEDOCK_PORT,
    dataDir,
    instanceDir,
    backupDir,
    logDir,
    runtimeDir,
    databaseUrl: e.GAMEDOCK_DATABASE_URL,
    sessionSecret: e.GAMEDOCK_SESSION_SECRET,
    steamcmdPath: e.GAMEDOCK_STEAMCMD_PATH,
    nodeEnv: e.GAMEDOCK_NODE_ENV,
    isProduction,
    maxUploadBytes: e.GAMEDOCK_MAX_UPLOAD_MB * 1024 * 1024,
    secureCookies: e.GAMEDOCK_SECURE_COOKIES || isProduction,
    appDir: e.GAMEDOCK_APP_DIR ? resolve(configBaseDir, e.GAMEDOCK_APP_DIR) : process.cwd(),
    updateRepoUrl: e.GAMEDOCK_UPDATE_REPO_URL,
    updateBranch: e.GAMEDOCK_UPDATE_BRANCH,
  };
}

/** Resolve a database URL of the form sqlite:<path> to an absolute file path. */
export function sqlitePathFromUrl(databaseUrl: string, dataDir: string): string {
  if (!databaseUrl.startsWith('sqlite:')) {
    throw new Error(
      `Unsupported GAMEDOCK_DATABASE_URL "${databaseUrl}". Only "sqlite:<path>" is supported in this version.`,
    );
  }
  const p = databaseUrl.slice('sqlite:'.length);
  return isAbsolute(p) ? p : join(dataDir, p);
}
