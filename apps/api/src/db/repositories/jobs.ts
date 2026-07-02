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

const MAX_LOG_CHARS = 1_000_000;

export class JobRepository {
  constructor(private db: DatabaseClient) {}

  create(type: JobType, instanceId: string | null, createdBy: string | null): JobRow {
    const id = randomUUID();
    this.db.run(
      `INSERT INTO jobs (id, type, status, instance_id, created_by, created_at)
       VALUES (?, ?, 'queued', ?, ?, ?)`,
      [id, type, instanceId, createdBy, nowIso()],
    );
    return this.findById(id)!;
  }

  findById(id: string): JobRow | undefined {
    return this.db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
  }

  list(limit = 50, instanceId?: string): JobRow[] {
    if (instanceId) {
      return this.db.all<JobRow>(
        'SELECT * FROM jobs WHERE instance_id = ? ORDER BY created_at DESC LIMIT ?',
        [instanceId, limit],
      );
    }
    return this.db.all<JobRow>('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?', [limit]);
  }

  /** Any queued or running job blocks new jobs for the same instance. */
  findActiveForInstance(instanceId: string): JobRow | undefined {
    return this.db.get<JobRow>(
      "SELECT * FROM jobs WHERE instance_id = ? AND status IN ('queued', 'running') LIMIT 1",
      [instanceId],
    );
  }

  markStarted(id: string): void {
    this.db.run("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?", [nowIso(), id]);
  }

  markFinished(id: string, status: 'succeeded' | 'failed' | 'canceled', message?: string): void {
    this.db.run('UPDATE jobs SET status = ?, finished_at = ?, message = ? WHERE id = ?', [
      status,
      nowIso(),
      message ?? null,
      id,
    ]);
  }

  setProgress(id: string, progress: number | null, message?: string): void {
    if (message !== undefined) {
      this.db.run('UPDATE jobs SET progress = ?, message = ? WHERE id = ?', [
        progress,
        message,
        id,
      ]);
    } else {
      this.db.run('UPDATE jobs SET progress = ? WHERE id = ?', [progress, id]);
    }
  }

  appendLog(id: string, text: string): void {
    // Keep at most MAX_LOG_CHARS of the newest output.
    this.db.run(`UPDATE jobs SET log = substr(log || ?, -${MAX_LOG_CHARS}) WHERE id = ?`, [
      text,
      id,
    ]);
  }

  /** Called on startup: jobs cannot survive a process restart. */
  failInterrupted(): number {
    return this.db.run(
      `UPDATE jobs SET status = 'failed', finished_at = ?, message = 'Interrupted by GameDock restart'
       WHERE status IN ('queued', 'running')`,
      [nowIso()],
    ).changes;
  }
}
