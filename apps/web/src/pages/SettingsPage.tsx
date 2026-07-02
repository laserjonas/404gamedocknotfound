import { useEffect, useState } from 'react';
import type { AuditLogDto, DependencyStatusDto } from '@gamedock/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { formatDate } from '../format';

export function SettingsPage() {
  const { hasRole } = useAuth();
  const [deps, setDeps] = useState<DependencyStatusDto[]>([]);
  const [audit, setAudit] = useState<AuditLogDto[]>([]);

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
    }
  }, [hasRole]);

  return (
    <div>
      <h1>Settings</h1>

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
