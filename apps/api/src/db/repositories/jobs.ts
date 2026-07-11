import { randomUUID } from 'node:crypto';
import type { JobStatus, JobType } from '@gamedock/shared';
import type { DatabaseClient } from '../database.js';
import { nowIso } from '../database.js';

export interface JobRow {
  id: string;
  type: JobType;
  status: JobStatus;
  instance_id: string | null;
  progress: number | null;
  message: string | null;
  log: string;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export class JobRepository {
  constructor(private db: DatabaseClient) {}

  async create(
    type: JobType,
    instanceId: string | null,
    createdBy: string | null,
  ): Promise<JobRow> {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO jobs (id, type, status, instance_id, created_by, created_at)
       VALUES (?, ?, 'queued', ?, ?, ?)`,
      [id, type, instanceId, createdBy, nowIso()],
    );
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<JobRow | undefined> {
    return this.db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
  }

  async list(limit = 50, instanceId?: string): Promise<JobRow[]> {
    if (instanceId) {
      return this.db.all<JobRow>(
        'SELECT * FROM jobs WHERE instance_id = ? ORDER BY created_at DESC LIMIT ?',
        [instanceId, limit],
      );
    }
    return this.db.all<JobRow>('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?', [limit]);
  }

  /** Any queued or running job blocks new jobs for the same instance. */
  async findActiveForInstance(instanceId: string): Promise<JobRow | undefined> {
    return this.db.get<JobRow>(
      "SELECT * FROM jobs WHERE instance_id = ? AND status IN ('queued', 'running') LIMIT 1",
      [instanceId],
    );
  }

  /** Any queued or running job of the given type (used for instance-less jobs like system_update). */
  async findActiveByType(type: JobType): Promise<JobRow | undefined> {
    return this.db.get<JobRow>(
      "SELECT * FROM jobs WHERE type = ? AND status IN ('queued', 'running') LIMIT 1",
      [type],
    );
  }

  async markStarted(id: string): Promise<void> {
    await this.db.run("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?", [
      nowIso(),
      id,
    ]);
  }

  async markFinished(
    id: string,
    status: 'succeeded' | 'failed' | 'canceled',
    message?: string,
  ): Promise<void> {
    await this.db.run('UPDATE jobs SET status = ?, finished_at = ?, message = ? WHERE id = ?', [
      status,
      nowIso(),
      message ?? null,
      id,
    ]);
  }

  async setProgress(id: string, progress: number | null, message?: string): Promise<void> {
    if (message !== undefined) {
      await this.db.run('UPDATE jobs SET progress = ?, message = ? WHERE id = ?', [
        progress,
        message,
        id,
      ]);
    } else {
      await this.db.run('UPDATE jobs SET progress = ? WHERE id = ?', [progress, id]);
    }
  }

  /**
   * Overwrites the stored log with the caller-maintained (already capped)
   * text. The running job's log of record lives in JobService's memory and
   * is only checkpointed here - an append-style UPDATE would make SQLite
   * rewrite the whole multi-hundred-KB cell per call anyway, so there is
   * nothing cheaper than a plain overwrite at checkpoint time.
   */
  async setLog(id: string, log: string): Promise<void> {
    await this.db.run('UPDATE jobs SET log = ? WHERE id = ?', [log, id]);
  }

  /** Called on startup: jobs cannot survive a process restart. */
  async failInterrupted(): Promise<number> {
    return (
      await this.db.run(
        `UPDATE jobs SET status = 'failed', finished_at = ?, message = 'Interrupted by GameDock restart'
       WHERE status IN ('queued', 'running')`,
        [nowIso()],
      )
    ).changes;
  }
}
