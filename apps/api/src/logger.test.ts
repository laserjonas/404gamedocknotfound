import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { LogRingBuffer, LoggerRegistry, type LogEntry } from './logger.js';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    time: Date.now(),
    level: 30,
    levelLabel: 'info',
    component: null,
    msg: 'hello',
    ...overrides,
  };
}

describe('LogRingBuffer', () => {
  it('returns pushed entries in order', () => {
    const buffer = new LogRingBuffer();
    buffer.push(entry({ msg: 'first' }));
    buffer.push(entry({ msg: 'second' }));

    expect(buffer.recent().map((e) => e.msg)).toEqual(['first', 'second']);
  });

  it('evicts the oldest entries once the ring is full', () => {
    const buffer = new LogRingBuffer();
    for (let i = 0; i < 2005; i++) buffer.push(entry({ msg: `line-${i}` }));

    const recent = buffer.recent();
    expect(recent.length).toBe(2000);
    expect(recent[0]?.msg).toBe('line-5');
    expect(recent.at(-1)?.msg).toBe('line-2004');
  });

  it('notifies subscribers of new entries and supports unsubscribing', () => {
    const buffer = new LogRingBuffer();
    const seen: string[] = [];
    const unsubscribe = buffer.subscribe((e) => seen.push(e.msg));

    buffer.push(entry({ msg: 'a' }));
    unsubscribe();
    buffer.push(entry({ msg: 'b' }));

    expect(seen).toEqual(['a']);
  });
});

describe('LoggerRegistry', () => {
  it('updates the level of every registered logger, including children registered before the change', () => {
    const root = pino({ level: 'info' }, { write: vi.fn() });
    const registry = new LoggerRegistry(root);
    const child = registry.register(root.child({ component: 'test' }));

    expect(child.level).toBe('info');
    registry.setLevel('debug');

    expect(root.level).toBe('debug');
    expect(child.level).toBe('debug');
  });

  it('reports the root logger level via currentLevel', () => {
    const root = pino({ level: 'warn' }, { write: vi.fn() });
    const registry = new LoggerRegistry(root);

    expect(registry.currentLevel()).toBe('warn');
  });
});
