/**
 * Tracks recent crash timestamps per instance so automatic restarts can be
 * capped - without this, a server that crashes on every start (bad config,
 * corrupted world, missing file) would restart in a tight loop forever.
 */

export interface CrashRestartLimits {
  /** Restart at most this many times... */
  maxRestarts: number;
  /** ...within this rolling time window. */
  windowMs: number;
}

export class CrashRestartTracker {
  private history = new Map<string, number[]>();

  /** Records a crash and returns whether an automatic restart should be attempted. */
  recordAndCheck(instanceId: string, limits: CrashRestartLimits, now = Date.now()): boolean {
    const recent = (this.history.get(instanceId) ?? []).filter((ts) => now - ts < limits.windowMs);
    recent.push(now);
    this.history.set(instanceId, recent);
    return recent.length <= limits.maxRestarts;
  }

  reset(instanceId: string): void {
    this.history.delete(instanceId);
  }
}
