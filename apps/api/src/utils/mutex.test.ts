import { describe, expect, it } from 'vitest';
import { Mutex } from './mutex.js';

describe('Mutex', () => {
  it('serializes overlapping critical sections in FIFO order', async () => {
    const mutex = new Mutex();
    const events: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const first = mutex.runExclusive(async () => {
      events.push('first:start');
      await sleep(20);
      events.push('first:end');
      return 1;
    });
    const second = mutex.runExclusive(async () => {
      events.push('second:start');
      return 2;
    });

    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('releases the lock when a task throws', async () => {
    const mutex = new Mutex();
    await expect(
      mutex.runExclusive(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // A poisoned lock would make this hang forever.
    expect(await mutex.runExclusive(async () => 'still works')).toBe('still works');
  });
});
