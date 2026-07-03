import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GameTemplateDto, InstanceDto } from '@gamedock/shared';
import { api } from '../api';

export function CreateServerPage() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<GameTemplateDto[]>([]);
  const [step, setStep] = useState<1 | 2>(1);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<GameTemplateDto[]>('/api/templates')
      .then(setTemplates)
      .catch(() => {});
  }, []);

  const template = useMemo(
    () => templates.find((t) => t.id === templateId) ?? null,
    [templates, templateId],
  );

  const chooseTemplate = (id: string) => {
    setTemplateId(id);
    const tpl = templates.find((t) => t.id === id);
    if (tpl) {
      setVariables(Object.fromEntries(tpl.variables.map((v) => [v.key, v.default])));
      if (!name) setName(tpl.name.replace(/ (Dedicated|Headless)? ?Server$/i, ''));
    }
    setStep(2);
  };

  const create = async () => {
    if (!template) return;
    setError(null);
    setBusy(true);
    try {
      const instance = await api.post<InstanceDto>('/api/instances', {
        name: name.trim(),
        templateId: template.id,
        variables,
      });
      navigate(`/servers/${instance.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create server');
      setBusy(false);
    }
  };

  return (
    <div>
      <h1>New server</h1>

      {step === 1 && (
        <>
          <p className="muted">Choose a game template:</p>
          <div className="template-grid">
            {templates.map((tpl) => (
              <button key={tpl.id} className="template-card" onClick={() => chooseTemplate(tpl.id)}>
                <div className="template-name">{tpl.name}</div>
                <div className="template-desc">{tpl.description}</div>
                <div className="template-meta">
                  {tpl.installMethod === 'steamcmd'
                    ? `SteamCMD · App ${tpl.steam?.appId}`
                    : tpl.installMethod === 'url'
                      ? 'Direct download'
                      : 'Manual install'}
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {step === 2 && template && (
        <div className="card form-card">
          <h2>{template.name}</h2>
          {template.notes && <p className="template-notes">{template.notes}</p>}

          <div className="form-row">
            <label>Server name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
          </div>

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
              />
              {variable.description && <div className="field-hint">{variable.description}</div>}
            </div>
          ))}

          <div className="form-row">
            <label>Default ports</label>
            <div className="muted">
              {template.ports.map((p) => `${p.name}: ${p.port}/${p.protocol}`).join(' · ') ||
                'none'}
            </div>
            <div className="field-hint">
              Automatically moved to the next free ports if another server already uses them.
            </div>
          </div>

          {error && <div className="error-text">{error}</div>}

          <div className="modal-actions">
            <button className="btn" onClick={() => setStep(1)}>
              Back
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void create()}
              disabled={busy || name.trim().length < 2}
            >
              {busy ? 'Creating...' : 'Create server'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
