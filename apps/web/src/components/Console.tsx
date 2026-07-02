import { useEffect, useRef, useState } from 'react';
import type { ConsoleLine } from '@gamedock/shared';
import { api } from '../api';
import { useSse } from '../hooks';
import { useAuth } from '../auth';

const MAX_LINES = 1000;

interface ConsoleProps {
  instanceId: string;
  running: boolean;
  supportsInput: boolean;
}

export function Console({ instanceId, running, supportsInput }: ConsoleProps) {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [command, setCommand] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { hasRole } = useAuth();

  // Load history from the log file for stopped servers; while running the
  // SSE stream replays the live buffer itself.
  useEffect(() => {
    if (running) return;
    let cancelled = false;
    setLines([]);
    api
      .get<{ lines: ConsoleLine[] }>(`/api/instances/${instanceId}/logs`)
      .then((data) => {
        if (!cancelled) setLines(data.lines.slice(-MAX_LINES));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [instanceId, running]);

  // Live stream while running (the stream replays the in-memory buffer, so
  // reset to avoid duplicates on connect).
  useSse(running ? `/api/instances/${instanceId}/logs/stream` : null, (data) => {
    const line = data as ConsoleLine;
    setLines((prev) => {
      const next = [...prev, line];
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
    });
  });
  useEffect(() => {
    if (running) setLines([]);
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
      setCommand('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send command');
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
        {lines.map((line, i) => (
          <div key={i} className={`console-line stream-${line.stream}`}>
            {line.line}
          </div>
        ))}
      </div>
      {supportsInput && hasRole('operator') && (
        <div className="console-input">
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send();
            }}
            placeholder={running ? 'Type a server command and press Enter' : 'Server is stopped'}
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
