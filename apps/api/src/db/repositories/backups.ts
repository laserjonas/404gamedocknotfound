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

  create(instanceId: string, fileName: string, sizeBytes: number, note: string | null): BackupRow {
    const id = randomUUID();
    this.db.run(
      `INSERT INTO backups (id, instance_id, file_name, size_bytes, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, instanceId, fileName, sizeBytes, note, nowIso()],
    );
    return this.findById(id)!;
  }

  findById(id: string): BackupRow | undefined {
    return this.db.get<BackupRow>('SELECT * FROM backups WHERE id = ?', [id]);
  }

  listForInstance(instanceId: string): BackupRow[] {
    return this.db.all<BackupRow>(
      'SELECT * FROM backups WHERE instance_id = ? ORDER BY created_at DESC',
      [instanceId],
    );
  }

  delete(id: string): void {
    this.db.run('DELETE FROM backups WHERE id = ?', [id]);
  }
}
