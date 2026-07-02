import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { badRequest } from '../errors.js';
import { resolveSafePath } from '../utils/safePath.js';

/**
 * Installer for non-Steam servers distributed as direct downloads
 * (Minecraft server JAR, Terraria zip, Factorio tarball, ...).
 * Extraction uses the system unzip/tar binaries via spawn (no shell).
 */

export interface UrlInstallOptions {
  url: string;
  archive: 'none' | 'zip' | 'tar';
  targetFile?: string;
  instanceDir: string;
  onLog: (line: string) => void;
}

export function validateDownloadUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest(`Invalid download URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw badRequest(`Download URL must use http(s), got "${parsed.protocol}"`);
  }
  return parsed;
}

async function runTool(command: string, args: string[], onLog: (line: string) => void) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const handle = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) onLog(line);
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (err) =>
      reject(
        new Error(
          `Failed to run ${command}: ${err.message}. Is it installed? (apt install unzip tar xz-utils)`,
        ),
      ),
    );
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

export async function runUrlInstall(options: UrlInstallOptions): Promise<void> {
  const url = validateDownloadUrl(options.url);
  options.onLog(`Downloading ${url.href}`);

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }

  const tmpName = `.gamedock-download-${Date.now()}.tmp`;
  const tmpPath = join(options.instanceDir, tmpName);
  await mkdir(options.instanceDir, { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tmpPath));

  const size = (await stat(tmpPath)).size;
  options.onLog(`Downloaded ${(size / 1024 / 1024).toFixed(1)} MiB`);

  try {
    if (options.archive === 'none') {
      const target = options.targetFile ?? url.pathname.split('/').pop() ?? 'download.bin';
      const targetPath = resolveSafePath(options.instanceDir, target);
      await mkdir(dirname(targetPath), { recursive: true });
      await rm(targetPath, { force: true });
      await rename(tmpPath, targetPath);
      options.onLog(`Saved as ${target}`);
    } else if (options.archive === 'zip') {
      options.onLog('Extracting zip archive...');
      await runTool('unzip', ['-o', '-q', tmpPath, '-d', options.instanceDir], options.onLog);
      options.onLog('Extraction complete');
    } else {
      options.onLog('Extracting tar archive...');
      // System tar auto-detects gz/xz/bz2 compression with -x.
      await runTool('tar', ['-xf', tmpPath, '-C', options.instanceDir], options.onLog);
      options.onLog('Extraction complete');
    }
  } finally {
    if (options.archive !== 'none') {
      await rm(tmpPath, { force: true });
    }
  }
}

/** Best-effort chmod +x on the resolved start executable (Linux installs). */
export async function markExecutable(instanceDir: string, executable: string): Promise<void> {
  if (process.platform === 'win32') return;
  if (!executable.startsWith('./') && !executable.startsWith('/')) return; // PATH-based like "java"
  try {
    const abs = executable.startsWith('/')
      ? executable
      : resolveSafePath(instanceDir, executable.slice(2));
    await chmod(abs, 0o755);
  } catch {
    // Executable may not exist yet (e.g. created later); not fatal.
  }
}
