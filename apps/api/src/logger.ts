import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';
import prettyFactory from 'pino-pretty';

/**
 * Structured log line captured off the live pino stream, independent of
 * whatever transport (stdout/journald) the process is also writing to. Kept
 * in an in-memory ring buffer so admins can inspect recent logs (and raise
 * verbosity to see more) from the web UI without SSH + journalctl.
 */
export interface LogEntry {
  time: number;
  /** Numeric pino level (10 trace ... 60 fatal). */
  level: number;
  levelLabel: string;
  component: string | null;
  msg: string;
  extra?: Record<string, unknown>;
}

const RING_BUFFER_SIZE = 2000;
/** Fields already surfaced on LogEntry, or noise (pid/hostname repeat on every line). */
const OMIT_FROM_EXTRA = new Set(['level', 'time', 'msg', 'component', 'pid', 'hostname', 'v']);

export class LogRingBuffer {
  // Fixed-size circular buffer: pushing past capacity overwrites the oldest
  // slot in place instead of Array.shift()'s O(n) re-index on every push.
  private entries: (LogEntry | undefined)[] = new Array(RING_BUFFER_SIZE);
  private nextIndex = 0;
  private size = 0;
  private listeners = new Set<(entry: LogEntry) => void>();

  push(entry: LogEntry): void {
    this.entries[this.nextIndex] = entry;
    this.nextIndex = (this.nextIndex + 1) % RING_BUFFER_SIZE;
    if (this.size < RING_BUFFER_SIZE) this.size++;
    for (const listener of this.listeners) listener(entry);
  }

  /** Oldest-to-newest, like Array.prototype.slice(-limit). */
  recent(limit = RING_BUFFER_SIZE): LogEntry[] {
    const count = Math.min(Math.max(limit, 0), this.size);
    const start = (this.nextIndex - count + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
    const result: LogEntry[] = [];
    for (let i = 0; i < count; i++) {
      result.push(this.entries[(start + i) % RING_BUFFER_SIZE]!);
    }
    return result;
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Parses the NDJSON pino writes into structured entries for the ring buffer. */
function ringBufferStream(buffer: LogRingBuffer): NodeJS.WritableStream {
  return new Writable({
    write(chunk: Buffer, _enc, callback) {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const level = typeof parsed.level === 'number' ? parsed.level : 30;
          const extra: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(parsed)) {
            if (!OMIT_FROM_EXTRA.has(key)) extra[key] = value;
          }
          buffer.push({
            time: typeof parsed.time === 'number' ? parsed.time : Date.now(),
            level,
            levelLabel: pino.levels.labels[level] ?? 'info',
            component: typeof parsed.component === 'string' ? parsed.component : null,
            msg: typeof parsed.msg === 'string' ? parsed.msg : '',
            extra: Object.keys(extra).length ? extra : undefined,
          });
        } catch {
          // Ignore lines that aren't valid JSON (shouldn't happen - pino always emits NDJSON).
        }
      }
      callback();
    },
  });
}

/**
 * Tracks every logger instance (root + `.child()`s) created for this
 * process. Pino children snapshot their parent's `.level` once at creation
 * time rather than following it live, so changing verbosity at runtime (e.g.
 * from the Settings page) requires updating every tracked instance, not just
 * the root logger.
 */
export class LoggerRegistry {
  private loggers: Logger[] = [];

  constructor(private root: Logger) {
    this.loggers.push(root);
  }

  /** Call after creating a `.child()` logger so future level changes reach it too. */
  register(logger: Logger): Logger {
    this.loggers.push(logger);
    return logger;
  }

  setLevel(level: string): void {
    for (const logger of this.loggers) logger.level = level;
  }

  currentLevel(): string {
    return this.root.level;
  }
}

export function createLogger(
  isProduction: boolean,
  ringBuffer: LogRingBuffer,
): { logger: Logger; registry: LoggerRegistry } {
  const targets = pino.multistream([
    { stream: isProduction ? process.stdout : prettyFactory({ colorize: true }), level: 'trace' },
    { stream: ringBufferStream(ringBuffer), level: 'trace' },
  ]);

  const logger = pino(
    {
      level: process.env.GAMEDOCK_LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
      // Never log values of these fields (defense in depth against secret leaks).
      redact: {
        paths: [
          'password',
          '*.password',
          'req.headers.authorization',
          'req.headers.cookie',
          'passwordHash',
          '*.passwordHash',
          'token',
          '*.token',
          'secret',
          '*.secret',
        ],
        censor: '[redacted]',
      },
    },
    targets,
  );

  return { logger, registry: new LoggerRegistry(logger) };
}

export type { Logger };
