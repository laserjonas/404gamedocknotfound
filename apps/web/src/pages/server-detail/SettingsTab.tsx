import { useState } from 'react';
import type { GameTemplateDto, InstanceDto } from '@gamedock/shared';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { formatDate } from '../../format';

interface SettingsTabProps {
  instance: InstanceDto;
  template: GameTemplateDto;
  onUpdated(instance: InstanceDto): void;
}

export function SettingsTab({ instance, template, onUpdated }: SettingsTabProps) {
  const { hasRole } = useAuth();
  const canEdit = hasRole('operator');

  const [name, setName] = useState(instance.name);
  const [autoStart, setAutoStart] = useState(instance.autoStart);
  const [crashRestart, setCrashRestart] = useState(instance.crashRestart);
  const [backupIntervalHours, setBackupIntervalHours] = useState(
    instance.backupIntervalHours !== null ? String(instance.backupIntervalHours) : '',
  );
  const [backupRetentionCount, setBackupRetentionCount] = useState(
    instance.backupRetentionCount !== null ? String(instance.backupRetentionCount) : '',
  );
  const [restartIntervalHours, setRestartIntervalHours] = useState(
    instance.restartIntervalHours !== null ? String(instance.restartIntervalHours) : '',
  );
  const [variables, setVariables] = useState<Record<string, string>>({ ...instance.variables });
  const [envText, setEnvText] = useState(
    Object.entries(instance.envVars)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  const [executable, setExecutable] = useState(
    instance.startExecutable ?? template.start.executable,
  );
  const [argsText, setArgsText] = useState((instance.startArgs ?? template.start.args).join('\n'));
  const [overrideStartup, setOverrideStartup] = useState(
    instance.startExecutable !== null || instance.startArgs !== null,
  );
  const [portsDraft, setPortsDraft] = useState(
    instance.ports.map((p) => ({ name: p.name, port: String(p.port), protocol: p.protocol })),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const envVars: Record<string, string> = {};
      for (const rawLine of envText.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) throw new Error(`Invalid env line: "${line}" (expected KEY=value)`);
        envVars[line.slice(0, eq).trim()] = line.slice(eq + 1);
      }

      const ports = portsDraft.map((p) => {
        const port = parseInt(p.port, 10);
        if (!p.name.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`Invalid port entry "${p.name}": ${p.port}`);
        }
        return { name: p.name.trim(), port, protocol: p.protocol };
      });

      const parseOptionalCount = (text: string, label: string, max: number) => {
        const trimmed = text.trim();
        if (trimmed === '') return null;
        const value = parseInt(trimmed, 10);
        if (!Number.isInteger(value) || value < 1 || value > max) {
          throw new Error(`${label} must be a number between 1 and ${max}, or blank`);
        }
        return value;
      };

      const updated = await api.patch<InstanceDto>(`/api/instances/${instance.id}`, {
        name: name.trim(),
        autoStart,
        crashRestart,
        backupIntervalHours: parseOptionalCount(backupIntervalHours, 'Backup interval', 8760),
        backupRetentionCount: parseOptionalCount(backupRetentionCount, 'Backup retention', 1000),
        restartIntervalHours: parseOptionalCount(restartIntervalHours, 'Restart interval', 8760),
        variables,
        envVars,
        ports,
        startExecutable: overrideStartup ? executable : null,
        startArgs: overrideStartup
          ? argsText
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
          : null,
      });
      onUpdated(updated);
      setVariables({ ...updated.variables });
      setMessage('Settings saved. They apply on the next server start.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-tab">
      <div className="card">
        <h3>General</h3>
        <div className="form-row">
          <label>Server name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={autoStart}
            onChange={(e) => setAutoStart(e.target.checked)}
            disabled={!canEdit}
          />
          Start automatically when GameDock starts
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={crashRestart}
            onChange={(e) => setCrashRestart(e.target.checked)}
            disabled={!canEdit}
          />
          Automatically restart if the server crashes
        </label>
        <div className="field-hint">
          Restarts a few seconds after an unexpected exit, up to 4 times within 5 minutes - if it
          keeps crashing beyond that, GameDock stops trying and leaves it stopped so you can check
          the console.
        </div>
      </div>

      <div className="card">
        <h3>Automatic backups</h3>
        <div className="form-row">
          <label>Back up every N hours (blank = disabled)</label>
          <input
            value={backupIntervalHours}
            onChange={(e) => setBackupIntervalHours(e.target.value)}
            disabled={!canEdit}
            placeholder="e.g. 24"
            style={{ width: 120 }}
          />
        </div>
        <div className="form-row">
          <label>Keep last N backups (blank = keep all)</label>
          <input
            value={backupRetentionCount}
            onChange={(e) => setBackupRetentionCount(e.target.value)}
            disabled={!canEdit}
            placeholder="e.g. 7"
            style={{ width: 120 }}
          />
        </div>
        <div className="field-hint">
          Applies to manual backups too - GameDock checks schedules every few minutes, so a backup
          may run a little after it's technically due. Old backups beyond the keep count are deleted
          right after each new one succeeds.
        </div>
      </div>

      <div className="card">
        <h3>Scheduled restart</h3>
        <div className="form-row">
          <label>Restart every N hours while running (blank = disabled)</label>
          <input
            value={restartIntervalHours}
            onChange={(e) => setRestartIntervalHours(e.target.value)}
            disabled={!canEdit}
            placeholder="e.g. 24"
            style={{ width: 120 }}
          />
        </div>
        <div className="field-hint">
          Only restarts while the server is already running - an installed-but-stopped server stays
          stopped. The clock starts fresh (no immediate restart) whenever this is turned on or
          changed, then resets on every restart, scheduled or manual.
          {instance.lastScheduledRestartAt && (
            <> Clock last reset: {formatDate(instance.lastScheduledRestartAt)}.</>
          )}
        </div>
      </div>

      {template.variables.length > 0 && (
        <div className="card">
          <h3>Game settings</h3>
          {template.variables.map((variable) => (
            <div className="form-row" key={variable.key}>
              <label>
                {variable.label}
                {variable.required && <span className="required">*</span>}
              </label>
              <input
                type={variable.secret ? 'password' : 'text'}
                value={variables[variable.key] ?? ''}
                onChange={(e) =>
                  setVariables((prev) => ({ ...prev, [variable.key]: e.target.value }))
                }
                disabled={!canEdit}
              />
              {variable.description && <div className="field-hint">{variable.description}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h3>Startup command</h3>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={overrideStartup}
            onChange={(e) => setOverrideStartup(e.target.checked)}
            disabled={!canEdit}
          />
          Override the template startup command
        </label>
        <div className="form-row">
          <label>Executable</label>
          <input
            value={executable}
            onChange={(e) => setExecutable(e.target.value)}
            disabled={!canEdit || !overrideStartup}
          />
          {template.urlInstall?.resolver && (
            <div className="field-hint">
              This template resolves a version-specific runtime automatically (e.g. the matching
              Java build for the selected Minecraft version) — it's set here as an instance override
              and gets refreshed every time you click Install files / Update files. You normally
              don't need to change it.
            </div>
          )}
        </div>
        <div className="form-row">
          <label>Arguments (one per line, {'{{VAR}}'} placeholders allowed)</label>
          <textarea
            rows={8}
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            disabled={!canEdit || !overrideStartup}
            spellCheck={false}
          />
          <div className="field-hint">
            Each line is passed as a single argument — no shell quoting needed or possible.
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Environment variables</h3>
        <div className="form-row">
          <textarea
            rows={5}
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            placeholder={'KEY=value\nANOTHER_KEY=value'}
            disabled={!canEdit}
            spellCheck={false}
          />
        </div>
      </div>

      <div className="card">
        <h3>Ports</h3>
        <div className="field-hint">
          Documentation for you and your firewall — changing these does not reconfigure the game.
          Adjust the matching game setting above or in the config file too.
        </div>
        {portsDraft.map((port, i) => (
          <div className="form-row-inline" key={i}>
            <input
              value={port.name}
              placeholder="Name"
              onChange={(e) =>
                setPortsDraft((prev) =>
                  prev.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)),
                )
              }
              disabled={!canEdit}
            />
            <input
              value={port.port}
              placeholder="Port"
              style={{ width: 90 }}
              onChange={(e) =>
                setPortsDraft((prev) =>
                  prev.map((p, j) => (j === i ? { ...p, port: e.target.value } : p)),
                )
              }
              disabled={!canEdit}
            />
            <select
              value={port.protocol}
              onChange={(e) =>
                setPortsDraft((prev) =>
                  prev.map((p, j) =>
                    j === i ? { ...p, protocol: e.target.value as typeof p.protocol } : p,
                  ),
                )
              }
              disabled={!canEdit}
            >
              <option value="tcp">tcp</option>
              <option value="udp">udp</option>
              <option value="both">both</option>
            </select>
            {canEdit && (
              <button
                className="btn btn-small btn-danger"
                onClick={() => setPortsDraft((prev) => prev.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        {canEdit && (
          <button
            className="btn btn-small"
            onClick={() =>
              setPortsDraft((prev) => [...prev, { name: '', port: '', protocol: 'tcp' as const }])
            }
          >
            + Add port
          </button>
        )}
      </div>

      {template.configFiles.length > 0 && (
        <div className="card">
          <h3>Config files</h3>
          <ul className="config-file-list">
            {template.configFiles.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code>
                <span className="muted"> — {file.description}</span>
                {file.createdByServer && <span className="muted"> (created after first run)</span>}
              </li>
            ))}
          </ul>
          <div className="field-hint">Edit these in the Files tab.</div>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}
      {message && <div className="success-text">{message}</div>}

      {canEdit && (
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving...' : 'Save settings'}
        </button>
      )}
    </div>
  );
}
