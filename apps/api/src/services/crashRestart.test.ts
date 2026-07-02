import { describe, expect, it } from 'vitest';
import { CrashRestartTracker } from './crashRestart.js';

describe('CrashRestartTracker', () => {
  it('allows restarts up to the configured limit within the window', () => {
    const tracker = new CrashRestartTracker();
    const limits = { maxRestarts: 3, windowMs: 60_000 };
    let now = 0;

    expect(tracker.recordAndCheck('a', limits, (now += 1000))).toBe(true);
    expect(tracker.recordAndCheck('a', limits, (now += 1000))).toBe(true);
    expect(tracker.recordAndCheck('a', limits, (now += 1000))).toBe(true);
    // 4th crash within the window exceeds maxRestarts
    expect(tracker.recordAndCheck('a', limits, (now += 1000))).toBe(false);
  });

  it('forgets crashes once they age out of the window', () => {
    const tracker = new CrashRestartTracker();
    const limits = { maxRestarts: 1, windowMs: 10_000 };

    expect(tracker.recordAndCheck('a', limits, 0)).toBe(true);
    expect(tracker.recordAndCheck('a', limits, 1000)).toBe(false);
    // Well past the window - the earlier crashes no longer count.
    expect(tracker.recordAndCheck('a', limits, 20_000)).toBe(true);
  });

  it('tracks instances independently', () => {
    const tracker = new CrashRestartTracker();
    const limits = { maxRestarts: 1, windowMs: 60_000 };

    expect(tracker.recordAndCheck('a', limits, 0)).toBe(true);
    expect(tracker.recordAndCheck('b', limits, 0)).toBe(true);
    expect(tracker.recordAndCheck('a', limits, 100)).toBe(false);
    expect(tracker.recordAndCheck('b', limits, 100)).toBe(false);
  });

  it('reset clears history for an instance', () => {
    const tracker = new CrashRestartTracker();
    const limits = { maxRestarts: 1, windowMs: 60_000 };

    expect(tracker.recordAndCheck('a', limits, 0)).toBe(true);
    expect(tracker.recordAndCheck('a', limits, 100)).toBe(false);
    tracker.reset('a');
    expect(tracker.recordAndCheck('a', limits, 200)).toBe(true);
  });
});
