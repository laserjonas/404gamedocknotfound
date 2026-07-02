import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Auto-provisions JDKs for game servers (currently Minecraft) that need a
 * specific Java major version. Builds come from Adoptium (Eclipse Temurin)
 * and are cached under <runtimeDir>/jdk-<majorVersion> so each version is
 * only downloaded once, shared across all instances.
 */

const ADOPTIUM_ASSETS_URL = 'https://api.adoptium.net/v3/assets/latest';
const COMPLETE_MARKER = '.gamedock-complete';

interface AdoptiumAsset {
  binary: { package: { link: string; name: string } };
}

export interface EnsureJavaRuntimeOptions {
  runtimeDir: string;
  majorVersion: number;
  onLog: (line: string) => void;
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
    child.on('error', (err) => reject(new Error(`Failed to run ${command}: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

/** Returns the absolute path to a `java` binary providing the given major version. */
export async function ensureJavaRuntime(options: EnsureJavaRuntimeOptions): Promise<string> {
  const { runtimeDir, majorVersion, onLog } = options;
  if (process.platform !== 'linux') {
    throw new Error(
      `Automatic Java ${majorVersion} provisioning is only implemented for Linux. ` +
        "Install a matching JDK manually and set it as this instance's start executable.",
    );
  }

  const finalDir = join(runtimeDir, `jdk-${majorVersion}`);
  const javaBin = join(finalDir, 'bin', 'java');
  const markerPath = join(finalDir, COMPLETE_MARKER);

  if (existsSync(markerPath)) {
    return javaBin;
  }

  onLog(`Java ${majorVersion} runtime not found locally, fetching from Adoptium...`);
  const apiUrl =
    `${ADOPTIUM_ASSETS_URL}/${majorVersion}/hotspot` +
    '?image_type=jdk&os=linux&architecture=x64&vendor=eclipse';
  const apiRes = await fetch(apiUrl);
  if (!apiRes.ok) {
    throw new Error(
      `Failed to look up a Java ${majorVersion} build on Adoptium: HTTP ${apiRes.status} ${apiRes.statusText}`,
    );
  }
  const assets = (await apiRes.json()) as AdoptiumAsset[];
  const asset = assets[0];
  if (!asset) {
    throw new Error(`No Eclipse Temurin build found for Java ${majorVersion} (linux x64)`);
  }

  const tmpDir = join(runtimeDir, `.tmp-jdk-${majorVersion}-${process.pid}`);
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  try {
    const archivePath = join(tmpDir, 'jdk.tar.gz');
    onLog(`Downloading ${asset.binary.package.name}...`);
    const downloadRes = await fetch(asset.binary.package.link, { redirect: 'follow' });
    if (!downloadRes.ok || !downloadRes.body) {
      throw new Error(`Download failed: HTTP ${downloadRes.status} ${downloadRes.statusText}`);
    }
    await pipeline(Readable.fromWeb(downloadRes.body), createWriteStream(archivePath));

    onLog('Extracting Java runtime...');
    await rm(finalDir, { recursive: true, force: true });
    await mkdir(finalDir, { recursive: true });
    // Adoptium tarballs contain a single top-level "jdk-<version>/" directory;
    // strip it so bin/java ends up directly under finalDir.
    await runTool('tar', ['-xf', archivePath, '-C', finalDir, '--strip-components=1'], onLog);
    await chmod(javaBin, 0o755);

    await writeFile(markerPath, new Date().toISOString(), 'utf8');
    onLog(`Java ${majorVersion} runtime ready at ${javaBin}`);
    return javaBin;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
