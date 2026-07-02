import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { badRequest } from '../errors.js';

/**
 * Self-update: pulls the app from a git repo instead of requiring an SSH
 * deploy for every change. Never mutates the live app directory in place
 * until a full clone+build has succeeded in a scratch directory, so a failed
 * update leaves the running instance untouched.
 *
 * The scratch directory lives under the data dir (owned by the service user)
 * rather than next to the app directory, because the app directory's parent
 * (e.g. /opt) is typically root-owned - the service user can only write
 * *inside* directories it already owns, not create siblings of them.
 */

export interface SelfUpdateConfig {
  repoUrl: string;
  branch: string;
  appDir: string;
  /** Absolute path to a JSON file recording the last deployed commit; lives outside appDir so it survives updates. */
  stateFilePath: string;
  /** Scratch directory for cloning/building; lives outside appDir (see class doc). */
  stagingDir: string;
}

export interface UpdateStatus {
  configured: boolean;
  repoUrl: string;
  branch: string;
  currentCommit: string | null;
  currentCommitAt: string | null;
  remoteCommit: string | null;
  updateAvailable: boolean;
}

interface UpdateState {
  commit: string;
  branch: string;
  updatedAt: string;
}

function runTool(
  command: string,
  args: string[],
  cwd: string,
  onLog: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function captureTool(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', (err) => reject(new Error(`Failed to run ${command}: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

export class SelfUpdateService {
  constructor(private config: SelfUpdateConfig) {}

  private async readState(): Promise<UpdateState | null> {
    try {
      return JSON.parse(await readFile(this.config.stateFilePath, 'utf8')) as UpdateState;
    } catch {
      return null;
    }
  }

  private requireConfigured(): void {
    if (!this.config.repoUrl) {
      throw badRequest(
        'GAMEDOCK_UPDATE_REPO_URL is not configured. Set it (and GAMEDOCK_UPDATE_BRANCH if needed) in .env and restart GameDock.',
      );
    }
  }

  async checkForUpdate(): Promise<UpdateStatus> {
    const state = await this.readState();
    if (!this.config.repoUrl) {
      return {
        configured: false,
        repoUrl: '',
        branch: this.config.branch,
        currentCommit: state?.commit ?? null,
        currentCommitAt: state?.updatedAt ?? null,
        remoteCommit: null,
        updateAvailable: false,
      };
    }

    let remoteCommit: string | null = null;
    try {
      const output = await captureTool('git', [
        'ls-remote',
        this.config.repoUrl,
        `refs/heads/${this.config.branch}`,
      ]);
      remoteCommit = output.split(/\s+/)[0] || null;
    } catch (err) {
      throw new Error(`Failed to check for updates: ${(err as Error).message}`);
    }
    if (!remoteCommit) {
      throw new Error(`Branch "${this.config.branch}" not found on ${this.config.repoUrl}`);
    }

    return {
      configured: true,
      repoUrl: this.config.repoUrl,
      branch: this.config.branch,
      currentCommit: state?.commit ?? null,
      currentCommitAt: state?.updatedAt ?? null,
      remoteCommit,
      updateAvailable: remoteCommit !== state?.commit,
    };
  }

  /**
   * Clones, builds and installs the latest commit in place of appDir, then
   * records the deployed commit. Does not restart the process - callers
   * should do that once this resolves successfully.
   */
  async applyUpdate(onLog: (line: string) => void): Promise<string> {
    this.requireConfigured();
    const { repoUrl, branch, appDir, stagingDir } = this.config;

    onLog(`Cloning ${repoUrl} (${branch}) into a staging directory...`);
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });
    await runTool(
      'git',
      ['clone', '--depth', '1', '--branch', branch, repoUrl, stagingDir],
      process.cwd(),
      onLog,
    );

    const commit = await captureTool('git', ['rev-parse', 'HEAD'], stagingDir);
    onLog(`Checked out commit ${commit}`);

    onLog('Installing dependencies (pnpm install)...');
    await runTool('pnpm', ['install', '--frozen-lockfile'], stagingDir, onLog);

    onLog('Building (pnpm -r build)...');
    await runTool('pnpm', ['-r', 'build'], stagingDir, onLog);

    onLog('Installing production dependencies...');
    // pnpm refuses to purge dev deps from node_modules without a TTY confirmation
    // unless CI=true is set - we're never attached to a TTY here.
    await runTool('pnpm', ['install', '--frozen-lockfile', '--prod'], stagingDir, onLog, {
      ...process.env,
      CI: 'true',
    });

    onLog('Assembling web UI...');
    await rm(join(stagingDir, 'apps', 'api', 'web-dist'), { recursive: true, force: true });
    await cp(join(stagingDir, 'apps', 'web', 'dist'), join(stagingDir, 'apps', 'api', 'web-dist'), {
      recursive: true,
    });

    onLog(`Installing into ${appDir} (preserving .env)...`);
    await mkdir(appDir, { recursive: true });
    await runTool(
      'rsync',
      ['-a', '--delete', '--exclude', '.git', '--exclude', '.env', `${stagingDir}/`, `${appDir}/`],
      process.cwd(),
      onLog,
    );

    await rm(stagingDir, { recursive: true, force: true });

    const state: UpdateState = { commit, branch, updatedAt: new Date().toISOString() };
    await writeFile(this.config.stateFilePath, JSON.stringify(state, null, 2), 'utf8');

    onLog(`Update applied (commit ${commit}).`);
    return commit;
  }
}
