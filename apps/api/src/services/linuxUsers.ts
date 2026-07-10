import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger.js';

/** Matches exactly what Node's crypto.randomUUID() produces (lowercase v4 UUID). */
const INSTANCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** "gd-00001 1005" - username and numeric uid, as printed by the helper script. */
const PROVISION_OUTPUT_RE = /^(gd-\d{5,}) (\d+)$/;

export interface ProvisionedUser {
  username: string;
  uid: number;
}

export interface LinuxUserServiceConfig {
  enabled: boolean;
  appDir: string;
}

/**
 * Provisions/removes a dedicated, unprivileged Linux user per instance via a
 * narrowly-scoped root-owned helper script (scripts/gamedock-instance-user),
 * invoked through sudo. gamedock itself has no root/CAP_SETUID - this is the
 * one deliberate, tightly-scoped privilege escalation path the service is
 * allowed (see docs/SECURITY.md "Process isolation" and the sudoers drop-in
 * installed by scripts/install.sh). Disabled by default; see config.ts.
 */
export class LinuxUserService {
  constructor(
    private config: LinuxUserServiceConfig,
    private logger: Logger,
  ) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  private helperPath(): string {
    // Preferred: the root-owned copy outside the app dir that install.sh
    // places (and sudoers references) - the in-repo copy under appDir gets
    // replaced by self-update running as gamedock, so a root-executable
    // file must not live there. The appDir fallback keeps hosts working
    // until they re-run install.sh once.
    const system = '/usr/local/sbin/gamedock-instance-user';
    if (existsSync(system)) return system;
    return join(this.config.appDir, 'scripts', 'gamedock-instance-user');
  }

  private validateInstanceId(instanceId: string): void {
    if (!INSTANCE_ID_RE.test(instanceId)) {
      throw new Error(`Refusing to provision a Linux user for a malformed instance id`);
    }
  }

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('sudo', ['-n', this.helperPath(), ...args], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('error', (err) =>
        reject(new Error(`Failed to run instance-user helper: ${err.message}`)),
      );
      child.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`instance-user helper exited with code ${code}: ${stderr.trim()}`));
      });
    });
  }

  private parseProvisionOutput(output: string): ProvisionedUser {
    const match = PROVISION_OUTPUT_RE.exec(output);
    const username = match?.[1];
    const uid = match?.[2];
    if (!username || !uid) {
      throw new Error(`instance-user helper returned unexpected output: "${output}"`);
    }
    return { username, uid: Number(uid) };
  }

  /** Creates (or re-provisions) a dedicated Linux user for the instance. */
  async provision(instanceId: string): Promise<ProvisionedUser> {
    this.validateInstanceId(instanceId);
    const result = this.parseProvisionOutput(await this.run(['create', instanceId]));
    this.logger.info(
      { instanceId, username: result.username, uid: result.uid },
      'provisioned dedicated Linux user for instance',
    );
    return result;
  }

  /** Re-applies ownership/permissions for an already-provisioned instance (repair/migration). */
  async repair(instanceId: string): Promise<ProvisionedUser> {
    this.validateInstanceId(instanceId);
    return this.parseProvisionOutput(await this.run(['chown', instanceId]));
  }

  /**
   * Makes the shared cluster-data directory writable by every per-instance
   * user (group gamedock-instances). Best-effort: an old helper without the
   * clusterdir subcommand logs a warning telling the admin to re-run
   * install.sh - ARK-style cluster transfers won't work until then.
   */
  async ensureClusterDir(): Promise<void> {
    try {
      await this.run(['clusterdir']);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message },
        'could not prepare the shared cluster directory - re-run scripts/install.sh to update the instance-user helper if cluster features are needed',
      );
    }
  }

  /** Removes the dedicated Linux user for the instance. Best-effort logged, never throws. */
  async deprovision(instanceId: string): Promise<void> {
    this.validateInstanceId(instanceId);
    try {
      await this.run(['delete', instanceId]);
      this.logger.info({ instanceId }, 'removed dedicated Linux user for instance');
    } catch (err) {
      this.logger.warn(
        { instanceId, err: (err as Error).message },
        'failed to remove dedicated Linux user for instance (leaving it in place)',
      );
    }
  }
}
