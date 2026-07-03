import type { JobDto, JobType } from '@gamedock/shared';
import type { JobRepository, JobRow } from '../db/repositories/jobs.js';
import type { InstanceRepository } from '../db/repositories/instances.js';
import type { EventHub } from './events.js';
import type { Logger } from '../logger.js';
import { conflict } from '../errors.js';

export interface JobHandle {
  id: string;
  log(line: string): void;
  /**
   * Fire-and-forget by design (like ProcessStatusSink): progress reporting
   * happens from the middle of long install/backup loops that shouldn't
   * block on a DB write completing. Failures are logged, not thrown.
   */
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

  async recoverAfterRestart(): Promise<void> {
    const failed = await this.jobs.failInterrupted();
    if (failed > 0) {
      this.logger.warn({ count: failed }, 'marked interrupted jobs as failed');
    }
  }

  async instanceName(instanceId: string | null): Promise<string | null> {
    if (!instanceId) return null;
    const row = await this.instances.findById(instanceId);
    return row?.name ?? null;
  }

  async dto(row: JobRow): Promise<JobDto> {
    return toJobDto(row, await this.instanceName(row.instance_id));
  }

  async hasActiveJob(instanceId: string): Promise<boolean> {
    return (await this.jobs.findActiveForInstance(instanceId)) !== undefined;
  }

  async enqueue(
    type: JobType,
    instanceId: string | null,
    createdBy: string | null,
    runner: JobRunner,
  ): Promise<JobRow> {
    if (instanceId) {
      const active = await this.jobs.findActiveForInstance(instanceId);
      if (active) {
        throw conflict(
          `Another operation (${active.type}) is already ${active.status} for this server`,
        );
      }
    }
    const row = await this.jobs.create(type, instanceId, createdBy);
    await this.publishUpdate(row.id);
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
    await this.jobs.markStarted(id);
    await this.publishUpdate(id);

    // Batch log writes: SQLite update per line would be wasteful for steamcmd.
    let pendingLog = '';
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = async () => {
      if (pendingLog) {
        const text = pendingLog;
        pendingLog = '';
        await this.jobs.appendLog(id, text);
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
          flushTimer = setTimeout(() => {
            void flush().catch((err) => {
              this.logger.warn({ jobId: id, err: (err as Error).message }, 'job log flush failed');
            });
          }, 500);
          flushTimer.unref();
        }
      },
      setProgress: (percent, message) => {
        void this.jobs.setProgress(id, percent, message).catch((err) => {
          this.logger.warn(
            { jobId: id, err: (err as Error).message },
            'failed to persist job progress',
          );
        });
        // Throttle SSE updates to at most ~4/second.
        const now = Date.now();
        if (now - lastProgressPublish > 250) {
          lastProgressPublish = now;
          void this.publishUpdate(id).catch(() => {});
        }
      },
    };

    try {
      await queued.runner(handle);
      await flush();
      await this.jobs.markFinished(id, 'succeeded');
      this.logger.info({ jobId: id }, 'job succeeded');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      handle.log(`ERROR: ${message}`);
      await flush();
      await this.jobs.markFinished(id, 'failed', message.slice(0, 500));
      this.logger.warn({ jobId: id, err: message }, 'job failed');
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
      await flush();
      await this.publishUpdate(id);
    }
  }

  private async publishUpdate(id: string): Promise<void> {
    const row = await this.jobs.findById(id);
    if (row) {
      this.events.publish({ kind: 'job_update', job: await this.dto(row) });
    }
  }
}
