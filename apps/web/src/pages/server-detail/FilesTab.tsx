import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntryDto } from '@gamedock/shared';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { ConfirmDialog } from '../../components/Confirm';
import { formatBytes, formatDate } from '../../format';

export function FilesTab({ instanceId }: { instanceId: string }) {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntryDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ path: string; content: string } | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [deleting, setDeleting] = useState<FileEntryDto | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [renaming, setRenaming] = useState<FileEntryDto | null>(null);
  const [renameTarget, setRenameTarget] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { hasRole } = useAuth();
  const canEdit = hasRole('operator');

  const load = useCallback(
    (p: string) => {
      setError(null);
      api
        .get<FileEntryDto[]>(`/api/instances/${instanceId}/files?path=${encodeURIComponent(p)}`)
        .then(setEntries)
        .catch((err) => setError(err instanceof Error ? err.message : 'Failed to list files'));
    },
    [instanceId],
  );

  useEffect(() => load(path), [load, path]);

  const openEntry = (entry: FileEntryDto) => {
    if (entry.type === 'directory') {
      setPath(entry.path);
      return;
    }
    api
      .get<{ path: string; content: string }>(
        `/api/instances/${instanceId}/files/content?path=${encodeURIComponent(entry.path)}`,
      )
      .then((data) => {
        setEditing(data);
        setEditorDirty(false);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Cannot open file'));
  };

  const saveFile = async () => {
    if (!editing) return;
    try {
      await api.put(`/api/instances/${instanceId}/files/content`, editing);
      setEditorDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const upload = async (file: File) => {
    const form = new FormData();
    form.append('path', path);
    form.append('file', file);
    try {
      await api.post(`/api/instances/${instanceId}/files/upload`, form);
      load(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await api.delete(
        `/api/instances/${instanceId}/files?path=${encodeURIComponent(deleting.path)}`,
      );
      setDeleting(null);
      load(path);
    } catch (err) {
      setDeleting(null);
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const createFolder = async () => {
    const name = folderName.trim();
    if (!name) return;
    try {
      await api.post(`/api/instances/${instanceId}/files/mkdir`, {
        path: path ? `${path}/${name}` : name,
      });
      setNewFolder(false);
      setFolderName('');
      load(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder');
    }
  };

  const confirmRename = async () => {
    if (!renaming) return;
    const to = renameTarget.trim();
    if (!to || to === renaming.path) {
      setRenaming(null);
      return;
    }
    try {
      await api.post(`/api/instances/${instanceId}/files/rename`, { from: renaming.path, to });
      setRenaming(null);
      load(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
    }
  };

  const downloadUrl = (entry: FileEntryDto) =>
    `/api/instances/${instanceId}/files/download?path=${encodeURIComponent(entry.path)}`;

  const crumbs = path ? path.split('/') : [];

  return (
    <div>
      <div className="file-toolbar">
        <div className="breadcrumbs">
          <button className="link-btn" onClick={() => setPath('')}>
            root
          </button>
          {crumbs.map((crumb, i) => (
            <span key={i}>
              {' / '}
              <button
                className="link-btn"
                onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}
              >
                {crumb}
              </button>
            </span>
          ))}
        </div>
        {canEdit && (
          <div className="file-actions">
            <button className="btn btn-small" onClick={() => setNewFolder(true)}>
              New folder
            </button>
            <button className="btn btn-small" onClick={() => fileInputRef.current?.click()}>
              Upload
            </button>
            <input
              ref={fileInputRef}
              type="file"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
                e.target.value = '';
              }}
            />
          </div>
        )}
      </div>

      {error && <div className="error-text">{error}</div>}

      <table className="file-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Size</th>
            <th>Modified</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.path}>
              <td>
                <button className="link-btn" onClick={() => openEntry(entry)}>
                  {entry.type === 'directory' ? '📁 ' : '📄 '}
                  {entry.name}
                </button>
              </td>
              <td className="muted">
                {entry.type === 'file' ? formatBytes(entry.sizeBytes) : '-'}
              </td>
              <td className="muted">{formatDate(entry.modifiedAt)}</td>
              <td className="file-row-actions">
                <a
                  className="btn btn-small"
                  href={downloadUrl(entry)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download
                </a>
                {canEdit && (
                  <>
                    <button
                      className="btn btn-small"
                      onClick={() => {
                        setRenaming(entry);
                        setRenameTarget(entry.path);
                      }}
                    >
                      Rename
                    </button>
                    <button className="btn btn-small btn-danger" onClick={() => setDeleting(entry)}>
                      Delete
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                Empty directory
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editing && (
        <div className="modal-backdrop" onClick={() => !editorDirty && setEditing(null)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h3>
              {editing.path} {editorDirty && <span className="muted">(unsaved)</span>}
            </h3>
            <textarea
              className="file-editor"
              value={editing.content}
              readOnly={!canEdit}
              onChange={(e) => {
                setEditing({ ...editing, content: e.target.value });
                setEditorDirty(true);
              }}
              spellCheck={false}
            />
            <div className="modal-actions">
              <button className="btn" onClick={() => setEditing(null)}>
                Close
              </button>
              {canEdit && (
                <button
                  className="btn btn-primary"
                  onClick={() => void saveFile()}
                  disabled={!editorDirty}
                >
                  Save
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {newFolder && (
        <div className="modal-backdrop" onClick={() => setNewFolder(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>New folder</h3>
            <div className="form-row">
              <input
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                placeholder="folder name"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createFolder();
                }}
              />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setNewFolder(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void createFolder()}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {renaming && (
        <div className="modal-backdrop" onClick={() => setRenaming(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Rename / move</h3>
            <div className="form-row">
              <label htmlFor="rename-target">New path</label>
              <input
                id="rename-target"
                value={renameTarget}
                onChange={(e) => setRenameTarget(e.target.value)}
                placeholder="new/path/name"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void confirmRename();
                }}
              />
              <p className="muted">
                Edit the whole path to move{' '}
                {renaming.type === 'directory' ? 'the folder' : 'the file'} to a different location.
              </p>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setRenaming(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void confirmRename()}>
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete"
          message={
            <>
              Delete <strong>{deleting.name}</strong>
              {deleting.type === 'directory' ? ' and all of its contents' : ''}? This cannot be
              undone.
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
