import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import type { HealthDto } from '@gamedock/shared';
import { useAuth } from '../auth';
import { api } from '../api';

export function Layout() {
  const { user, logout, hasRole } = useAuth();
  const navigate = useNavigate();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<HealthDto>('/api/system/health')
      .then((health) => setVersion(health.version))
      .catch(() => setVersion(null));
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">▣</span> GameDock
          {version && <span className="brand-version">v{version}</span>}
        </div>
        <nav>
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/servers">Servers</NavLink>
          {hasRole('admin') && <NavLink to="/users">Users</NavLink>}
          {hasRole('admin') && <NavLink to="/logs">Logs</NavLink>}
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="sidebar-footer">
          <div className="user-chip">
            <span className="user-name">{user?.username}</span>
            <span className="user-role">{user?.role}</span>
          </div>
          <button className="btn btn-small" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
