import os from 'node:os';
import si from 'systeminformation';
import type { Systeminformation } from 'systeminformation';
import type { DependencyStatusDto, SystemStatsDto } from '@gamedock/shared';
import { findExecutable } from './steamcmd.js';
import { spawn } from 'node:child_process';

const CACHE_MS = 2000;

export class SystemStatsService {
  private cached: {
    at: number;
    stats: Omit<SystemStatsDto, 'runningInstances' | 'totalInstances'>;
  } | null = null;

  async collect(): Promise<Omit<SystemStatsDto, 'runningInstances' | 'totalInstances'>> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) {
      return this.cached.stats;
    }

    const [load, mem, fs, net] = await Promise.all([
      si.currentLoad().catch(() => null),
      si.mem().catch(() => null),
      si.fsSize().catch(() => [] as Systeminformation.FsSizeData[]),
      si.networkStats().catch(() => [] as Systeminformation.NetworkStatsData[]),
    ]);

    const cpus = os.cpus();
    const stats = {
      cpu: {
        usagePercent: Math.round((load?.currentLoad ?? 0) * 10) / 10,
        cores: cpus.length,
        model: cpus[0]?.model ?? 'unknown',
        loadAverage: os.loadavg(),
      },
      memory: {
        totalBytes: mem?.total ?? os.totalmem(),
        usedBytes: mem ? mem.active : os.totalmem() - os.freemem(),
        freeBytes: mem?.available ?? os.freemem(),
      },
      disk: fs
        .filter((d) => d.size > 0)
        .slice(0, 8)
        .map((d) => ({
          mount: d.mount,
          totalBytes: d.size,
          usedBytes: d.used,
        })),
      network: net.slice(0, 4).map((n) => ({
        iface: n.iface,
        rxBytesPerSec: Math.max(0, Math.round(n.rx_sec ?? 0)),
        txBytesPerSec: Math.max(0, Math.round(n.tx_sec ?? 0)),
      })),
      uptimeSeconds: Math.floor(os.uptime()),
    };
    this.cached = { at: Date.now(), stats };
    return stats;
  }
}

async function commandVersion(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 5000);
      child.stdout.on('data', (c: Buffer) => (output += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (output += c.toString('utf8')));
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(output.split('\n')[0]?.trim().slice(0, 120) ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

export async function checkDependencies(steamcmdPath: string): Promise<DependencyStatusDto[]> {
  const checks: {
    name: string;
    lookup: string;
    versionArgs: string[] | null;
    required: boolean;
    hint: string;
  }[] = [
    {
      name: 'steamcmd',
      lookup: steamcmdPath,
      versionArgs: null, // steamcmd has no fast --version; existence is enough
      required: false,
      hint: 'Needed for Steam-based games. Install with scripts/install-steamcmd.sh',
    },
    {
      name: 'java',
      lookup: 'java',
      versionArgs: ['-version'],
      required: false,
      hint: 'Needed for Minecraft Java servers. apt install openjdk-21-jre-headless',
    },
    {
      name: 'tar',
      lookup: 'tar',
      versionArgs: ['--version'],
      required: true,
      hint: 'Needed for backups and tarball installs. apt install tar',
    },
    {
      name: 'unzip',
      lookup: 'unzip',
      versionArgs: ['-v'],
      required: false,
      hint: 'Needed for zip-based installers (Terraria). apt install unzip',
    },
  ];

  const results: DependencyStatusDto[] = [];
  for (const check of checks) {
    const path = await findExecutable(check.lookup);
    let version: string | null = null;
    if (path && check.versionArgs) {
      version = await commandVersion(path, check.versionArgs);
    }
    results.push({
      name: check.name,
      found: path !== null,
      path,
      version,
      required: check.required,
      hint: check.hint,
    });
  }
  return results;
}
