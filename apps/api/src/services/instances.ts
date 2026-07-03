import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type {
  CreateInstanceRequest,
  InstanceDto,
  InstanceStatus,
  UpdateInstanceRequest,
} from '@gamedock/shared';
import type { GameTemplate } from '@gamedock/game-templates';
import type { InstanceRepository, InstanceRow } from '../db/repositories/instances.js';
import type { JobRow } from '../db/repositories/jobs.js';
import type { JobService } from './jobs.js';
import type { TemplateService } from './templates.js';
import type { ProcessManager } from './processManager.js';
import type { BackupService } from './backups.js';
import type { BackupRepository } from '../db/repositories/backups.js';
import type { LinuxUserService } from './linuxUsers.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { TemplateService as TemplateServiceStatic } from './templates.js';
import { runSteamCmdInstall } from './steamcmd.js';
import { markExecutable, runUrlInstall } from './urlInstaller.js';
import { resolveMinecraftServerJarUrl } from './mojang.js';
import { ensureJavaRuntime } from './javaRuntime.js';
import {
  buildStartCommand,
  builtinVariables,
  resolveVariableValues,
  substitutePlaceholders,
} from './variables.js';
import { resolveSafePath } from '../utils/safePath.js';
import { badRequest, conflict, notFound } from '../errors.js';

const INSTANCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,63}$/;

export class InstanceService {
  constructor(
    private repo: InstanceRepository,
    private backupRepo: BackupRepository,
    private templates: TemplateService,
    private jobs: JobService,
    private processes: ProcessManager,
    private backups: BackupService,
    private linuxUsers: LinuxUserService,
    private config: AppConfig,
    private logger: Logger,
  ) {}

  // --- helpers ---------------------------------------------------------------

  instanceDir(instanceId: string): string {
    return join(this.config.instanceDir, instanceId);
  }

  async getRow(id: string): Promise<InstanceRow> {
    const row = await this.repo.findById(id);
    if (!row) throw notFound('Server instance not found');
    return row;
  }

  templateOf(row: InstanceRow): GameTemplate {
    return TemplateServiceStatic.parseSnapshot(row.template_definition);
  }

  /** Effective runtime status: live process state wins over the persisted one. */
  private effectiveStatus(row: InstanceRow): InstanceStatus {
    const live = this.processes.statusOf(row.id);
    if (live) return live;
    // If the daemon restarted while a server ran, persisted "running" is stale.
    if (row.status === 'running' || row.status === 'starting' || row.status === 'stopping') {
      return 'stopped';
    }
    return row.status;
  }

  async toDto(row: InstanceRow, includeUsage = false): Promise<InstanceDto> {
    const template = this.templateOf(row);
    const status = this.effectiveStatus(row);
    const [ports, envVars, variables, usage] = await Promise.all([
      this.repo.listPorts(row.id),
      this.repo.getEnvVars(row.id),
      this.repo.getVariables(row.id),
      includeUsage ? this.processes.usage(row.id) : Promise.resolve(null),
    ]);
    return {
      id: row.id,
      name: row.name,
      templateId: row.template_id,
      templateName: template.name,
      status,
      installed: row.installed === 1,
      autoStart: row.auto_start === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startExecutable: row.start_executable,
      startArgs: row.start_args ? (JSON.parse(row.start_args) as string[]) : null,
      ports: ports.map((p) => ({
        id: p.id,
        name: p.name,
        port: p.port,
        protocol: p.protocol,
      })),
      envVars,
      variables: this.redactSecretVariables(template, variables),
      pid: this.processes.pidOf(row.id),
      usage,
      crashRestart: row.crash_restart === 1,
      backupIntervalHours: row.backup_interval_hours,
      backupRetentionCount: row.backup_retention_count,
    };
  }

  private redactSecretVariables(
    template: GameTemplate,
    variables: Record<string, string>,
  ): Record<string, string> {
    // Secret variable values stay editable but are never sent back to clients.
    const secretKeys = new Set(template.variables.filter((v) => v.secret).map((v) => v.key));
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(variables)) {
      result[key] = secretKeys.has(key) && value !== '' ? '••••••••' : value;
    }
    return result;
  }

  async listDtos(): Promise<InstanceDto[]> {
    const rows = await this.repo.list();
    return Promise.all(rows.map((row) => this.toDto(row)));
  }

  // --- CRUD ------------------------------------------------------------------

  async create(request: CreateInstanceRequest): Promise<InstanceRow> {
    if (!INSTANCE_NAME_RE.test(request.name)) {
      throw badRequest('Instance name must be 2-64 characters (letters, digits, spaces, ._- only)');
    }
    if (await this.repo.findByName(request.name)) {
      throw conflict(`An instance named "${request.name}" already exists`);
    }
    const template = this.templates.get(request.templateId);
    if (!template.os.includes('linux') && process.platform === 'linux') {
      throw badRequest(`Template "${template.id}" does not support Linux`);
    }

    const variables = resolveVariableValues(template, request.variables ?? {});

    const row = await this.repo.create({
      name: request.name,
      templateId: template.id,
      templateDefinition: JSON.stringify(template),
    });

    await this.repo.replaceVariables(row.id, variables);
    const ports =
      request.ports && request.ports.length > 0
        ? request.ports
        : template.ports.map((p) => ({ name: p.name, port: p.port, protocol: p.protocol }));
    await this.repo.replacePorts(row.id, ports);

    await mkdir(this.instanceDir(row.id), { recursive: true });

    if (this.linuxUsers.enabled) {
      try {
        const { username, uid } = await this.linuxUsers.provision(row.id);
        await this.repo.update(row.id, { linuxUsername: username, linuxUid: uid });
      } catch (err) {
        // No silent fallback to the shared-user model - that would be a
        // security-relevant behavior change nobody would notice.
        await rm(this.instanceDir(row.id), { recursive: true, force: true }).catch(() => {});
        await this.repo.delete(row.id);
        throw new Error(
          `Failed to provision an isolated Linux user for this instance: ${(err as Error).message}`,
        );
      }
    }

    return this.getRow(row.id);
  }

  async update(id: string, request: UpdateInstanceRequest): Promise<InstanceRow> {
    const row = await this.getRow(id);
    const template = this.templateOf(row);

    if (request.name !== undefined && request.name !== row.name) {
      if (!INSTANCE_NAME_RE.test(request.name)) {
        throw badRequest('Invalid instance name');
      }
      const existing = await this.repo.findByName(request.name);
      if (existing && existing.id !== id) {
        throw conflict(`An instance named "${request.name}" already exists`);
      }
    }

    if (request.variables !== undefined) {
      // Secret placeholder values (bullet chars) mean "keep the stored value".
      const current = await this.repo.getVariables(id);
      const merged: Record<string, string> = { ...request.variables };
      for (const variable of template.variables) {
        if (variable.secret && merged[variable.key]?.includes('••')) {
          merged[variable.key] = current[variable.key] ?? variable.default;
        }
      }
      const resolved = resolveVariableValues(template, merged);
      await this.repo.replaceVariables(id, resolved);
    }

    if (request.envVars !== undefined) {
      if (Object.keys(request.envVars).length > 64) {
        throw badRequest('Too many environment variables');
      }
      for (const key of Object.keys(request.envVars)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw badRequest(`Invalid environment variable name "${key}"`);
        }
        if (key.startsWith('GAMEDOCK_')) {
          throw badRequest('Environment variables must not use the GAMEDOCK_ prefix');
        }
      }
      await this.repo.replaceEnvVars(id, request.envVars);
    }

    if (request.ports !== undefined) {
      await this.repo.replacePorts(id, request.ports);
    }

    await this.repo.update(id, {
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.autoStart !== undefined ? { autoStart: request.autoStart } : {}),
      ...(request.startExecutable !== undefined
        ? { startExecutable: request.startExecutable }
        : {}),
      ...(request.startArgs !== undefined
        ? { startArgs: request.startArgs === null ? null : JSON.stringify(request.startArgs) }
        : {}),
      ...(request.crashRestart !== undefined ? { crashRestart: request.crashRestart } : {}),
      ...(request.backupIntervalHours !== undefined
        ? { backupIntervalHours: request.backupIntervalHours }
        : {}),
      ...(request.backupRetentionCount !== undefined
        ? { backupRetentionCount: request.backupRetentionCount }
        : {}),
    });

    return this.getRow(id);
  }

  /** Deleting removes the process, files, backups and DB rows. Runs as a job. */
  async enqueueDelete(id: string, requestedBy: string | null): Promise<JobRow> {
    const row = await this.getRow(id);
    if (this.processes.isActive(id)) {
      throw conflict('Stop the server before deleting it');
    }
    return this.jobs.enqueue('delete_instance', id, requestedBy, async (handle) => {
      if (this.processes.isActive(id)) {
        throw new Error('Server was started while deletion was queued; stop it first');
      }
      handle.log(`Deleting instance "${row.name}"...`);
      const dir = this.instanceDir(id);
      if (existsSync(dir)) {
        handle.log('Removing server files...');
        await rm(dir, { recursive: true, force: true });
      }
      const backupDir = join(this.config.backupDir, id);
      if (existsSync(backupDir)) {
        handle.log('Removing backups...');
        await rm(backupDir, { recursive: true, force: true });
      }
      if (row.linux_username) {
        handle.log('Removing dedicated Linux user...');
        await this.linuxUsers.deprovision(id);
      }
      await this.repo.delete(id);
      handle.log('Instance deleted');
    });
  }

  // --- install / update ------------------------------------------------------

  async enqueueInstall(id: string, requestedBy: string | null, isUpdate: boolean): Promise<JobRow> {
    const row = await this.getRow(id);
    const template = this.templateOf(row);
    if (this.processes.isActive(id)) {
      throw conflict('Stop the server before installing or updating');
    }
    if (template.installMethod === 'manual') {
      throw badRequest(
        'This template is installed manually. Upload the server files with the file manager.',
      );
    }

    return this.jobs.enqueue(isUpdate ? 'update' : 'install', id, requestedBy, async (handle) => {
      await this.repo.update(id, { status: 'installing' });
      try {
        const dir = this.instanceDir(id);
        await mkdir(dir, { recursive: true });
        let resolvedJavaBin: string | undefined;
        const variables = {
          ...(await this.repo.getVariables(id)),
          ...builtinVariables({ instanceDir: dir, instanceId: id, instanceName: row.name }),
        };

        if (template.installMethod === 'steamcmd') {
          const steam = template.steam!;
          handle.log(`Installing Steam app ${steam.appId} via SteamCMD (anonymous login)`);
          await runSteamCmdInstall({
            steamcmdPath: this.config.steamcmdPath,
            installDir: dir,
            appId: steam.appId,
            extraArgs: steam.extraArgs,
            onLog: (line) => handle.log(line),
            onProgress: (percent, phase) => handle.setProgress(percent, phase),
          });
        } else if (template.installMethod === 'url') {
          const urlInstall = template.urlInstall!;
          let url: string;
          if (urlInstall.resolver === 'mojang-version-manifest') {
            const versionSelector = variables[urlInstall.versionVariable!] ?? '';
            handle.log(
              `Resolving Minecraft server download for version "${versionSelector || 'latest-release'}"...`,
            );
            const resolved = await resolveMinecraftServerJarUrl(versionSelector);
            handle.log(
              `Resolved to Minecraft ${resolved.version} (requires Java ${resolved.javaMajorVersion}+)`,
            );
            url = resolved.url;
            resolvedJavaBin = await ensureJavaRuntime({
              runtimeDir: this.config.runtimeDir,
              majorVersion: resolved.javaMajorVersion,
              onLog: (line) => handle.log(line),
            });
          } else {
            url = substitutePlaceholders(urlInstall.url!, variables);
          }
          await runUrlInstall({
            url,
            archive: urlInstall.archive,
            targetFile: urlInstall.targetFile,
            instanceDir: dir,
            onLog: (line) => handle.log(line),
          });
        }

        // Write template setup files (eula.txt, server-settings.json, ...).
        for (const setupFile of template.setupFiles) {
          const target = resolveSafePath(dir, setupFile.path);
          if (isUpdate && existsSync(target)) continue; // don't clobber user edits on update
          await mkdir(dirname(target), { recursive: true });
          const content = substitutePlaceholders(setupFile.content, variables);
          await writeFile(target, content, 'utf8');
          handle.log(`Wrote ${setupFile.path}`);
        }

        const executable = substitutePlaceholders(template.start.executable, variables);
        await markExecutable(dir, executable);

        await this.repo.update(id, {
          installed: true,
          status: 'stopped',
          ...(resolvedJavaBin !== undefined ? { startExecutable: resolvedJavaBin } : {}),
        });
        handle.setProgress(100, 'done');
        handle.log(isUpdate ? 'Update finished' : 'Install finished');
      } catch (err) {
        const current = await this.repo.findById(id);
        if (current) {
          await this.repo.update(id, {
            status: current.installed === 1 ? 'stopped' : 'not_installed',
          });
        }
        throw err;
      }
    });
  }

  // --- process control ---------------------------------------------------------

  async start(id: string): Promise<void> {
    const row = await this.getRow(id);
    if (row.installed !== 1) {
      throw conflict('Install the server files first');
    }
    if (await this.jobs.hasActiveJob(id)) {
      throw conflict('An install/backup operation is running for this server');
    }
    const template = this.templateOf(row);
    const dir = this.instanceDir(id);
    const [variables, instanceEnv] = await Promise.all([
      this.repo.getVariables(id),
      this.repo.getEnvVars(id),
    ]);
    const command = buildStartCommand({
      template,
      instanceDir: dir,
      instanceId: id,
      instanceName: row.name,
      variables,
      instanceEnv,
      overrideExecutable: row.start_executable,
      overrideArgs: row.start_args ? (JSON.parse(row.start_args) as string[]) : null,
    });

    this.processes.start({
      instanceId: id,
      instanceName: row.name,
      instanceDir: dir,
      command,
      template,
      linuxUsername: row.linux_username,
    });
  }

  async stop(id: string): Promise<void> {
    await this.getRow(id);
    await this.processes.stop(id);
  }

  async restart(id: string): Promise<void> {
    const row = await this.getRow(id);
    if (this.processes.isActive(row.id)) {
      await this.processes.stop(row.id);
    }
    await this.start(id);
  }

  async kill(id: string): Promise<void> {
    await this.getRow(id);
    await this.processes.stop(id, { force: true });
  }

  async sendCommand(id: string, command: string): Promise<void> {
    await this.getRow(id);
    this.processes.sendCommand(id, command);
  }

  // --- backups -----------------------------------------------------------------

  async enqueueBackup(
    id: string,
    requestedBy: string | null,
    note: string | null,
    excludePaths: string[],
  ): Promise<JobRow> {
    const row = await this.getRow(id);
    return this.jobs.enqueue('backup', id, requestedBy, async (handle) => {
      await this.backups.create({
        instanceId: id,
        instanceDir: this.instanceDir(id),
        note,
        excludePaths,
        onLog: (line) => handle.log(line),
      });
      handle.log(`Backup of "${row.name}" finished`);

      const current = await this.repo.findById(id);
      const retention = current?.backup_retention_count;
      if (retention && retention > 0) {
        const excess = (await this.backupRepo.listForInstance(id)).slice(retention);
        for (const old of excess) {
          await this.backups.delete(old);
          handle.log(`Pruned old backup ${old.file_name} (keeping last ${retention})`);
        }
      }
    });
  }

  /** Enqueues a backup for every installed instance whose schedule is due. Called periodically. */
  async runDueScheduledBackups(): Promise<void> {
    for (const row of await this.repo.list()) {
      if (!row.backup_interval_hours || row.installed !== 1) continue;
      if (await this.jobs.hasActiveJob(row.id)) continue;
      const backups = await this.backupRepo.listForInstance(row.id);
      const last = backups[0];
      const dueAt = last
        ? new Date(last.created_at).getTime() + row.backup_interval_hours * 60 * 60 * 1000
        : 0;
      if (Date.now() < dueAt) continue;
      try {
        await this.enqueueBackup(row.id, null, 'Scheduled backup', []);
      } catch (err) {
        this.logger.warn(
          { instanceId: row.id, err: (err as Error).message },
          'failed to enqueue scheduled backup',
        );
      }
    }
  }

  async enqueueRestore(id: string, backupId: string, requestedBy: string | null): Promise<JobRow> {
    const row = await this.getRow(id);
    if (this.processes.isActive(id)) {
      throw conflict('Stop the server before restoring a backup');
    }
    const backup = await this.backupRepo.findById(backupId);
    if (!backup || backup.instance_id !== id) {
      throw notFound('Backup not found for this instance');
    }
    return this.jobs.enqueue('restore', id, requestedBy, async (handle) => {
      await this.backups.restore({
        backup,
        instanceDir: this.instanceDir(id),
        onLog: (line) => handle.log(line),
      });
      await this.repo.update(id, { installed: true, status: 'stopped' });
      handle.log(`Restore of "${row.name}" finished`);
    });
  }

  // --- boot ---------------------------------------------------------------------

  /**
   * Checks whether a previously-running instance's process survived this
   * restart (game servers run detached, see processManager.ts) and, if so,
   * re-registers it instead of treating it as stopped.
   */
  private async tryReattach(row: InstanceRow): Promise<boolean> {
    if (row.last_pid === null || row.installed !== 1) return false;
    try {
      const template = this.templateOf(row);
      const dir = this.instanceDir(row.id);
      const [variables, instanceEnv] = await Promise.all([
        this.repo.getVariables(row.id),
        this.repo.getEnvVars(row.id),
      ]);
      const command = buildStartCommand({
        template,
        instanceDir: dir,
        instanceId: row.id,
        instanceName: row.name,
        variables,
        instanceEnv,
        overrideExecutable: row.start_executable,
        overrideArgs: row.start_args ? (JSON.parse(row.start_args) as string[]) : null,
      });
      const cwd = resolveSafePath(dir, command.workingDir || '.');
      const matches = row.linux_username
        ? this.processes.pidMatches(
            row.last_pid,
            command.executable,
            cwd,
            row.linux_uid ?? undefined,
          )
        : this.processes.pidMatches(row.last_pid, command.executable, cwd);
      if (!matches) return false;
      this.processes.adopt({
        instanceId: row.id,
        instanceName: row.name,
        pid: row.last_pid,
        template,
        linuxUsername: row.linux_username,
      });
      await this.repo.update(row.id, { status: 'running' });
      this.logger.info({ instance: row.name, pid: row.last_pid }, 'reattached to running instance');
      return true;
    } catch (err) {
      this.logger.warn(
        { instance: row.name, err: (err as Error).message },
        'failed to check for a surviving process, treating as stopped',
      );
      return false;
    }
  }

  async autoStartAll(): Promise<void> {
    for (const row of await this.repo.list()) {
      if (!['running', 'starting', 'stopping', 'installing'].includes(row.status)) continue;
      const reattached = await this.tryReattach(row);
      if (!reattached) {
        await this.repo.update(row.id, {
          status: row.installed === 1 ? 'stopped' : 'not_installed',
        });
      }
    }
    for (const row of await this.repo.list()) {
      if (row.auto_start === 1 && row.installed === 1 && !this.processes.isActive(row.id)) {
        try {
          this.logger.info({ instance: row.name }, 'auto-starting instance');
          await this.start(row.id);
        } catch (err) {
          this.logger.warn(
            { instance: row.name, err: (err as Error).message },
            'auto-start failed',
          );
        }
      }
    }
  }
}
