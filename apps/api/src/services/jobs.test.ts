import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { JobStatus, JobType } from '@gamedock/shared';
import { JobService } from './jobs.js';
import { EventHub } from './events.js';
import type { JobRepository, JobRow } from '../db/repositories/jobs.js';
import type { InstanceRepository } from '../db/repositories/instances.js';

const logger = pino({ level: 'silent' });

function fakeJobRepo() {
  const rows = new Map<string, JobRow>();
  let setLogCalls = 0;
  const repo = {
    create: async (type: JobType, instanceId: string | null, createdBy: string | null) => {
      const row: JobRow = {
        id: `job-${rows.size + 1}`,
        type,
        status: 'queued',
        instance_id: instanceId,
        progress: null,
        message: null,
        log: '',
        created_by: createdBy,
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
      };
      rows.set(row.id, row);
      return row;
    },
    findById: async (id: string) => rows.get(id),
    list: async () => [...rows.values()],
    findActiveForInstance: async () => undefined,
    findActiveByType: async () => undefined,
    markStarted: async (id: string) => {
      rows.get(id)!.status = 'running';
    },
    markFinished: async (id: string, status: JobStatus, message?: string) => {
      const row = rows.get(id)!;
      row.status = status;
      row.message = message ?? null;
    },
    setProgress: async () => {},
    setLog: async (id: string, log: string) => {
      setLogCalls += 1;
      rows.get(id)!.log = log;
    },
    failInterrupted: async () => 0,
  } as unknown as JobRepository;
  return { repo, rows, getSetLogCalls: () => setLogCalls };
}

const fakeInstances = { findById: async () => undefined } as unknown as InstanceRepository;

async function waitForStatus(rows: Map<string, JobRow>, id: string, status: JobStatus) {
  for (let i = 0; i < 50 && rows.get(id)!.status !== status; i++) {
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(rows.get(id)!.status).toBe(status);
}

describe('JobService log checkpointing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves the running log from memory and checkpoints the DB at most once per window', async () => {
    vi.useFakeTimers();
    const { repo, rows, getSetLogCalls } = fakeJobRepo();
    const service = new JobService(repo, fakeInstances, new EventHub(), logger);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const row = await service.enqueue('backup', null, null, async (handle) => {
      for (let i = 0; i < 100; i++) handle.log(`line ${i}`);
      await gate;
      handle.log('final line');
    });
    await vi.advanceTimersByTimeAsync(0); // let the queue pump start the runner

    // 100 lines in: nothing persisted yet, but the live log is readable.
    expect(getSetLogCalls()).toBe(0);
    expect(rows.get(row.id)!.log).toBe('');
    expect(service.currentLog(row.id)).toContain('line 99');

    // One checkpoint window elapses -> exactly one DB write for 100 lines.
    await vi.advanceTimersByTimeAsync(5000);
    expect(getSetLogCalls()).toBe(1);
    expect(rows.get(row.id)!.log).toContain('line 0');
    expect(rows.get(row.id)!.log).toContain('line 99');

    release();
    await waitForStatus(rows, row.id, 'succeeded');

    // The final flush persisted the tail and the memory copy is gone.
    expect(rows.get(row.id)!.log).toContain('final line');
    expect(service.currentLog(row.id)).toBeNull();
  });

  it('persists everything even when the job finishes before the first checkpoint', async () => {
    vi.useFakeTimers();
    const { repo, rows, getSetLogCalls } = fakeJobRepo();
    const service = new JobService(repo, fakeInstances, new EventHub(), logger);

    const row = await service.enqueue('backup', null, null, async (handle) => {
      handle.log('only line');
    });
    await waitForStatus(rows, row.id, 'succeeded');

    expect(rows.get(row.id)!.log).toContain('only line');
    expect(getSetLogCalls()).toBe(1); // just the final flush
    expect(service.currentLog(row.id)).toBeNull();
  });
});
