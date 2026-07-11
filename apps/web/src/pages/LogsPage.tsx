import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogEntryDto, LogLevel, LogsResponseDto } from '@gamedock/shared';
import { api } from '../api';
import { useSse } from '../hooks';

const MAX_LINES = 1000;
const LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 70,
};

export function LogsPage() {
  const [level, setLevel] = useState<LogLevel>('info');
  const [pendingLevel, setPendingLevel] = useState<LogLevel>('info');
  const [savingLevel, setSavingLevel] = useState(false);
  const [entries, setEntries] = useState<LogEntryDto[]>([]);
  const [filterLevel, setFilterLevel] = useState<LogLevel | ''>('');
  const [filterText, setFilterText] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .get<LogsResponseDto>('/api/system/logs?limit=500')
      .then((res) => {
        setLevel(res.level);
        setPendingLevel(res.level);
        setEntries(res.entries);
      })
      .catch(() => setError('Failed to load logs'));
  }, []);

  // Buffer incoming stream entries and commit on a short interval - one
  // render per SSE frame would make a debug-level stream render-bound.
  const pendingRef = useRef<LogEntryDto[]>([]);
  useSse('/api/system/logs/stream', (data) => {
    pendingRef.current.push(data as LogEntryDto);
    if (pendingRef.current.length > MAX_LINES) {
      pendingRef.current = pendingRef.current.slice(-MAX_LINES);
    }
  });
  useEffect(() => {
    const timer = setInterval(() => {
      if (pendingRef.current.length === 0) return;
      const batch = pendingRef.current;
      pendingRef.current = [];
      setEntries((prev) => {
        const next = [...prev, ...batch];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    }, 150);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const visible = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    const minLevel = filterLevel ? LEVEL_ORDER[filterLevel] : 0;
    return entries.filter((e) => {
      if (LEVEL_ORDER[e.level] < minLevel) return false;
      if (!needle) return true;
      return (
        e.msg.toLowerCase().includes(needle) || (e.component ?? '').toLowerCase().includes(needle)
      );
    });
  }, [entries, filterLevel, filterText]);

  const saveLevel = async () => {
    setSavingLevel(true);
    setError(null);
    try {
      const res = await api.patch<{ level: LogLevel }>('/api/system/logs/level', {
        level: pendingLevel,
      });
      setLevel(res.level);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change log level');
      setPendingLevel(level);
    } finally {
      setSavingLevel(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1>Logs</h1>
      </div>

      <div className="card form-card">
        <h2>Application log level</h2>
        <p className="muted">
          Applies immediately across the running process (no restart) and persists across
          restarts/updates. Raise it to <code>debug</code> or <code>trace</code> to see more detail
          below while diagnosing an issue.
        </p>
        <div className="form-row form-row-inline">
          <select
            value={pendingLevel}
            onChange={(e) => setPendingLevel(e.target.value as LogLevel)}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary"
            onClick={() => void saveLevel()}
            disabled={savingLevel || pendingLevel === level}
          >
            {savingLevel ? 'Saving...' : 'Apply'}
          </button>
          <span className="muted">Current: {level}</span>
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="console" style={{ marginTop: 16 }}>
        <div className="console-toolbar">
          <input
            placeholder="Filter by message or component..."
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            style={{ flex: 1, maxWidth: 320 }}
          />
          <select
            value={filterLevel}
            onChange={(e) => setFilterLevel(e.target.value as LogLevel | '')}
          >
            <option value="">All levels</option>
            {LEVELS.filter((l) => l !== 'silent').map((l) => (
              <option key={l} value={l}>
                {l}+
              </option>
            ))}
          </select>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
          <button className="btn btn-small" onClick={() => setEntries([])}>
            Clear view
          </button>
        </div>
        <div className="console-output log-output" ref={scrollRef}>
          {visible.length === 0 && <div className="console-empty">No log entries yet.</div>}
          {visible.map((entry, i) => (
            <div
              key={i}
              className={`log-line log-level-${entry.level}`}
              title={entry.extra ? JSON.stringify(entry.extra, null, 2) : undefined}
            >
              <span className="log-time">{new Date(entry.time).toLocaleTimeString()}</span>
              <span className={`log-badge log-level-${entry.level}`}>{entry.level}</span>
              {entry.component && <span className="log-component">{entry.component}</span>}
              <span className="log-msg">{entry.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
