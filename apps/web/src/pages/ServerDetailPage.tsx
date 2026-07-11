import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { GameTemplateDto, InstanceDto, JobDto } from '@gamedock/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { useGameDockEvents } from '../hooks';
import { StatusBadge } from '../components/StatusBadge';
import { Console } from '../components/Console';
import { ConfirmDialog } from '../components/Confirm';
import { JobLogModal } from '../components/JobLogModal';
import { FilesTab } from './server-detail/FilesTab';
import { BackupsTab } from './server-detail/BackupsTab';
import { SettingsTab } from './server-detail/SettingsTab';
import { formatBytes, formatDuration } from '../format';

type Tab = 'console' | 'settings' | 'files' | 'backups';

export function ServerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const [instance, setInstance] = useState<InstanceDto | null>(null);
  const [template, setTemplate] = useState<GameTemplateDto | null>(null);
  const [tab, setTab] = useState<Tab>('console');
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [confirmKill, setConfirmKill] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [watchingJob, setWatchingJob] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);
  const [cloneName, setCloneName] = useState('');
  const [cloneBusy, setCloneBusy] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    api
      .get<InstanceDto>(`/api/instances/${id}`)
      .then((data) => {
        setInstance(data);
        return api.get<GameTemplateDto>(`/api/templates/${data.templateId}`).catch(() => null);
      })
      .then((tpl) => {
        if (tpl) setTemplate(tpl);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load server'));
  }, [id]);

  useEffect(load, [load]);

  // Poll usage while running (paused while the tab is in the background).
  useEffect(() => {
    if (!id || instance?.status !== 'running') return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      api
        .get<InstanceDto>(`/api/instances/${id}`)
        .then((data) => setInstance(data))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [id, instance?.status]);

  useGameDockEvents((event) => {
    if (event.kind === 'instance_status' && event.instanceId === id) {
      setInstance((prev) => (prev ? { ...prev, status: event.status, pid: event.pid } : prev));
      if (event.status === 'stopped' || event.status === 'crashed') {
        load();
      }
    }
    if (event.kind === 'job_update' && event.job.instanceId === id) {
      if (event.job.status === 'succeeded') {
        if (event.job.type === 'delete_instance') {
          navigate('/servers');
          return;
        }
        load();
      }
    }
  });

  if (error) return <div className="error-text">{error}</div>;
  if (!instance || !template) return <p className="muted">Loading...</p>;

  const activeStates = ['running', 'starting', 'stopping'];
  const isActive = activeStates.includes(instance.status);
  const canOperate = hasRole('operator');

  const action = async (name: string, fn: () => Promise<unknown>) => {
    setError(null);
    setBusyAction(name);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${name} failed`);
    } finally {
      setBusyAction(null);
      load();
    }
  };

  const startJob = async (endpoint: 'install' | 'update') => {
    setError(null);
    try {
      const result = await api.post<{ job: JobDto }>(`/api/instances/${instance.id}/${endpoint}`);
      setWatchingJob(result.job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${endpoint} failed`);
    }
  };

  const confirmClone = async () => {
    const name = cloneName.trim();
    if (!name) return;
    setCloneError(null);
    setCloneBusy(true);
    try {
      const clone = await api.post<InstanceDto>(`/api/instances/${instance.id}/clone`, { name });
      navigate(`/servers/${clone.id}`);
    } catch (err) {
      setCloneError(err instanceof Error ? err.message : 'Clone failed');
    } finally {
      setCloneBusy(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{instance.name}</h1>
          <div className="muted">
            {instance.templateName} · <StatusBadge status={instance.status} />
            {instance.pid && <span> · PID {instance.pid}</span>}
            {instance.usage && (
              <span>
                {' '}
                · CPU {instance.usage.cpuPercent.toFixed(1)}% · RAM{' '}
                {formatBytes(instance.usage.memoryBytes)} · up{' '}
                {formatDuration(instance.usage.uptimeSeconds)}
              </span>
            )}
          </div>
        </div>

        {canOperate && (
          <div className="action-bar">
            {!isActive && instance.installed && (
              <button
                className="btn btn-primary"
                disabled={busyAction !== null}
                onClick={() =>
                  void action('start', () => api.post(`/api/instances/${instance.id}/start`))
                }
              >
                Start
              </button>
            )}
            {isActive && (
              <>
                <button
                  className="btn"
                  disabled={busyAction !== null}
                  onClick={() =>
                    void action('stop', () => api.post(`/api/instances/${instance.id}/stop`))
                  }
                >
                  {busyAction === 'stop' ? 'Stopping...' : 'Stop'}
                </button>
                <button
                  className="btn"
                  disabled={busyAction !== null}
                  onClick={() =>
                    void action('restart', () => api.post(`/api/instances/${instance.id}/restart`))
                  }
                >
                  Restart
                </button>
                <button
                  className="btn btn-danger"
                  disabled={busyAction !== null}
                  onClick={() => setConfirmKill(true)}
                >
                  Kill
                </button>
              </>
            )}
            {!isActive && (
              <button
                className="btn"
                onClick={() => void startJob(instance.installed ? 'update' : 'install')}
              >
                {instance.installed ? 'Update files' : 'Install files'}
              </button>
            )}
            {hasRole('admin') && (
              <button
                className="btn"
                onClick={() => {
                  setCloneName(`${instance.name} copy`);
                  setCloneError(null);
                  setCloning(true);
                }}
              >
                Clone
              </button>
            )}
            {hasRole('admin') && !isActive && (
              <button className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      {error && <div className="error-text">{error}</div>}
      {!instance.installed && (
        <div className="notice">
          Server files are not installed yet. Click <strong>Install files</strong> to download them
          {template.installMethod === 'steamcmd' ? ' via SteamCMD' : ''}.
        </div>
      )}

      <div className="tabs">
        {(['console', 'settings', 'files', 'backups'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'console' && (
        <Console
          instanceId={instance.id}
          running={isActive}
          supportsInput={template.console.supportsInput}
        />
      )}
      {tab === 'settings' && (
        <SettingsTab instance={instance} template={template} onUpdated={setInstance} />
      )}
      {tab === 'files' && <FilesTab instanceId={instance.id} />}
      {tab === 'backups' && (
        <BackupsTab
          instanceId={instance.id}
          running={isActive}
          onJobStarted={(jobId) => setWatchingJob(jobId)}
        />
      )}

      {confirmKill && (
        <ConfirmDialog
          title="Force kill server"
          message="Force killing skips the graceful shutdown. Unsaved world data may be lost. Use Stop unless the server is unresponsive."
          confirmLabel="Force kill"
          danger
          onConfirm={() => {
            setConfirmKill(false);
            void action('kill', () => api.post(`/api/instances/${instance.id}/kill`));
          }}
          onCancel={() => setConfirmKill(false)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete server instance"
          message={
            <>
              This permanently deletes <strong>{instance.name}</strong>, including all server files
              and backups.
            </>
          }
          confirmLabel="Delete permanently"
          danger
          requireText={instance.name}
          onConfirm={() => {
            setConfirmDelete(false);
            void api
              .delete<{ job: JobDto }>(`/api/instances/${instance.id}`)
              .then((result) => setWatchingJob(result.job.id))
              .catch((err) => setError(err instanceof Error ? err.message : 'Delete failed'));
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {cloning && (
        <div className="modal-backdrop" onClick={() => !cloneBusy && setCloning(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Clone {instance.name}</h3>
            <div className="form-row">
              <label htmlFor="clone-name">New server name</label>
              <input
                id="clone-name"
                value={cloneName}
                onChange={(e) => setCloneName(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void confirmClone();
                }}
              />
              <p className="muted">
                Copies the template, game settings, environment variables, ports and startup/backup
                settings into a new server. The clone still needs its own install - no files are
                copied.
              </p>
            </div>
            {cloneError && <div className="error-text">{cloneError}</div>}
            <div className="modal-actions">
              <button className="btn" onClick={() => setCloning(false)} disabled={cloneBusy}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void confirmClone()}
                disabled={cloneBusy}
              >
                {cloneBusy ? 'Cloning...' : 'Clone'}
              </button>
            </div>
          </div>
        </div>
      )}

      {watchingJob && <JobLogModal jobId={watchingJob} onClose={() => setWatchingJob(null)} />}
    </div>
  );
}
