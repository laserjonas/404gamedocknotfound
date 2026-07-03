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
import type {
  InstancePortRow,
  InstanceRepository,
  InstanceRow,
} from '../db/repositories/instances.js';
import { nowIso } from '../db/database.js';
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

  private buildDto(
    row: InstanceRow,
    data: {
      ports: InstancePortRow[];
      envVars: Record<string, string>;
      variables: Record<string, string>;
      usage: InstanceDto['usage'];
    },
  ): InstanceDto {
    const template = this.templateOf(row);
    const status = this.effectiveStatus(row);
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
      ports: data.ports.map((p) => ({
        id: p.id,
        name: p.name,
        port: p.port,
        protocol: p.protocol,
      })),
      envVars: data.envVars,
      variables: this.redactSecretVariables(template, data.variables),
      pid: this.processes.pidOf(row.id),
      usage: data.usage,
      crashRestart: row.crash_restart === 1,
      backupIntervalHours: row.backup_interval_hours,
      backupRetentionCount: row.backup_retention_count,
      restartIntervalHours: row.restart_interval_hours,
      lastScheduledRestartAt: row.last_scheduled_restart_at,
    };
  }

  async toDto(row: InstanceRow, includeUsage = false): Promise<InstanceDto> {
    const [ports, envVars, variables, usage] = await Promise.all([
      this.repo.listPorts(row.id),
      this.repo.getEnvVars(row.id),
      this.repo.getVariables(row.id),
      includeUsage ? this.processes.usage(row.id) : Promise.resolve(null),
    ]);
    return this.buildDto(row, { ports, envVars, variables, usage });
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
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [portsByInstance, envVarsByInstance, variablesByInstance] = await Promise.all([
      this.repo.listPortsForInstances(ids),
      this.repo.getEnvVarsForInstances(ids),
      this.repo.getVariablesForInstances(ids),
    ]);
    return rows.map((row) =>
      this.buildDto(row, {
        ports: portsByInstance.get(row.id) ?? [],
        envVars: envVarsByInstance.get(row.id) ?? {},
        variables: variablesByInstance.get(row.id) ?? {},
        usage: null,
      }),
    );
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

    await this.provisionInstanceDirectory(row.id);

    return this.getRow(row.id);
  }

  /** Creates the instance directory and, if isolation is on, a dedicated Linux user. Shared by create() and clone(). */
  private async provisionInstanceDirectory(rowId: string): Promise<void> {
    await mkdir(this.instanceDir(rowId), { recursive: true });

    if (!this.linuxUsers.enabled) return;
    try {
      const { username, uid } = await this.linuxUsers.provision(rowId);
      await this.repo.update(rowId, { linuxUsername: username, linuxUid: uid });
    } catch (err) {
      // No silent fallback to the shared-user model - that would be a
      // security-relevant behavior change nobody would notice.
      await rm(this.instanceDir(rowId), { recursive: true, force: true }).catch(() => {});
      await this.repo.delete(rowId);
      throw new Error(
        `Failed to provision an isolated Linux user for this instance: ${(err as Error).message}`,
      );
    }
  }

  /** Duplicates an existing instance's config (template snapshot, variables, env vars, ports,
   * start/backup settings) into a new instance. The clone still needs its own install. */
  async clone(id: string, newName: string): Promise<InstanceRow> {
    const source = await this.getRow(id);
    if (!INSTANCE_NAME_RE.test(newName)) {
      throw badRequest('Instance name must be 2-64 characters (letters, digits, spaces, ._- only)');
    }
    if (await this.repo.findByName(newName)) {
      throw conflict(`An instance named "${newName}" already exists`);
    }

    const [variables, envVars, ports] = await Promise.all([
      this.repo.getVariables(source.id),
      this.repo.getEnvVars(source.id),
      this.repo.listPorts(source.id),
    ]);

    const row = await this.repo.create({
      name: newName,
      templateId: source.template_id,
      templateDefinition: source.template_definition,
    });

    await this.repo.replaceVariables(row.id, variables);
    await this.repo.replaceEnvVars(row.id, envVars);
    await this.repo.replacePorts(
      row.id,
      ports.map((p) => ({ name: p.name, port: p.port, protocol: p.protocol })),
    );
    await this.repo.update(row.id, {
      autoStart: source.auto_start === 1,
      crashRestart: source.crash_restart === 1,
      backupIntervalHours: source.backup_interval_hours,
      backupRetentionCount: source.backup_retention_count,
      restartIntervalHours: source.restart_interval_hours,
      startExecutable: source.start_executable,
      startArgs: source.start_args,
    });

    await this.provisionInstanceDirectory(row.id);

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
      ...(request.restartIntervalHours !== undefined
        ? { restartIntervalHours: request.restartIntervalHours, lastScheduledRestartAt: null }
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

  /**
   * Restarts every running instance whose restart schedule is due. Called
   * periodically, same cadence as runDueScheduledBackups().
   *
   * The first time a schedule is observed (no last_scheduled_restart_at yet -
   * either just configured, or the interval was just changed), the clock
   * starts from now without restarting immediately - a surprise restart the
   * moment someone enables this would be a much bigger interruption than an
   * unusually-early first scheduled backup.
   */
  async runDueScheduledRestarts(): Promise<void> {
    for (const row of await this.repo.list()) {
      if (!row.restart_interval_hours || row.installed !== 1) continue;
      if (!this.processes.isActive(row.id)) continue;
      if (await this.jobs.hasActiveJob(row.id)) continue;

      if (!row.last_scheduled_restart_at) {
        await this.repo.update(row.id, { lastScheduledRestartAt: nowIso() });
        continue;
      }
      const dueAt =
        new Date(row.last_scheduled_restart_at).getTime() +
        row.restart_interval_hours * 60 * 60 * 1000;
      if (Date.now() < dueAt) continue;

      try {
        this.logger.info({ instance: row.name }, 'scheduled restart due');
        await this.restart(row.id);
        await this.repo.update(row.id, { lastScheduledRestartAt: nowIso() });
      } catch (err) {
        this.logger.warn(
          { instanceId: row.id, err: (err as Error).message },
          'scheduled restart failed',
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
    const rows = await this.repo.list();
    for (const row of rows) {
      if (!['running', 'starting', 'stopping', 'installing'].includes(row.status)) continue;
      const reattached = await this.tryReattach(row);
      if (!reattached) {
        await this.repo.update(row.id, {
          status: row.installed === 1 ? 'stopped' : 'not_installed',
        });
      }
    }
    // auto_start/installed don't change above, and isActive() is checked
    // live per-row below - reusing the same fetch avoids a second query.
    for (const row of rows) {
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
