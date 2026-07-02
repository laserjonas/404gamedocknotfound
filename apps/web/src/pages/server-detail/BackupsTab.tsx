import { useCallback, useEffect, useState } from 'react';
import type { BackupDto, JobDto } from '@gamedock/shared';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { ConfirmDialog } from '../../components/Confirm';
import { formatBytes, formatDate } from '../../format';

interface BackupsTabProps {
  instanceId: string;
  running: boolean;
  onJobStarted(jobId: string): void;
}

export function BackupsTab({ instanceId, running, onJobStarted }: BackupsTabProps) {
  const [backups, setBackups] = useState<BackupDto[]>([]);
  const [note, setNote] = useState('');
  const [excludes, setExcludes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<BackupDto | null>(null);
  const [deleting, setDeleting] = useState<BackupDto | null>(null);
  const { hasRole } = useAuth();
  const canEdit = hasRole('operator');

  const load = useCallback(() => {
    api
      .get<BackupDto[]>(`/api/instances/${instanceId}/backups`)
      .then(setBackups)
      .catch(() => {});
  }, [instanceId]);

  useEffect(load, [load]);

  const createBackup = async () => {
    setError(null);
    try {
      const result = await api.post<{ job: JobDto }>(`/api/instances/${instanceId}/backups`, {
        note: note.trim() || null,
        excludePaths: excludes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      setNote('');
      onJobStarted(result.job.id);
      // Reload once the job finishes; a simple delayed refresh keeps it simple.
      setTimeout(load, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backup failed');
    }
  };

  const confirmRestore = async () => {
    if (!restoring) return;
    setError(null);
    try {
      const result = await api.post<{ job: JobDto }>(
        `/api/instances/${instanceId}/backups/${restoring.id}/restore`,
      );
      setRestoring(null);
      onJobStarted(result.job.id);
    } catch (err) {
      setRestoring(null);
      setError(err instanceof Error ? err.message : 'Restore failed');
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await api.delete(`/api/instances/${instanceId}/backups/${deleting.id}`);
      setDeleting(null);
      load();
    } catch (err) {
      setDeleting(null);
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  return (
    <div>
      {canEdit && (
        <div className="card backup-form">
          <div className="form-row-inline">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Backup note (optional)"
              maxLength={256}
            />
            <input
              value={excludes}
              onChange={(e) => setExcludes(e.target.value)}
              placeholder="Exclude paths, comma-separated (optional)"
            />
            <button className="btn btn-primary" onClick={() => void createBackup()}>
              Create backup
            </button>
          </div>
          <div className="field-hint">
            Tip: exclude large generated folders (e.g. <code>steamapps</code>, world caches) to keep
            archives small. Back up while the server is stopped for consistent saves.
          </div>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}

      <table>
        <thead>
          <tr>
            <th>Archive</th>
            <th>Size</th>
            <th>Created</th>
            <th>Note</th>
            {canEdit && <th></th>}
          </tr>
        </thead>
        <tbody>
          {backups.map((backup) => (
            <tr key={backup.id}>
              <td>{backup.fileName}</td>
              <td className="muted">{formatBytes(backup.sizeBytes)}</td>
              <td className="muted">{formatDate(backup.createdAt)}</td>
              <td className="muted">{backup.note ?? '-'}</td>
              {canEdit && (
                <td className="row-actions">
                  <button
                    className="btn btn-small"
                    disabled={running}
                    title={running ? 'Stop the server first' : undefined}
                    onClick={() => setRestoring(backup)}
                  >
                    Restore
                  </button>
                  <button className="btn btn-small btn-danger" onClick={() => setDeleting(backup)}>
                    Delete
                  </button>
                </td>
              )}
            </tr>
          ))}
          {backups.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No backups yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {restoring && (
        <ConfirmDialog
          title="Restore backup"
          message={
            <>
              Restoring <strong>{restoring.fileName}</strong> will{' '}
              <strong>erase all current server files</strong> for this instance and replace them
              with the backup contents.
            </>
          }
          confirmLabel="Restore"
          danger
          requireText="restore"
          onConfirm={() => void confirmRestore()}
          onCancel={() => setRestoring(null)}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete backup"
          message={
            <>
              Delete backup <strong>{deleting.fileName}</strong>? This cannot be undone.
            </>
          }
          confirmLabel="Delete"
          danger
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
