import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '../database.js';
import { nowIso } from '../database.js';

export interface BackupRow {
  id: string;
  instance_id: string;
  file_name: string;
  size_bytes: number;
  note: string | null;
  created_at: string;
}

export class BackupRepository {
  constructor(private db: DatabaseClient) {}

  async create(
    instanceId: string,
    fileName: string,
    sizeBytes: number,
    note: string | null,
  ): Promise<BackupRow> {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO backups (id, instance_id, file_name, size_bytes, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, instanceId, fileName, sizeBytes, note, nowIso()],
    );
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<BackupRow | undefined> {
    return this.db.get<BackupRow>('SELECT * FROM backups WHERE id = ?', [id]);
  }

  async listForInstance(instanceId: string): Promise<BackupRow[]> {
    return this.db.all<BackupRow>(
      'SELECT * FROM backups WHERE instance_id = ? ORDER BY created_at DESC',
      [instanceId],
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.run('DELETE FROM backups WHERE id = ?', [id]);
  }
}
