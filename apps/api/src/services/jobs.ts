import type { JobDto, JobType } from '@gamedock/shared';
import type { JobRepository, JobRow } from '../db/repositories/jobs.js';
import type { InstanceRepository } from '../db/repositories/instances.js';
import type { EventHub } from './events.js';
import type { Logger } from '../logger.js';
import { conflict } from '../errors.js';

export interface JobHandle {
  id: string;
  log(line: string): void;
  setProgress(percent: number | null, message?: string): void;
}

type JobRunner = (handle: JobHandle) => Promise<void>;

interface QueuedJob {
  id: string;
  runner: JobRunner;
}

export function toJobDto(row: JobRow, instanceName: string | null): JobDto {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    instanceId: row.instance_id,
    instanceName,
    progress: row.progress,
    message: row.message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdBy: row.created_by,
  };
}

/**
 * Minimal in-process job queue. One job runs at a time per instance
 * (enforced at enqueue), with a global concurrency limit. Jobs do not
 * survive restarts: on boot, leftover queued/running jobs are failed.
 */
export class JobService {
  private queue: QueuedJob[] = [];
  private running = 0;
  private readonly maxConcurrent = 2;

  constructor(
    private jobs: JobRepository,
    private instances: InstanceRepository,
    private events: EventHub,
    private logger: Logger,
  ) {}

  recoverAfterRestart(): void {
    const failed = this.jobs.failInterrupted();
    if (failed > 0) {
      this.logger.warn({ count: failed }, 'marked interrupted jobs as failed');
    }
  }

  instanceName(instanceId: string | null): string | null {
    if (!instanceId) return null;
    return this.instances.findById(instanceId)?.name ?? null;
  }

  dto(row: JobRow): JobDto {
    return toJobDto(row, this.instanceName(row.instance_id));
  }

  hasActiveJob(instanceId: string): boolean {
    return this.jobs.findActiveForInstance(instanceId) !== undefined;
  }

  enqueue(
    type: JobType,
    instanceId: string | null,
    createdBy: string | null,
    runner: JobRunner,
  ): JobRow {
    if (instanceId) {
      const active = this.jobs.findActiveForInstance(instanceId);
      if (active) {
        throw conflict(
          `Another operation (${active.type}) is already ${active.status} for this server`,
        );
      }
    }
    const row = this.jobs.create(type, instanceId, createdBy);
    this.publishUpdate(row.id);
    this.queue.push({ id: row.id, runner });
    queueMicrotask(() => this.pump());
    return row;
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.running += 1;
      void this.execute(next).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async execute(queued: QueuedJob): Promise<void> {
    const { id } = queued;
    this.jobs.markStarted(id);
    this.publishUpdate(id);

    // Batch log writes: SQLite update per line would be wasteful for steamcmd.
    let pendingLog = '';
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = () => {
      if (pendingLog) {
        this.jobs.appendLog(id, pendingLog);
        pendingLog = '';
      }
      flushTimer = null;
    };

    let lastProgressPublish = 0;
    const handle: JobHandle = {
      id,
      log: (line: string) => {
        const text = line.endsWith('\n') ? line : line + '\n';
        pendingLog += text;
        this.events.publishJobLog(id, text);
        if (!flushTimer) {
          flushTimer = setTimeout(flush, 500);
          flushTimer.unref();
        }
      },
      setProgress: (percent, message) => {
        this.jobs.setProgress(id, percent, message);
        // Throttle SSE updates to at most ~4/second.
        const now = Date.now();
        if (now - lastProgressPublish > 250) {
          lastProgressPublish = now;
          this.publishUpdate(id);
        }
      },
    };

    try {
      await queued.runner(handle);
      flush();
      this.jobs.markFinished(id, 'succeeded');
      this.logger.info({ jobId: id }, 'job succeeded');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      handle.log(`ERROR: ${message}`);
      flush();
      this.jobs.markFinished(id, 'failed', message.slice(0, 500));
      this.logger.warn({ jobId: id, err: message }, 'job failed');
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      this.publishUpdate(id);
    }
  }

  private publishUpdate(id: string): void {
    const row = this.jobs.findById(id);
    if (row) {
      this.events.publish({ kind: 'job_update', job: this.dto(row) });
    }
  }
}
