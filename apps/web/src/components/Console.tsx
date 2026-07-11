import { useEffect, useRef, useState } from 'react';
import type { CommandHistoryEntryDto, ConsoleLine } from '@gamedock/shared';
import { api } from '../api';
import { useSse } from '../hooks';
import { useAuth } from '../auth';

const MAX_LINES = 1000;
/** How often buffered incoming lines are committed to React state. */
const FLUSH_INTERVAL_MS = 100;

interface ConsoleProps {
  instanceId: string;
  running: boolean;
  supportsInput: boolean;
}

/** A console line with a stable identity for React keys - index keys would
 * remap every row once the ring cap is hit, reconciling all 1000 rows per
 * incoming line. */
interface SeqLine {
  seq: number;
  line: ConsoleLine;
}

export function Console({ instanceId, running, supportsInput }: ConsoleProps) {
  const [lines, setLines] = useState<SeqLine[]>([]);
  const pendingRef = useRef<SeqLine[]>([]);
  const seqRef = useRef(0);
  const [command, setCommand] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { hasRole } = useAuth();

  // Command recall (up/down arrow, like a shell history): -1 means "not
  // currently browsing history" - the user is editing a fresh command.
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const draftRef = useRef('');

  useEffect(() => {
    setHistory([]);
    setHistoryIndex(-1);
    api
      .get<CommandHistoryEntryDto[]>(`/api/instances/${instanceId}/commands/history`)
      .then((entries) => setHistory(entries.map((e) => e.command)))
      .catch(() => {});
  }, [instanceId]);

  const withSeqs = (incoming: ConsoleLine[]): SeqLine[] =>
    incoming.map((line) => ({ seq: seqRef.current++, line }));

  // Load history from the log file for stopped servers; while running the
  // SSE stream replays the live buffer itself.
  useEffect(() => {
    if (running) return;
    let cancelled = false;
    setLines([]);
    api
      .get<{ lines: ConsoleLine[] }>(`/api/instances/${instanceId}/logs`)
      .then((data) => {
        if (!cancelled) setLines(withSeqs(data.lines.slice(-MAX_LINES)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [instanceId, running]);

  // Live stream while running. Frames carry an array of lines (the replay
  // backlog and one batch per server poll tick); they are buffered in a ref
  // and committed on a short interval, so a chatty server costs at most
  // ~10 renders/sec instead of one render per line.
  useSse(running ? `/api/instances/${instanceId}/logs/stream` : null, (data) => {
    const incoming = (Array.isArray(data) ? data : [data]) as ConsoleLine[];
    pendingRef.current.push(...withSeqs(incoming));
    // The pending buffer never needs more than the render cap.
    if (pendingRef.current.length > MAX_LINES) {
      pendingRef.current = pendingRef.current.slice(-MAX_LINES);
    }
  });
  useEffect(() => {
    if (!running) return;
    setLines([]);
    pendingRef.current = [];
    const timer = setInterval(() => {
      if (pendingRef.current.length === 0) return;
      const batch = pendingRef.current;
      pendingRef.current = [];
      setLines((prev) => {
        const next = [...prev, ...batch];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    }, FLUSH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running, instanceId]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const send = async () => {
    const cmd = command.trim();
    if (!cmd) return;
    setError(null);
    try {
      await api.post(`/api/instances/${instanceId}/command`, { command: cmd });
      setHistory((prev) => [cmd, ...prev]);
      setHistoryIndex(-1);
      draftRef.current = '';
      setCommand('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send command');
    }
  };

  const recallHistory = (direction: 'older' | 'newer') => {
    if (history.length === 0) return;
    if (direction === 'older') {
      if (historyIndex === -1) draftRef.current = command;
      const next = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(next);
      setCommand(history[next] ?? '');
    } else {
      if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setCommand(draftRef.current);
        return;
      }
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setCommand(history[next] ?? '');
    }
  };

  return (
    <div className="console">
      <div className="console-toolbar">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          Auto-scroll
        </label>
        <button className="btn btn-small" onClick={() => setLines([])}>
          Clear view
        </button>
      </div>
      <div className="console-output" ref={scrollRef}>
        {lines.length === 0 && <div className="console-empty">No output yet.</div>}
        {lines.map((entry) => (
          <div key={entry.seq} className={`console-line stream-${entry.line.stream}`}>
            {entry.line.line}
          </div>
        ))}
      </div>
      {supportsInput && hasRole('operator') && (
        <div className="console-input">
          <input
            value={command}
            onChange={(e) => {
              setCommand(e.target.value);
              setHistoryIndex(-1);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send();
              else if (e.key === 'ArrowUp') {
                e.preventDefault();
                recallHistory('older');
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                recallHistory('newer');
              }
            }}
            placeholder={
              running
                ? 'Type a server command and press Enter (↑/↓ for history)'
                : 'Server is stopped'
            }
            disabled={!running}
          />
          <button className="btn btn-primary" onClick={() => void send()} disabled={!running}>
            Send
          </button>
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
