import { useEffect, useRef, useState } from 'react';
import type { JobDto } from '@gamedock/shared';
import { api } from '../api';
import { JobBadge } from './StatusBadge';

const MAX_LOG_CHARS = 200_000;
/** How often buffered SSE log text is committed to React state. */
const FLUSH_INTERVAL_MS = 150;

/** Modal that follows a job's log output live via SSE. */
export function JobLogModal({ jobId, onClose }: { jobId: string; onClose(): void }) {
  const [job, setJob] = useState<JobDto | null>(null);
  const [log, setLog] = useState('');
  const pendingRef = useRef('');
  const scrollRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<JobDto & { log: string }>(`/api/jobs/${jobId}`)
      .then((data) => {
        if (cancelled) return;
        setJob(data);
      })
      .catch(() => {});

    // Incoming log lines are buffered and committed on an interval: a chatty
    // job (steamcmd) emits one SSE frame per line, and doing an O(200 KB)
    // string reslice + render per frame made the modal itself the hot spot.
    pendingRef.current = '';
    const source = new EventSource(`/api/jobs/${jobId}/stream`);
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as { text: string };
        pendingRef.current += data.text;
        if (pendingRef.current.length > MAX_LOG_CHARS) {
          pendingRef.current = pendingRef.current.slice(-MAX_LOG_CHARS);
        }
      } catch {
        // ignore
      }
    };
    source.addEventListener('job', (event) => {
      try {
        setJob(JSON.parse((event as MessageEvent).data as string) as JobDto);
      } catch {
        // ignore
      }
    });
    const flushTimer = setInterval(() => {
      if (!pendingRef.current) return;
      const chunk = pendingRef.current;
      pendingRef.current = '';
      setLog((prev) => (prev + chunk).slice(-MAX_LOG_CHARS));
    }, FLUSH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(flushTimer);
      source.close();
    };
  }, [jobId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [log]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3>
          {job ? `${job.type} job` : 'Job'} {job && <JobBadge status={job.status} />}
          {job?.progress != null && job.status === 'running' && (
            <span className="job-progress"> {job.progress.toFixed(0)}%</span>
          )}
        </h3>
        {job?.message && <div className="job-message">{job.message}</div>}
        <pre className="job-log" ref={scrollRef}>
          {log || 'Waiting for output...'}
        </pre>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
