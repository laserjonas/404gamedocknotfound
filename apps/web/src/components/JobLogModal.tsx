import { useEffect, useRef, useState } from 'react';
import type { JobDto } from '@gamedock/shared';
import { api } from '../api';
import { JobBadge } from './StatusBadge';

/** Modal that follows a job's log output live via SSE. */
export function JobLogModal({ jobId, onClose }: { jobId: string; onClose(): void }) {
  const [job, setJob] = useState<JobDto | null>(null);
  const [log, setLog] = useState('');
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

    const source = new EventSource(`/api/jobs/${jobId}/stream`);
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as { text: string };
        setLog((prev) => (prev + data.text).slice(-200_000));
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
    return () => {
      cancelled = true;
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
