import { spawn } from 'node:child_process';
import { access, constants, existsSync } from 'node:fs';
import { copyFile, mkdir, symlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { isAbsolute, join, dirname, delimiter } from 'node:path';
import { badRequest } from '../errors.js';
import { runUrlInstall } from './urlInstaller.js';

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

/** Official SteamCMD bootstrap tarball (Valve CDN). */
const STEAMCMD_TARBALL_URL =
  'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz';

/**
 * Places a host steamcmd installation may keep the given runtime library
 * (Debian package layout, self-extracted layouts, and the service's own
 * steamcmd HOME). First existing candidate wins.
 */
function findSteamClientLibrary(
  steamcmdPath: string | null,
  arch: 'linux32' | 'linux64',
): string | null {
  const home = process.env.HOME ?? '';
  const roots = [
    steamcmdPath ? dirname(steamcmdPath) : null,
    home ? join(home, '.local/share/Steam/steamcmd') : null,
    home ? join(home, 'Steam') : null,
    home ? join(home, '.steam/steamcmd') : null,
    '/usr/lib/games/steam',
  ].filter((root): root is string => root !== null);
  for (const root of roots) {
    const candidate = join(root, arch, 'steamclient.so');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Copies steamclient.so into the HOME the game will run with
 * ($HOME/.steam/sdk64 and sdk32). Steamworks servers like ARK load it from
 * there; without it they spam [S_API FAIL] errors and may never register
 * with Steam's server list. Best-effort: a missing library logs a warning
 * instead of failing the install.
 */
export async function installSteamClientLibrary(options: {
  homeDir: string;
  steamcmdPath: string;
  onLog: (line: string) => void;
}): Promise<void> {
  const resolved = await findExecutable(options.steamcmdPath);
  const targets: [arch: 'linux32' | 'linux64', sdkDir: string][] = [
    ['linux64', 'sdk64'],
    ['linux32', 'sdk32'],
  ];
  for (const [arch, sdkDir] of targets) {
    const source = findSteamClientLibrary(resolved, arch);
    const targetDir = join(options.homeDir, '.steam', sdkDir);
    if (!source) {
      options.onLog(
        `WARNING: could not locate ${arch}/steamclient.so on this host - the game may log [S_API FAIL] errors. Run steamcmd once by hand if this persists.`,
      );
      continue;
    }
    await mkdir(targetDir, { recursive: true });
    await copyFile(source, join(targetDir, 'steamclient.so'));
    options.onLog(`Installed steamclient.so -> .steam/${sdkDir}/`);
  }
}

/**
 * Provisions the game's own workshop-mod machinery for Unreal servers that
 * support -automanagedmods (ARK): a private SteamCMD copy at the hardcoded
 * Engine/Binaries/ThirdParty/SteamCMD/Linux path, plus a steamapps symlink
 * pointing at the real download location under the game's HOME - newer
 * SteamCMD builds download workshop content under ~/.local/share/Steam,
 * while the game unpacks mods from its embedded SteamCMD's steamapps dir
 * (LinuxGSM #2937). Idempotent; safe to run on every install/update.
 */
export async function provisionAutoManagedMods(options: {
  instanceDir: string;
  homeDir: string;
  onLog: (line: string) => void;
}): Promise<void> {
  const steamCmdDir = join(options.instanceDir, 'Engine/Binaries/ThirdParty/SteamCMD/Linux');
  if (!existsSync(join(steamCmdDir, 'steamcmd.sh'))) {
    options.onLog('Installing embedded SteamCMD for workshop mod support (-automanagedmods)...');
    await mkdir(steamCmdDir, { recursive: true });
    await runUrlInstall({
      url: STEAMCMD_TARBALL_URL,
      archive: 'tar',
      instanceDir: steamCmdDir,
      onLog: options.onLog,
    });
  }

  const realSteamapps = join(options.homeDir, '.local/share/Steam/steamapps');
  await mkdir(realSteamapps, { recursive: true });
  const linkPath = join(steamCmdDir, 'steamapps');
  if (!existsSync(linkPath)) {
    await symlink(realSteamapps, linkPath, 'dir');
    options.onLog('Linked embedded SteamCMD steamapps -> ~/.local/share/Steam/steamapps');
  }
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
