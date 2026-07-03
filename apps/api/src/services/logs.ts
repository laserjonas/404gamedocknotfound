import type { LogEntryDto, LogLevel } from '@gamedock/shared';
import type { LogEntry, LogRingBuffer, LoggerRegistry } from '../logger.js';
import type { SettingsRepository } from '../db/repositories/settings.js';
import { badRequest } from '../errors.js';

const SETTINGS_KEY = 'log_level';
const LEVEL_VALUES: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Infinity,
};
const VALID_LEVELS = Object.keys(LEVEL_VALUES) as LogLevel[];

function toDto(entry: LogEntry): LogEntryDto {
  return {
    time: entry.time,
    level: (entry.levelLabel as LogLevel) ?? 'info',
    component: entry.component,
    msg: entry.msg,
    extra: entry.extra,
  };
}

/**
 * Runtime-adjustable log verbosity + an in-app view of recent structured
 * logs, so raising the level to debug/trace is actually useful without SSH +
 * journalctl. The chosen level is persisted (via SettingsRepository) so it
 * survives restarts and self-updates.
 */
export class LogService {
  constructor(
    private buffer: LogRingBuffer,
    private registry: LoggerRegistry,
    private settings: SettingsRepository,
  ) {}

  /** Applies a previously-saved level, if any. Call once at startup before creating component child loggers. */
  async restoreLevel(): Promise<void> {
    const saved = await this.settings.get(SETTINGS_KEY);
    if (saved && VALID_LEVELS.includes(saved as LogLevel)) {
      this.registry.setLevel(saved);
    }
  }

  getLevel(): LogLevel {
    return this.registry.currentLevel() as LogLevel;
  }

  async setLevel(level: string): Promise<void> {
    if (!VALID_LEVELS.includes(level as LogLevel)) {
      throw badRequest(`Invalid log level "${level}". Must be one of: ${VALID_LEVELS.join(', ')}`);
    }
    this.registry.setLevel(level);
    await this.settings.set(SETTINGS_KEY, level);
  }

  recent(limit: number, level?: LogLevel, component?: string): LogEntryDto[] {
    const minLevel = level ? LEVEL_VALUES[level] : 0;
    return this.buffer
      .recent()
      .filter((e) => e.level >= minLevel && (!component || e.component === component))
      .slice(-limit)
      .map(toDto);
  }

  subscribe(onEntry: (entry: LogEntryDto) => void): () => void {
    return this.buffer.subscribe((entry) => onEntry(toDto(entry)));
  }
}
