import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AuditLogDto, InstanceDto, SystemStatsDto } from '@gamedock/shared';
import { api } from '../api';
import { useGameDockEvents } from '../hooks';
import { StatusBadge } from '../components/StatusBadge';
import { formatBytes, formatDate, formatDuration } from '../format';

export function DashboardPage() {
  const [stats, setStats] = useState<SystemStatsDto | null>(null);
  const [instances, setInstances] = useState<InstanceDto[]>([]);
  const [events, setEvents] = useState<AuditLogDto[]>([]);

  const refresh = useCallback(() => {
    api
      .get<SystemStatsDto>('/api/system/stats')
      .then(setStats)
      .catch(() => {});
    api
      .get<InstanceDto[]>('/api/instances')
      .then(setInstances)
      .catch(() => {});
    api
      .get<AuditLogDto[]>('/api/system/events')
      .then(setEvents)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      api
        .get<SystemStatsDto>('/api/system/stats')
        .then(setStats)
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  useGameDockEvents((event) => {
    if (event.kind === 'instance_status') {
      setInstances((prev) =>
        prev.map((i) => (i.id === event.instanceId ? { ...i, status: event.status } : i)),
      );
    }
    if (event.kind === 'audit') {
      setEvents((prev) => [event.entry, ...prev].slice(0, 20));
    }
  });

  const memPercent = stats ? (stats.memory.usedBytes / stats.memory.totalBytes) * 100 : 0;

  return (
    <div>
      <h1>Dashboard</h1>

      <div className="stat-grid">
        <div className="card stat-card">
          <div className="stat-label">CPU</div>
          <div className="stat-value">{stats ? `${stats.cpu.usagePercent.toFixed(0)}%` : '–'}</div>
          <div className="meter">
            <div className="meter-fill" style={{ width: `${stats?.cpu.usagePercent ?? 0}%` }} />
          </div>
          <div className="stat-sub">{stats ? `${stats.cpu.cores} cores` : ''}</div>
        </div>
        <div className="card stat-card">
          <div className="stat-label">Memory</div>
          <div className="stat-value">{stats ? `${memPercent.toFixed(0)}%` : '–'}</div>
          <div className="meter">
            <div className="meter-fill" style={{ width: `${memPercent}%` }} />
          </div>
          <div className="stat-sub">
            {stats
              ? `${formatBytes(stats.memory.usedBytes)} / ${formatBytes(stats.memory.totalBytes)}`
              : ''}
          </div>
        </div>
        <div className="card stat-card">
          <div className="stat-label">Disk</div>
          {stats?.disk.slice(0, 2).map((d) => (
            <div key={d.mount} className="disk-row">
              <span className="disk-mount">{d.mount}</span>
              <div className="meter">
                <div
                  className="meter-fill"
                  style={{ width: `${(d.usedBytes / d.totalBytes) * 100}%` }}
                />
              </div>
              <span className="stat-sub">
                {formatBytes(d.usedBytes)} / {formatBytes(d.totalBytes)}
              </span>
            </div>
          )) ?? '–'}
        </div>
        <div className="card stat-card">
          <div className="stat-label">Servers</div>
          <div className="stat-value">
            {stats ? `${stats.runningInstances} / ${stats.totalInstances}` : '–'}
          </div>
          <div className="stat-sub">running / total</div>
          <div className="stat-sub">
            {stats ? `Host up ${formatDuration(stats.uptimeSeconds)}` : ''}
          </div>
        </div>
      </div>

      <div className="dashboard-columns">
        <div className="card">
          <div className="card-header">
            <h2>Game servers</h2>
            <Link className="btn btn-small" to="/servers">
              Manage
            </Link>
          </div>
          {instances.length === 0 ? (
            <p className="muted">
              No servers yet. <Link to="/servers/new">Create your first server</Link>.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Game</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {instances.map((instance) => (
                  <tr key={instance.id}>
                    <td>
                      <Link to={`/servers/${instance.id}`}>{instance.name}</Link>
                    </td>
                    <td>{instance.templateName}</td>
                    <td>
                      <StatusBadge status={instance.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h2>Recent events</h2>
          </div>
          {events.length === 0 ? (
            <p className="muted">No events yet.</p>
          ) : (
            <ul className="event-list">
              {events.map((event) => (
                <li key={event.id}>
                  <span className="event-action">{event.action}</span>
                  {event.detail && <span className="event-detail"> — {event.detail}</span>}
                  <span className="event-time">{formatDate(event.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
