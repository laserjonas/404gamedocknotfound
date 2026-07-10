/**
 * Minimal promise-chain mutex. Callers queue behind each other in FIFO order;
 * a throwing task releases the lock like any other. Used to serialize
 * read-then-write critical sections (e.g. port allocation) that would race
 * when two requests interleave between their awaits.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
