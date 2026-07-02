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

  list(): InstanceRow[] {
    return this.db.all<InstanceRow>('SELECT * FROM server_instances ORDER BY name');
  }

  findById(id: string): InstanceRow | undefined {
    return this.db.get<InstanceRow>('SELECT * FROM server_instances WHERE id = ?', [id]);
  }

  findByName(name: string): InstanceRow | undefined {
    return this.db.get<InstanceRow>('SELECT * FROM server_instances WHERE name = ?', [name]);
  }

  create(params: { name: string; templateId: string; templateDefinition: string }): InstanceRow {
    const id = randomUUID();
    const now = nowIso();
    this.db.run(
      `INSERT INTO server_instances (id, name, template_id, template_definition, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'not_installed', ?, ?)`,
      [id, params.name, params.templateId, params.templateDefinition, now, now],
    );
    return this.findById(id)!;
  }

  update(
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
    }>,
  ): void {
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
    this.db.run(`UPDATE server_instances SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM server_instances WHERE id = ?', [id]);
  }

  // --- ports ---------------------------------------------------------------

  listPorts(instanceId: string): InstancePortRow[] {
    return this.db.all<InstancePortRow>(
      'SELECT * FROM instance_ports WHERE instance_id = ? ORDER BY port',
      [instanceId],
    );
  }

  replacePorts(
    instanceId: string,
    ports: { name: string; port: number; protocol: PortProtocol }[],
  ): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM instance_ports WHERE instance_id = ?', [instanceId]);
      for (const p of ports) {
        this.db.run(
          'INSERT INTO instance_ports (id, instance_id, name, port, protocol) VALUES (?, ?, ?, ?, ?)',
          [randomUUID(), instanceId, p.name, p.port, p.protocol],
        );
      }
    });
  }

  // --- env vars & template variables ---------------------------------------

  getEnvVars(instanceId: string): Record<string, string> {
    const rows = this.db.all<KeyValueRow>(
      'SELECT * FROM instance_env_vars WHERE instance_id = ? ORDER BY key',
      [instanceId],
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  replaceEnvVars(instanceId: string, envVars: Record<string, string>): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM instance_env_vars WHERE instance_id = ?', [instanceId]);
      for (const [key, value] of Object.entries(envVars)) {
        this.db.run(
          'INSERT INTO instance_env_vars (id, instance_id, key, value) VALUES (?, ?, ?, ?)',
          [randomUUID(), instanceId, key, value],
        );
      }
    });
  }

  getVariables(instanceId: string): Record<string, string> {
    const rows = this.db.all<KeyValueRow>(
      'SELECT * FROM instance_variables WHERE instance_id = ? ORDER BY key',
      [instanceId],
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  replaceVariables(instanceId: string, variables: Record<string, string>): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM instance_variables WHERE instance_id = ?', [instanceId]);
      for (const [key, value] of Object.entries(variables)) {
        this.db.run(
          'INSERT INTO instance_variables (id, instance_id, key, value) VALUES (?, ?, ?, ?)',
          [randomUUID(), instanceId, key, value],
        );
      }
    });
  }
}
