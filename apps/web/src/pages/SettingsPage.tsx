import { useEffect, useState } from 'react';
import type {
  ApiTokenDto,
  AuditLogDto,
  CreateApiTokenResponseDto,
  DependencyStatusDto,
  JobDto,
  PasskeyDto,
  PasskeyRegistrationOptionsDto,
  TotpSetupResponseDto,
  UpdateStatusDto,
} from '@gamedock/shared';
import { startRegistration } from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
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
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);

  const [passkeys, setPasskeys] = useState<PasskeyDto[]>([]);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [newPasskeyNickname, setNewPasskeyNickname] = useState('');

  const [apiTokens, setApiTokens] = useState<ApiTokenDto[]>([]);
  const [apiTokenError, setApiTokenError] = useState<string | null>(null);
  const [apiTokenBusy, setApiTokenBusy] = useState(false);
  const [creatingToken, setCreatingToken] = useState(false);
  const [newTokenName, setNewTokenName] = useState('');
  const [newTokenExpiresInDays, setNewTokenExpiresInDays] = useState('');
  const [revealedToken, setRevealedToken] = useState<{ token: string; name: string } | null>(null);

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
      const result = await api.post<{ ok: true; recoveryCodes: string[] }>(
        '/api/auth/totp/confirm',
        { code: totpCode },
      );
      setTotpSetup(null);
      setTotpCode('');
      setRecoveryCodes(result.recoveryCodes);
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
      setRecoveryCodes(null);
      await refreshUser();
    } catch (err) {
      setTotpError(err instanceof Error ? err.message : 'Failed to disable 2FA');
    } finally {
      setTotpBusy(false);
    }
  };

  const regenerateRecoveryCodes = async () => {
    setTotpError(null);
    setRegenBusy(true);
    try {
      const result = await api.post<{ recoveryCodes: string[] }>('/api/auth/totp/recovery-codes');
      setRecoveryCodes(result.recoveryCodes);
      await refreshUser();
    } catch (err) {
      setTotpError(err instanceof Error ? err.message : 'Failed to regenerate recovery codes');
    } finally {
      setRegenBusy(false);
    }
  };

  const loadPasskeys = () => {
    api
      .get<PasskeyDto[]>('/api/auth/passkeys')
      .then(setPasskeys)
      .catch(() => {});
  };

  const addPasskey = async () => {
    setPasskeyError(null);
    setPasskeyBusy(true);
    try {
      const options = await api.post<PasskeyRegistrationOptionsDto>(
        '/api/auth/passkeys/register/begin',
      );
      const response = await startRegistration({
        optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
      });
      await api.post('/api/auth/passkeys/register/complete', {
        nickname: newPasskeyNickname.trim() || 'Passkey',
        response: response as unknown as RegistrationResponseJSON,
      });
      setAddingPasskey(false);
      setNewPasskeyNickname('');
      loadPasskeys();
    } catch (err) {
      setPasskeyError(err instanceof Error ? err.message : 'Failed to add passkey');
    } finally {
      setPasskeyBusy(false);
    }
  };

  const removePasskey = async (id: string) => {
    setPasskeyError(null);
    setPasskeyBusy(true);
    try {
      await api.delete(`/api/auth/passkeys/${id}`);
      loadPasskeys();
    } catch (err) {
      setPasskeyError(err instanceof Error ? err.message : 'Failed to remove passkey');
    } finally {
      setPasskeyBusy(false);
    }
  };

  const loadApiTokens = () => {
    api
      .get<ApiTokenDto[]>('/api/auth/tokens')
      .then(setApiTokens)
      .catch(() => {});
  };

  const createApiToken = async () => {
    const name = newTokenName.trim();
    if (!name) return;
    setApiTokenError(null);
    setApiTokenBusy(true);
    try {
      const trimmedExpiry = newTokenExpiresInDays.trim();
      const expiresInDays = trimmedExpiry ? parseInt(trimmedExpiry, 10) : null;
      if (trimmedExpiry && (!Number.isInteger(expiresInDays) || (expiresInDays ?? 0) < 1)) {
        throw new Error('Expiry must be a whole number of days, or blank for never');
      }
      const result = await api.post<CreateApiTokenResponseDto>('/api/auth/tokens', {
        name,
        expiresInDays,
      });
      setRevealedToken({ token: result.token, name: result.name });
      setCreatingToken(false);
      setNewTokenName('');
      setNewTokenExpiresInDays('');
      loadApiTokens();
    } catch (err) {
      setApiTokenError(err instanceof Error ? err.message : 'Failed to create token');
    } finally {
      setApiTokenBusy(false);
    }
  };

  const removeApiToken = async (id: string) => {
    setApiTokenError(null);
    setApiTokenBusy(true);
    try {
      await api.delete(`/api/auth/tokens/${id}`);
      loadApiTokens();
    } catch (err) {
      setApiTokenError(err instanceof Error ? err.message : 'Failed to revoke token');
    } finally {
      setApiTokenBusy(false);
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
    loadPasskeys();
    loadApiTokens();
  }, [hasRole]);

  return (
    <div>
      <h1>Settings</h1>

      <div className="card form-card">
        <h2>Two-factor authentication</h2>
        {recoveryCodes ? (
          <>
            <p className="muted">
              Save these recovery codes somewhere safe - each one signs you in <strong>once</strong>{' '}
              if you lose access to your authenticator app. They won't be shown again.
            </p>
            <pre className="recovery-codes">{recoveryCodes.join('\n')}</pre>
            <button className="btn btn-primary btn-small" onClick={() => setRecoveryCodes(null)}>
              I've saved these
            </button>
          </>
        ) : user?.totpEnabled ? (
          <>
            <p className="muted">Enabled for your account - a code is required at every sign-in.</p>
            <p className="muted">
              {user.totpRecoveryCodesRemaining} recovery code
              {user.totpRecoveryCodesRemaining === 1 ? '' : 's'} remaining.{' '}
              <button
                type="button"
                className="link-button"
                disabled={regenBusy}
                onClick={() => void regenerateRecoveryCodes()}
              >
                Regenerate
              </button>{' '}
              (invalidates any unused codes from before)
            </p>
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

      <div className="card form-card">
        <h2>Passkeys</h2>
        <p className="muted">
          Sign in with a device passkey (Windows Hello, Touch ID, a security key, ...) instead of a
          password - a passkey is a complete sign-in on its own, no separate code needed afterward.
          You can register more than one.
        </p>
        {passkeys.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Nickname</th>
                <th>Created</th>
                <th>Last used</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {passkeys.map((passkey) => (
                <tr key={passkey.id}>
                  <td>{passkey.nickname}</td>
                  <td className="muted">{formatDate(passkey.createdAt)}</td>
                  <td className="muted">
                    {passkey.lastUsedAt ? formatDate(passkey.lastUsedAt) : 'never'}
                  </td>
                  <td>
                    <button
                      className="btn btn-small"
                      disabled={passkeyBusy}
                      onClick={() => void removePasskey(passkey.id)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {addingPasskey ? (
          <div className="form-row-inline">
            <input
              placeholder="Nickname (e.g. this laptop)"
              value={newPasskeyNickname}
              onChange={(e) => setNewPasskeyNickname(e.target.value)}
              autoFocus
            />
            <button
              className="btn btn-primary btn-small"
              disabled={passkeyBusy}
              onClick={() => void addPasskey()}
            >
              Continue
            </button>
            <button
              className="btn btn-small"
              onClick={() => {
                setAddingPasskey(false);
                setNewPasskeyNickname('');
                setPasskeyError(null);
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn btn-small" onClick={() => setAddingPasskey(true)}>
            Add a passkey
          </button>
        )}
        {passkeyError && <div className="error-text">{passkeyError}</div>}
      </div>

      <div className="card form-card">
        <h2>API tokens</h2>
        <p className="muted">
          Bearer tokens for scripting/automation against the REST API - they carry your account's
          own role and permissions, so treat them like a password. Send as{' '}
          <code>Authorization: Bearer &lt;token&gt;</code>.
        </p>
        {revealedToken && (
          <>
            <p className="muted">
              Token <strong>{revealedToken.name}</strong> created - copy it now, it won't be shown
              again:
            </p>
            <pre className="recovery-codes">{revealedToken.token}</pre>
            <button className="btn btn-primary btn-small" onClick={() => setRevealedToken(null)}>
              I've saved this
            </button>
          </>
        )}
        {apiTokens.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Expires</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {apiTokens.map((tok) => (
                <tr key={tok.id}>
                  <td>{tok.name}</td>
                  <td className="muted">{formatDate(tok.createdAt)}</td>
                  <td className="muted">{tok.lastUsedAt ? formatDate(tok.lastUsedAt) : 'never'}</td>
                  <td className="muted">{tok.expiresAt ? formatDate(tok.expiresAt) : 'never'}</td>
                  <td>
                    <button
                      className="btn btn-small"
                      disabled={apiTokenBusy}
                      onClick={() => void removeApiToken(tok.id)}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {creatingToken ? (
          <div className="form-row-inline">
            <input
              placeholder="Name (e.g. backup script)"
              value={newTokenName}
              onChange={(e) => setNewTokenName(e.target.value)}
              autoFocus
            />
            <input
              placeholder="Expires in days (blank = never)"
              value={newTokenExpiresInDays}
              onChange={(e) => setNewTokenExpiresInDays(e.target.value)}
              style={{ width: 200 }}
            />
            <button
              className="btn btn-primary btn-small"
              disabled={apiTokenBusy || !newTokenName.trim()}
              onClick={() => void createApiToken()}
            >
              Create
            </button>
            <button
              className="btn btn-small"
              onClick={() => {
                setCreatingToken(false);
                setNewTokenName('');
                setNewTokenExpiresInDays('');
                setApiTokenError(null);
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn btn-small" onClick={() => setCreatingToken(true)}>
            Create a token
          </button>
        )}
        {apiTokenError && <div className="error-text">{apiTokenError}</div>}
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
