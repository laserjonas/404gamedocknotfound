import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { InstanceDto } from '@gamedock/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { useGameDockEvents } from '../hooks';
import { StatusBadge } from '../components/StatusBadge';

export function ServersPage() {
  const [instances, setInstances] = useState<InstanceDto[]>([]);
  const [loading, setLoading] = useState(true);
  const { hasRole } = useAuth();

  const refresh = () => {
    api
      .get<InstanceDto[]>('/api/instances')
      .then(setInstances)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  useGameDockEvents((event) => {
    if (event.kind === 'instance_status') {
      setInstances((prev) =>
        prev.map((i) =>
          i.id === event.instanceId ? { ...i, status: event.status, pid: event.pid } : i,
        ),
      );
    }
    if (event.kind === 'job_update' && event.job.type === 'delete_instance') {
      if (event.job.status === 'succeeded') refresh();
    }
  });

  return (
    <div>
      <div className="page-header">
        <h1>Servers</h1>
        {hasRole('admin') && (
          <Link className="btn btn-primary" to="/servers/new">
            + New server
          </Link>
        )}
      </div>

      {loading ? (
        <p className="muted">Loading...</p>
      ) : instances.length === 0 ? (
        <div className="card">
          <p className="muted">
            No game servers yet.{' '}
            {hasRole('admin') ? (
              <Link to="/servers/new">Create one from a template.</Link>
            ) : (
              'Ask an admin to create one.'
            )}
          </p>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Game</th>
                <th>Status</th>
                <th>Ports</th>
                <th>Auto-start</th>
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
                  <td className="muted">
                    {instance.ports.map((p) => `${p.port}/${p.protocol}`).join(', ') || '-'}
                  </td>
                  <td>{instance.autoStart ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
