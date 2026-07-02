import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GameTemplateDto, InstanceDto, SteamCatalogResponseDto } from '@gamedock/shared';
import { api } from '../api';

const CATALOG_PAGE_SIZE = 30;

export function CreateServerPage() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<GameTemplateDto[]>([]);
  const [step, setStep] = useState<1 | 2>(1);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalog, setCatalog] = useState<SteamCatalogResponseDto | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogOffset, setCatalogOffset] = useState(0);

  useEffect(() => {
    api
      .get<GameTemplateDto[]>('/api/templates')
      .then(setTemplates)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setCatalogLoading(true);
      api
        .get<SteamCatalogResponseDto>(
          `/api/steam/catalog?search=${encodeURIComponent(catalogSearch)}&limit=${CATALOG_PAGE_SIZE}&offset=${catalogOffset}`,
        )
        .then((res) =>
          setCatalog((prev) =>
            catalogOffset === 0 || !prev ? res : { ...res, items: [...prev.items, ...res.items] },
          ),
        )
        .catch(() => setError('Failed to load the Steam catalog'))
        .finally(() => setCatalogLoading(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [catalogSearch, catalogOffset]);

  useEffect(() => {
    setCatalogOffset(0);
    setCatalog(null);
  }, [catalogSearch]);

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

          <h2 style={{ marginTop: 28 }}>Browse Steam dedicated servers</h2>
          <p className="muted">
            Every Steam "Dedicated Server" tool, downloadable via SteamCMD's anonymous login (no
            Steam account needed). Green entries are ready to install now; the rest are shown for
            discovery only - GameDock doesn't yet know how to start/stop them.
          </p>
          <div className="steam-catalog-search">
            <input
              placeholder="Search Steam dedicated servers..."
              value={catalogSearch}
              onChange={(e) => setCatalogSearch(e.target.value)}
            />
            {catalogLoading && <span className="muted">Loading...</span>}
            {catalog && (
              <span className="muted">
                {catalog.total} found
                {catalog.stale ? ' (cached, refresh failed)' : ''}
              </span>
            )}
          </div>

          {error && <div className="error-text">{error}</div>}

          <div className="steam-catalog-grid">
            {(catalog?.items ?? []).map((entry) => (
              <button
                key={entry.appId}
                className={`steam-catalog-card ${entry.templateId ? 'is-installable' : 'is-disabled'}`}
                disabled={!entry.templateId}
                onClick={() => entry.templateId && chooseTemplate(entry.templateId)}
                title={
                  entry.templateId
                    ? 'Click to configure and install'
                    : 'Not yet supported in GameDock'
                }
              >
                <img
                  src={entry.headerImageUrl}
                  alt=""
                  loading="lazy"
                  onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
                />
                <div className="steam-catalog-card-body">
                  <div
                    className={`steam-catalog-card-badge ${entry.templateId ? 'installable' : 'not-supported'}`}
                  >
                    {entry.templateId ? 'Ready to install' : 'Not yet supported'}
                  </div>
                  <div className="steam-catalog-card-name">{entry.name}</div>
                  <div className="steam-catalog-card-meta">App {entry.appId}</div>
                </div>
              </button>
            ))}
          </div>

          {catalog && catalog.items.length < catalog.total && (
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button
                className="btn"
                disabled={catalogLoading}
                onClick={() => setCatalogOffset((prev) => prev + CATALOG_PAGE_SIZE)}
              >
                Load more
              </button>
            </div>
          )}
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
