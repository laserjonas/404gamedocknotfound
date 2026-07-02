import type { InstanceStatus, JobStatus } from '@gamedock/shared';

const STATUS_LABELS: Record<InstanceStatus, string> = {
  not_installed: 'Not installed',
  installing: 'Installing',
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  crashed: 'Crashed',
};

export function StatusBadge({ status }: { status: InstanceStatus }) {
  return <span className={`badge status-${status}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function JobBadge({ status }: { status: JobStatus }) {
  return <span className={`badge job-${status}`}>{status}</span>;
}
