import { useEffect, useState } from 'react';
import type { Role, UserDto } from '@gamedock/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { ConfirmDialog } from '../components/Confirm';
import { formatDate } from '../format';

export function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [deleting, setDeleting] = useState<UserDto | null>(null);
  const [resetting, setResetting] = useState<UserDto | null>(null);

  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<Role>('operator');

  const load = () => {
    api
      .get<UserDto[]>('/api/users')
      .then(setUsers)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load users'));
  };
  useEffect(load, []);

  const create = async () => {
    setError(null);
    try {
      await api.post('/api/users', {
        username: newUsername.trim(),
        password: newPassword,
        role: newRole,
      });
      setShowCreate(false);
      setNewUsername('');
      setNewPassword('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user');
    }
  };

  const setRole = async (user: UserDto, role: Role) => {
    setError(null);
    try {
      await api.patch(`/api/users/${user.id}`, { role });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
      load();
    }
  };

  const toggleDisabled = async (user: UserDto) => {
    setError(null);
    try {
      await api.patch(`/api/users/${user.id}`, { disabled: !user.disabled });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user');
    }
  };

  const resetPassword = async (password: string) => {
    if (!resetting) return;
    setError(null);
    try {
      await api.patch(`/api/users/${resetting.id}`, { password });
      setResetting(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
    }
  };

  const resetTotp = async (user: UserDto) => {
    setError(null);
    try {
      await api.patch(`/api/users/${user.id}`, { resetTotp: true });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset 2FA');
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await api.delete(`/api/users/${deleting.id}`);
      setDeleting(null);
      load();
    } catch (err) {
      setDeleting(null);
      setError(err instanceof Error ? err.message : 'Failed to delete user');
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1>Users</h1>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          + New user
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Status</th>
              <th>2FA</th>
              <th>Last login</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className={user.disabled ? 'row-disabled' : ''}>
                <td>
                  {user.username}
                  {user.id === me?.id && <span className="muted"> (you)</span>}
                </td>
                <td>
                  <select
                    value={user.role}
                    onChange={(e) => void setRole(user, e.target.value as Role)}
                    disabled={user.id === me?.id}
                  >
                    <option value="admin">admin</option>
                    <option value="operator">operator</option>
                    <option value="viewer">viewer</option>
                  </select>
                </td>
                <td>{user.disabled ? 'Disabled' : 'Active'}</td>
                <td>
                  {user.totpEnabled ? (
                    <span className="badge status-running">on</span>
                  ) : (
                    <span className="muted">off</span>
                  )}
                </td>
                <td className="muted">{formatDate(user.lastLoginAt)}</td>
                <td className="row-actions">
                  <button className="btn btn-small" onClick={() => setResetting(user)}>
                    Reset password
                  </button>
                  {user.totpEnabled && (
                    <button className="btn btn-small" onClick={() => void resetTotp(user)}>
                      Reset 2FA
                    </button>
                  )}
                  {user.id !== me?.id && (
                    <>
                      <button className="btn btn-small" onClick={() => void toggleDisabled(user)}>
                        {user.disabled ? 'Enable' : 'Disable'}
                      </button>
                      <button
                        className="btn btn-small btn-danger"
                        onClick={() => setDeleting(user)}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card role-help">
        <h3>Roles</h3>
        <ul>
          <li>
            <strong>admin</strong> — full access, including users and creating/deleting servers
          </li>
          <li>
            <strong>operator</strong> — start/stop/restart/update servers, edit configs, files,
            backups
          </li>
          <li>
            <strong>viewer</strong> — read-only access to dashboards, logs and files
          </li>
        </ul>
      </div>

      {showCreate && (
        <div className="modal-backdrop" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>New user</h3>
            <div className="form-row">
              <label>Username</label>
              <input
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                autoFocus
              />
            </div>
            <div className="form-row">
              <label>Password (min. 10 characters)</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="form-row">
              <label>Role</label>
              <select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
                <option value="admin">admin</option>
                <option value="operator">operator</option>
                <option value="viewer">viewer</option>
              </select>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowCreate(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void create()}
                disabled={newUsername.trim().length < 2 || newPassword.length < 10}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {resetting && (
        <PasswordResetDialog
          user={resetting}
          onSubmit={resetPassword}
          onCancel={() => setResetting(null)}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete user"
          message={
            <>
              Delete user <strong>{deleting.username}</strong>? Their sessions are revoked
              immediately.
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

function PasswordResetDialog({
  user,
  onSubmit,
  onCancel,
}: {
  user: UserDto;
  onSubmit(password: string): void;
  onCancel(): void;
}) {
  const [password, setPassword] = useState('');
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Reset password for {user.username}</h3>
        <div className="form-row">
          <label>New password (min. 10 characters)</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={password.length < 10}
            onClick={() => onSubmit(password)}
          >
            Reset password
          </button>
        </div>
      </div>
    </div>
  );
}
