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

/** Keep at most this much of the newest log output per job. */
const MAX_LOG_CHARS = 1_000_000;
/**
 * How often a running job's in-memory log is checkpointed to the DB.
 * SQLite rewrites the entire log cell on every UPDATE (O(logSize), not
 * O(new bytes)), so the write cadence - not the append size - is what
 * decides the I/O bill of a chatty steamcmd install. Viewers aren't
 * affected: SSE gets every line immediately and reads of a running job
 * are served from memory.
 */
const LOG_CHECKPOINT_MS = 5000;

/**
 * Minimal in-process job queue. One job runs at a time per instance
 * (enforced at enqueue), with a global concurrency limit. Jobs do not
 * survive restarts: on boot, leftover queued/running jobs are failed
 * (which also caps the log lost to a crash at one checkpoint interval).
 */
export class JobService {
  private queue: QueuedJob[] = [];
  private running = 0;
  private readonly maxConcurrent = 2;
  /** Full (capped) log of every currently-running job; the source of truth until it finishes. */
  private activeLogs = new Map<string, string>();

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

  /** The live log of a running job (fresher than the DB checkpoint), or null once finished. */
  currentLog(jobId: string): string | null {
    return this.activeLogs.get(jobId) ?? null;
  }

  private async execute(queued: QueuedJob): Promise<void> {
    const { id } = queued;
    await this.jobs.markStarted(id);
    await this.publishUpdate(id);

    // The running log lives in memory; the DB only sees a periodic
    // checkpoint (and the final state), see LOG_CHECKPOINT_MS.
    this.activeLogs.set(id, '');
    let dirty = false;
    let checkpointTimer: NodeJS.Timeout | null = null;
    const checkpoint = async () => {
      checkpointTimer = null;
      if (!dirty) return;
      dirty = false;
      await this.jobs.setLog(id, this.activeLogs.get(id) ?? '');
    };

    let lastProgressPublish = 0;
    const handle: JobHandle = {
      id,
      log: (line: string) => {
        const text = line.endsWith('\n') ? line : line + '\n';
        const current = this.activeLogs.get(id) ?? '';
        this.activeLogs.set(id, (current + text).slice(-MAX_LOG_CHARS));
        dirty = true;
        this.events.publishJobLog(id, text);
        if (!checkpointTimer) {
          checkpointTimer = setTimeout(() => {
            void checkpoint().catch((err) => {
              this.logger.warn(
                { jobId: id, err: (err as Error).message },
                'job log checkpoint failed',
              );
            });
          }, LOG_CHECKPOINT_MS);
          checkpointTimer.unref();
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
      await this.jobs.markFinished(id, 'succeeded');
      this.logger.info({ jobId: id }, 'job succeeded');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      handle.log(`ERROR: ${message}`);
      await this.jobs.markFinished(id, 'failed', message.slice(0, 500));
      this.logger.warn({ jobId: id, err: message }, 'job failed');
    } finally {
      if (checkpointTimer) clearTimeout(checkpointTimer);
      await checkpoint().catch((err) => {
        this.logger.warn({ jobId: id, err: (err as Error).message }, 'final job log write failed');
      });
      this.activeLogs.delete(id);
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
