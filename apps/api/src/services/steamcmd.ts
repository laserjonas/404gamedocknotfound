import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs';
import { promisify } from 'node:util';
import { isAbsolute, join, delimiter } from 'node:path';
import { badRequest } from '../errors.js';

const accessAsync = promisify(access);

/**
 * SteamCMD integration. Commands are built as argument arrays and executed
 * with spawn() (no shell), so values can never break out into a shell.
 */

export interface SteamCmdInstallOptions {
  steamcmdPath: string;
  installDir: string;
  appId: number;
  /** Extra app_update arguments from the template (e.g. beta branches). */
  extraArgs?: string[];
  validate?: boolean;
  onLog: (line: string) => void;
  onProgress?: (percent: number, phase: string) => void;
}

/** Build the steamcmd argument list for an anonymous install/update. */
export function buildSteamCmdArgs(options: {
  installDir: string;
  appId: number;
  extraArgs?: string[];
  validate?: boolean;
}): string[] {
  if (!Number.isInteger(options.appId) || options.appId <= 0) {
    throw badRequest(`Invalid Steam app id: ${options.appId}`);
  }
  if (!isAbsolute(options.installDir)) {
    throw badRequest('SteamCMD install directory must be an absolute path');
  }
  if (/[\r\n\0]/.test(options.installDir)) {
    throw badRequest('SteamCMD install directory contains illegal characters');
  }
  const extra = options.extraArgs ?? [];
  for (const arg of extra) {
    if (/[\r\n\0"]/.test(arg)) {
      throw badRequest(`Illegal characters in steamcmd argument: ${JSON.stringify(arg)}`);
    }
  }

  const appUpdateParts = [String(options.appId), ...extra];
  if (options.validate !== false) appUpdateParts.push('validate');

  return [
    '+force_install_dir',
    options.installDir,
    '+login',
    'anonymous',
    '+app_update',
    ...appUpdateParts,
    '+quit',
  ];
}

/** Locate an executable: absolute path is checked directly, otherwise PATH is scanned. */
export async function findExecutable(nameOrPath: string): Promise<string | null> {
  const candidates: string[] = [];
  if (isAbsolute(nameOrPath) || nameOrPath.includes('/') || nameOrPath.includes('\\')) {
    candidates.push(nameOrPath);
  } else {
    const pathEnv = process.env.PATH ?? '';
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const dir of pathEnv.split(delimiter)) {
      if (!dir) continue;
      for (const ext of exts) {
        candidates.push(join(dir, nameOrPath + ext));
      }
    }
    // Common Debian steamcmd locations that may not be on the service PATH.
    if (nameOrPath === 'steamcmd') {
      candidates.push('/usr/games/steamcmd', '/usr/bin/steamcmd');
    }
  }
  for (const candidate of candidates) {
    try {
      await accessAsync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export async function detectSteamCmd(configuredPath: string): Promise<{
  found: boolean;
  path: string | null;
}> {
  const path = await findExecutable(configuredPath);
  return { found: path !== null, path };
}

// SteamCMD progress lines look like:
// Update state (0x61) downloading, progress: 42.42 (1234567 / 2345678)
const PROGRESS_RE = /Update state \(0x\d+\)\s+(\w+),\s+progress:\s+([\d.]+)/;

export async function runSteamCmdInstall(options: SteamCmdInstallOptions): Promise<void> {
  const resolved = await findExecutable(options.steamcmdPath);
  if (!resolved) {
    throw new Error(
      `steamcmd not found (looked for "${options.steamcmdPath}"). ` +
        'Install it with scripts/install-steamcmd.sh or set GAMEDOCK_STEAMCMD_PATH.',
    );
  }

  const args = buildSteamCmdArgs({
    installDir: options.installDir,
    appId: options.appId,
    extraArgs: options.extraArgs,
    validate: options.validate,
  });

  options.onLog(`$ ${resolved} ${args.join(' ')}`);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(resolved, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let sawSuccess = false;
    const handleChunk = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        options.onLog(line);
        const match = PROGRESS_RE.exec(line);
        if (match && options.onProgress) {
          options.onProgress(Number(match[2]), match[1] ?? 'working');
        }
        if (line.includes('fully installed')) {
          sawSuccess = true;
        }
      }
    };

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);

    child.on('error', (err) => rejectPromise(new Error(`Failed to run steamcmd: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0 || sawSuccess) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`steamcmd exited with code ${code}`));
      }
    });
  });
}
