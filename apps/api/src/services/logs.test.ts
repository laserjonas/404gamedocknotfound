import { afterEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { LogRingBuffer, LoggerRegistry, type LogEntry } from '../logger.js';
import { LogService } from './logs.js';
import type { SettingsRepository } from '../db/repositories/settings.js';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    time: 1000,
    level: 30,
    levelLabel: 'info',
    component: null,
    msg: 'hello',
    ...overrides,
  };
}

function fakeSettings(initial: Record<string, string> = {}): SettingsRepository {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: string) => void store.set(key, value),
    all: async () => Object.fromEntries(store),
  } as unknown as SettingsRepository;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LogService', () => {
  it('rejects an invalid level and leaves the registry/settings untouched', async () => {
    const root = pino({ level: 'info' }, { write: vi.fn() });
    const registry = new LoggerRegistry(root);
    const settings = fakeSettings();
    const service = new LogService(new LogRingBuffer(), registry, settings);

    await expect(service.setLevel('nonsense')).rejects.toThrow(/Invalid log level/);
    expect(registry.currentLevel()).toBe('info');
    await expect(settings.get('log_level')).resolves.toBeUndefined();
  });

  it('applies and persists a valid level change', async () => {
    const root = pino({ level: 'info' }, { write: vi.fn() });
    const registry = new LoggerRegistry(root);
    const settings = fakeSettings();
    const service = new LogService(new LogRingBuffer(), registry, settings);

    await service.setLevel('debug');

    expect(service.getLevel()).toBe('debug');
    await expect(settings.get('log_level')).resolves.toBe('debug');
  });

  it('restores a previously saved level on startup', async () => {
    const root = pino({ level: 'info' }, { write: vi.fn() });
    const registry = new LoggerRegistry(root);
    const settings = fakeSettings({ log_level: 'trace' });
    const service = new LogService(new LogRingBuffer(), registry, settings);

    await service.restoreLevel();

    expect(service.getLevel()).toBe('trace');
  });

  it('ignores a corrupt saved level rather than applying garbage', async () => {
    const root = pino({ level: 'info' }, { write: vi.fn() });
    const registry = new LoggerRegistry(root);
    const settings = fakeSettings({ log_level: 'not-a-level' });
    const service = new LogService(new LogRingBuffer(), registry, settings);

    await service.restoreLevel();

    expect(service.getLevel()).toBe('info');
  });

  it('filters recent entries by minimum level and component', () => {
    const buffer = new LogRingBuffer();
    buffer.push(entry({ msg: 'debug line', level: 20, levelLabel: 'debug', component: 'jobs' }));
    buffer.push(entry({ msg: 'info line', level: 30, levelLabel: 'info', component: 'instances' }));
    buffer.push(entry({ msg: 'warn line', level: 40, levelLabel: 'warn', component: 'jobs' }));

    const root = pino({ level: 'info' }, { write: vi.fn() });
    const service = new LogService(buffer, new LoggerRegistry(root), fakeSettings());

    const infoAndAbove = service.recent(50, 'info');
    expect(infoAndAbove.map((e) => e.msg)).toEqual(['info line', 'warn line']);

    const jobsOnly = service.recent(50, undefined, 'jobs');
    expect(jobsOnly.map((e) => e.msg)).toEqual(['debug line', 'warn line']);
  });

  it('notifies subscribers as new entries are pushed', () => {
    const buffer = new LogRingBuffer();
    const root = pino({ level: 'info' }, { write: vi.fn() });
    const service = new LogService(buffer, new LoggerRegistry(root), fakeSettings());

    const received: string[] = [];
    const unsubscribe = service.subscribe((e) => received.push(e.msg));
    buffer.push(entry({ msg: 'live line' }));
    unsubscribe();

    expect(received).toEqual(['live line']);
  });
});
