import { randomUUID } from 'node:crypto';
import type { InstanceStatus, PortProtocol } from '@gamedock/shared';
import type { DatabaseClient } from '../database.js';
import { nowIso } from '../database.js';

export interface InstanceRow {
  id: string;
  name: string;
  template_id: string;
  template_definition: string;
  status: InstanceStatus;
  installed: number;
  auto_start: number;
  start_executable: string | null;
  start_args: string | null;
  last_pid: number | null;
  crash_restart: number;
  backup_interval_hours: number | null;
  backup_retention_count: number | null;
  restart_interval_hours: number | null;
  last_scheduled_restart_at: string | null;
  linux_username: string | null;
  linux_uid: number | null;
  created_at: string;
  updated_at: string;
}

export interface InstancePortRow {
  id: string;
  instance_id: string;
  name: string;
  port: number;
  protocol: PortProtocol;
}

export interface KeyValueRow {
  id: string;
  instance_id: string;
  key: string;
  value: string;
}

export class InstanceRepository {
  constructor(private db: DatabaseClient) {}

  async list(): Promise<InstanceRow[]> {
    return this.db.all<InstanceRow>('SELECT * FROM server_instances ORDER BY name');
  }

  /** Cheaper than list().length for callers that only need the count. */
  async count(): Promise<number> {
    const row = await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM server_instances');
    return row?.n ?? 0;
  }

  async findById(id: string): Promise<InstanceRow | undefined> {
    return this.db.get<InstanceRow>('SELECT * FROM server_instances WHERE id = ?', [id]);
  }

  async findByName(name: string): Promise<InstanceRow | undefined> {
    return this.db.get<InstanceRow>('SELECT * FROM server_instances WHERE name = ?', [name]);
  }

  async create(params: {
    name: string;
    templateId: string;
    templateDefinition: string;
  }): Promise<InstanceRow> {
    const id = randomUUID();
    const now = nowIso();
    await this.db.run(
      `INSERT INTO server_instances (id, name, template_id, template_definition, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'not_installed', ?, ?)`,
      [id, params.name, params.templateId, params.templateDefinition, now, now],
    );
    return (await this.findById(id))!;
  }

  async update(
    id: string,
    patch: Partial<{
      name: string;
      status: InstanceStatus;
      installed: boolean;
      autoStart: boolean;
      startExecutable: string | null;
      startArgs: string | null;
      lastPid: number | null;
      templateDefinition: string;
      crashRestart: boolean;
      backupIntervalHours: number | null;
      backupRetentionCount: number | null;
      restartIntervalHours: number | null;
      lastScheduledRestartAt: string | null;
      linuxUsername: string | null;
      linuxUid: number | null;
    }>,
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const map: [keyof typeof patch, string, (v: unknown) => unknown][] = [
      ['name', 'name', (v) => v],
      ['status', 'status', (v) => v],
      ['installed', 'installed', (v) => (v ? 1 : 0)],
      ['autoStart', 'auto_start', (v) => (v ? 1 : 0)],
      ['startExecutable', 'start_executable', (v) => v],
      ['startArgs', 'start_args', (v) => v],
      ['lastPid', 'last_pid', (v) => v],
      ['templateDefinition', 'template_definition', (v) => v],
      ['crashRestart', 'crash_restart', (v) => (v ? 1 : 0)],
      ['backupIntervalHours', 'backup_interval_hours', (v) => v],
      ['backupRetentionCount', 'backup_retention_count', (v) => v],
      ['restartIntervalHours', 'restart_interval_hours', (v) => v],
      ['lastScheduledRestartAt', 'last_scheduled_restart_at', (v) => v],
      ['linuxUsername', 'linux_username', (v) => v],
      ['linuxUid', 'linux_uid', (v) => v],
    ];
    for (const [key, column, transform] of map) {
      if (key in patch) {
        sets.push(`${column} = ?`);
        params.push(transform(patch[key]));
      }
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(nowIso(), id);
    await this.db.run(`UPDATE server_instances SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  async delete(id: string): Promise<void> {
    await this.db.run('DELETE FROM server_instances WHERE id = ?', [id]);
  }

  // --- ports ---------------------------------------------------------------

  async listPorts(instanceId: string): Promise<InstancePortRow[]> {
    return this.db.all<InstancePortRow>(
      'SELECT * FROM instance_ports WHERE instance_id = ? ORDER BY port',
      [instanceId],
    );
  }

  /** Batched form of listPorts() for listing many instances at once (avoids N+1 queries). */
  async listPortsForInstances(instanceIds: string[]): Promise<Map<string, InstancePortRow[]>> {
    if (instanceIds.length === 0) return new Map();
    const placeholders = instanceIds.map(() => '?').join(', ');
    const rows = await this.db.all<InstancePortRow>(
      `SELECT * FROM instance_ports WHERE instance_id IN (${placeholders}) ORDER BY port`,
      instanceIds,
    );
    const map = new Map<string, InstancePortRow[]>();
    for (const row of rows) {
      const list = map.get(row.instance_id);
      if (list) list.push(row);
      else map.set(row.instance_id, [row]);
    }
    return map;
  }

  async replacePorts(
    instanceId: string,
    ports: { name: string; port: number; protocol: PortProtocol }[],
  ): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.run('DELETE FROM instance_ports WHERE instance_id = ?', [instanceId]);
      for (const p of ports) {
        await this.db.run(
          'INSERT INTO instance_ports (id, instance_id, name, port, protocol) VALUES (?, ?, ?, ?, ?)',
          [randomUUID(), instanceId, p.name, p.port, p.protocol],
        );
      }
    });
  }

  // --- env vars & template variables ---------------------------------------

  async getEnvVars(instanceId: string): Promise<Record<string, string>> {
    const rows = await this.db.all<KeyValueRow>(
      'SELECT * FROM instance_env_vars WHERE instance_id = ? ORDER BY key',
      [instanceId],
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /** Batched form of getEnvVars() for listing many instances at once (avoids N+1 queries). */
  async getEnvVarsForInstances(
    instanceIds: string[],
  ): Promise<Map<string, Record<string, string>>> {
    if (instanceIds.length === 0) return new Map();
    const placeholders = instanceIds.map(() => '?').join(', ');
    const rows = await this.db.all<KeyValueRow>(
      `SELECT * FROM instance_env_vars WHERE instance_id IN (${placeholders}) ORDER BY key`,
      instanceIds,
    );
    return groupKeyValueRowsByInstance(rows);
  }

  async replaceEnvVars(instanceId: string, envVars: Record<string, string>): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.run('DELETE FROM instance_env_vars WHERE instance_id = ?', [instanceId]);
      for (const [key, value] of Object.entries(envVars)) {
        await this.db.run(
          'INSERT INTO instance_env_vars (id, instance_id, key, value) VALUES (?, ?, ?, ?)',
          [randomUUID(), instanceId, key, value],
        );
      }
    });
  }

  async getVariables(instanceId: string): Promise<Record<string, string>> {
    const rows = await this.db.all<KeyValueRow>(
      'SELECT * FROM instance_variables WHERE instance_id = ? ORDER BY key',
      [instanceId],
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /** Batched form of getVariables() for listing many instances at once (avoids N+1 queries). */
  async getVariablesForInstances(
    instanceIds: string[],
  ): Promise<Map<string, Record<string, string>>> {
    if (instanceIds.length === 0) return new Map();
    const placeholders = instanceIds.map(() => '?').join(', ');
    const rows = await this.db.all<KeyValueRow>(
      `SELECT * FROM instance_variables WHERE instance_id IN (${placeholders}) ORDER BY key`,
      instanceIds,
    );
    return groupKeyValueRowsByInstance(rows);
  }

  async replaceVariables(instanceId: string, variables: Record<string, string>): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.run('DELETE FROM instance_variables WHERE instance_id = ?', [instanceId]);
      for (const [key, value] of Object.entries(variables)) {
        await this.db.run(
          'INSERT INTO instance_variables (id, instance_id, key, value) VALUES (?, ?, ?, ?)',
          [randomUUID(), instanceId, key, value],
        );
      }
    });
  }
}

function groupKeyValueRowsByInstance(rows: KeyValueRow[]): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  for (const row of rows) {
    const existing = map.get(row.instance_id);
    if (existing) existing[row.key] = row.value;
    else map.set(row.instance_id, { [row.key]: row.value });
  }
  return map;
}
