import { useEffect, useState } from 'react';
import type { AuditLogDto, DependencyStatusDto, JobDto, UpdateStatusDto } from '@gamedock/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { formatDate } from '../format';
import { JobLogModal } from '../components/JobLogModal';

export function SettingsPage() {
  const { hasRole } = useAuth();
  const [deps, setDeps] = useState<DependencyStatusDto[]>([]);
  const [audit, setAudit] = useState<AuditLogDto[]>([]);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusDto | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateJobId, setUpdateJobId] = useState<string | null>(null);

  const loadUpdateStatus = () => {
    setUpdateError(null);
    setCheckingUpdate(true);
    api
      .get<UpdateStatusDto>('/api/system/update')
      .then(setUpdateStatus)
      .catch((err) => setUpdateError(err instanceof Error ? err.message : 'Check failed'))
      .finally(() => setCheckingUpdate(false));
  };

  const startUpdate = async () => {
    setUpdateError(null);
    try {
      const { job } = await api.post<{ job: JobDto }>('/api/system/update');
      setUpdateJobId(job.id);
    } catch (err) {
      setUpdateError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Update failed',
      );
    }
  };

  useEffect(() => {
    api
      .get<DependencyStatusDto[]>('/api/system/dependencies')
      .then(setDeps)
      .catch(() => {});
    if (hasRole('admin')) {
      api
        .get<AuditLogDto[]>('/api/system/audit?limit=100')
        .then(setAudit)
        .catch(() => {});
      loadUpdateStatus();
    }
  }, [hasRole]);

  return (
    <div>
      <h1>Settings</h1>

      {hasRole('admin') && (
        <div className="card">
          <h2>Application updates</h2>
          {updateStatus?.configured === false ? (
            <p className="muted">
              Set <code>GAMEDOCK_UPDATE_REPO_URL</code> (and optionally{' '}
              <code>GAMEDOCK_UPDATE_BRANCH</code>) in <code>.env</code> and restart GameDock to
              enable self-updates from a git repository.
            </p>
          ) : (
            <>
              <table>
                <tbody>
                  <tr>
                    <td>Repository</td>
                    <td className="muted">
                      {updateStatus?.repoUrl} ({updateStatus?.branch})
                    </td>
                  </tr>
                  <tr>
                    <td>Running commit</td>
                    <td className="muted">
                      <code>{updateStatus?.currentCommit?.slice(0, 12) ?? 'unknown'}</code>
                      {updateStatus?.currentCommitAt &&
                        ` — ${formatDate(updateStatus.currentCommitAt)}`}
                    </td>
                  </tr>
                  <tr>
                    <td>Latest on branch</td>
                    <td className="muted">
                      {updateStatus?.remoteCommit ? (
                        <code>{updateStatus.remoteCommit.slice(0, 12)}</code>
                      ) : (
                        '-'
                      )}
                      {updateStatus?.updateAvailable && (
                        <span className="badge job-queued"> update available</span>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
              <div className="modal-actions" style={{ justifyContent: 'flex-start', gap: 8 }}>
                <button
                  className="btn btn-small"
                  onClick={loadUpdateStatus}
                  disabled={checkingUpdate}
                >
                  {checkingUpdate ? 'Checking...' : 'Check for updates'}
                </button>
                <button className="btn btn-primary btn-small" onClick={() => void startUpdate()}>
                  Update now
                </button>
              </div>
              <div className="field-hint">
                Clones the branch above, builds it, and swaps it in for the running app, then
                restarts GameDock - expect a short outage (usually well under a minute) and a brief
                drop in this log view while it comes back up.
              </div>
            </>
          )}
          {updateError && <div className="error-text">{updateError}</div>}
        </div>
      )}

      {updateJobId && <JobLogModal jobId={updateJobId} onClose={() => setUpdateJobId(null)} />}

      <div className="card">
        <h2>Host dependencies</h2>
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Status</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {deps.map((dep) => (
              <tr key={dep.name}>
                <td>
                  <code>{dep.name}</code>
                </td>
                <td>
                  {dep.found ? (
                    <span className="badge status-running">found</span>
                  ) : (
                    <span className={`badge ${dep.required ? 'status-crashed' : 'job-queued'}`}>
                      missing
                    </span>
                  )}
                </td>
                <td className="muted">{dep.found ? (dep.version ?? dep.path) : dep.hint}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Server configuration</h2>
        <p className="muted">
          GameDock is configured through environment variables (see <code>.env.example</code>): data
          directory, instance directory, backup directory, bind address/port, SteamCMD path and
          session secret. Changes require a restart of the GameDock service.
        </p>
      </div>

      {hasRole('admin') && (
        <div className="card">
          <h2>Audit log</h2>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>User</th>
                <th>Action</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((entry) => (
                <tr key={entry.id}>
                  <td className="muted">{formatDate(entry.createdAt)}</td>
                  <td>{entry.username ?? '-'}</td>
                  <td>
                    <code>{entry.action}</code>
                  </td>
                  <td className="muted">{entry.detail ?? '-'}</td>
                </tr>
              ))}
              {audit.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No entries.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
