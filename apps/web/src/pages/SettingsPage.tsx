import { useEffect, useState } from 'react';
import type {
  AuditLogDto,
  DependencyStatusDto,
  JobDto,
  TotpSetupResponseDto,
  UpdateStatusDto,
} from '@gamedock/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { formatDate } from '../format';
import { JobLogModal } from '../components/JobLogModal';

export function SettingsPage() {
  const { user, hasRole, refreshUser } = useAuth();
  const [deps, setDeps] = useState<DependencyStatusDto[]>([]);
  const [audit, setAudit] = useState<AuditLogDto[]>([]);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusDto | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateJobId, setUpdateJobId] = useState<string | null>(null);

  const [totpSetup, setTotpSetup] = useState<TotpSetupResponseDto | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpError, setTotpError] = useState<string | null>(null);
  const [totpBusy, setTotpBusy] = useState(false);
  const [showDisableForm, setShowDisableForm] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');

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

  const startTotpSetup = async () => {
    setTotpError(null);
    setTotpBusy(true);
    try {
      const setup = await api.post<TotpSetupResponseDto>('/api/auth/totp/setup');
      setTotpSetup(setup);
    } catch (err) {
      setTotpError(err instanceof Error ? err.message : 'Failed to start setup');
    } finally {
      setTotpBusy(false);
    }
  };

  const confirmTotpSetup = async () => {
    setTotpError(null);
    setTotpBusy(true);
    try {
      await api.post('/api/auth/totp/confirm', { code: totpCode });
      setTotpSetup(null);
      setTotpCode('');
      await refreshUser();
    } catch (err) {
      setTotpError(err instanceof Error ? err.message : 'Invalid code');
    } finally {
      setTotpBusy(false);
    }
  };

  const disableTotp = async () => {
    setTotpError(null);
    setTotpBusy(true);
    try {
      await api.post('/api/auth/totp/disable', { password: disablePassword });
      setShowDisableForm(false);
      setDisablePassword('');
      await refreshUser();
    } catch (err) {
      setTotpError(err instanceof Error ? err.message : 'Failed to disable 2FA');
    } finally {
      setTotpBusy(false);
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

      <div className="card form-card">
        <h2>Two-factor authentication</h2>
        {user?.totpEnabled ? (
          <>
            <p className="muted">Enabled for your account - a code is required at every sign-in.</p>
            {!showDisableForm ? (
              <button className="btn btn-small" onClick={() => setShowDisableForm(true)}>
                Disable 2FA
              </button>
            ) : (
              <div className="form-row-inline">
                <input
                  type="password"
                  placeholder="Current password"
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                />
                <button
                  className="btn btn-small"
                  disabled={totpBusy || !disablePassword}
                  onClick={() => void disableTotp()}
                >
                  Confirm disable
                </button>
                <button
                  className="btn btn-small"
                  onClick={() => {
                    setShowDisableForm(false);
                    setDisablePassword('');
                    setTotpError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
          </>
        ) : totpSetup ? (
          <>
            <p className="muted">
              Scan this QR code with an authenticator app (Google Authenticator, Authy, 1Password,
              ...), then enter the 6-digit code it shows to confirm.
            </p>
            <img
              src={totpSetup.qrCodeDataUrl}
              alt="2FA setup QR code"
              width={200}
              height={200}
              style={{ display: 'block', marginBottom: 12 }}
            />
            <div className="form-row">
              <label>Can't scan? Enter this key manually</label>
              <code>{totpSetup.secret}</code>
            </div>
            <div className="form-row-inline">
              <input
                placeholder="6-digit code"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                inputMode="numeric"
                maxLength={6}
              />
              <button
                className="btn btn-primary btn-small"
                disabled={totpBusy || totpCode.length !== 6}
                onClick={() => void confirmTotpSetup()}
              >
                Confirm &amp; enable
              </button>
              <button
                className="btn btn-small"
                onClick={() => {
                  setTotpSetup(null);
                  setTotpCode('');
                  setTotpError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">
              Not enabled. Add an authenticator app as a second sign-in step for your account.
            </p>
            <button
              className="btn btn-small"
              disabled={totpBusy}
              onClick={() => void startTotpSetup()}
            >
              Enable 2FA
            </button>
          </>
        )}
        {totpError && <div className="error-text">{totpError}</div>}
      </div>

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
