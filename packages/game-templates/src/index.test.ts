import { describe, expect, it } from 'vitest';
import { builtinTemplateDir, loadTemplates, parseTemplate, TemplateParseError } from './index.js';

const validTemplate = {
  id: 'my-game',
  name: 'My Game',
  installMethod: 'steamcmd',
  steam: { appId: 123456, anonymous: true },
  os: ['linux'],
  ports: [{ name: 'Game', port: 27015, protocol: 'udp' }],
  start: { executable: './run', args: ['-port', '{{PORT}}'], workingDir: '.' },
  env: {},
  stop: { method: 'sigterm', timeoutSeconds: 30 },
  console: { supportsInput: false },
  variables: [{ key: 'PORT', label: 'Port', default: '27015', required: true }],
};

describe('parseTemplate', () => {
  it('parses a valid template and applies defaults', () => {
    const tpl = parseTemplate(validTemplate);
    expect(tpl.id).toBe('my-game');
    expect(tpl.configFiles).toEqual([]);
    expect(tpl.setupFiles).toEqual([]);
    expect(tpl.description).toBe('');
  });

  it('rejects steamcmd templates without a steam section', () => {
    const { steam: _steam, ...withoutSteam } = validTemplate;
    expect(() => parseTemplate(withoutSteam)).toThrow(TemplateParseError);
    expect(() => parseTemplate(withoutSteam)).toThrow(/steam/);
  });

  it('rejects url templates without a urlInstall section', () => {
    expect(() => parseTemplate({ ...validTemplate, installMethod: 'url' })).toThrow(/urlInstall/);
  });

  it('rejects urlInstall with neither url nor resolver', () => {
    expect(() =>
      parseTemplate({
        ...validTemplate,
        installMethod: 'url',
        urlInstall: { archive: 'none' },
      }),
    ).toThrow(/requires either "url" or "resolver"/);
  });

  it('accepts urlInstall with a resolver and matching versionVariable', () => {
    const tpl = parseTemplate({
      ...validTemplate,
      installMethod: 'url',
      urlInstall: {
        resolver: 'mojang-version-manifest',
        versionVariable: 'PORT',
        archive: 'none',
      },
    });
    expect(tpl.urlInstall?.resolver).toBe('mojang-version-manifest');
  });

  it('rejects a resolver without versionVariable', () => {
    expect(() =>
      parseTemplate({
        ...validTemplate,
        installMethod: 'url',
        urlInstall: { resolver: 'mojang-version-manifest', archive: 'none' },
      }),
    ).toThrow(/versionVariable/);
  });

  it('rejects a versionVariable that does not match a declared variable', () => {
    expect(() =>
      parseTemplate({
        ...validTemplate,
        installMethod: 'url',
        urlInstall: {
          resolver: 'mojang-version-manifest',
          versionVariable: 'NOT_DECLARED',
          archive: 'none',
        },
      }),
    ).toThrow(/does not match any declared variable/);
  });

  it('rejects stop-by-command without console input support', () => {
    expect(() =>
      parseTemplate({
        ...validTemplate,
        stop: { method: 'command', command: 'stop', timeoutSeconds: 30 },
        console: { supportsInput: false },
      }),
    ).toThrow(/supportsInput/);
  });

  it('rejects stop-by-command without a command', () => {
    expect(() =>
      parseTemplate({
        ...validTemplate,
        stop: { method: 'command', timeoutSeconds: 30 },
        console: { supportsInput: true },
      }),
    ).toThrow(/stop.command/);
  });

  it('rejects invalid template ids', () => {
    expect(() => parseTemplate({ ...validTemplate, id: 'Bad Id!' })).toThrow(TemplateParseError);
    expect(() => parseTemplate({ ...validTemplate, id: '../evil' })).toThrow(TemplateParseError);
  });

  it('rejects lowercase variable keys', () => {
    expect(() =>
      parseTemplate({
        ...validTemplate,
        variables: [{ key: 'port', label: 'Port', default: '1', required: true }],
      }),
    ).toThrow(/UPPER_SNAKE_CASE/);
  });

  it('rejects duplicate variable keys', () => {
    expect(() =>
      parseTemplate({
        ...validTemplate,
        variables: [
          { key: 'PORT', label: 'Port', default: '1', required: true },
          { key: 'PORT', label: 'Port again', default: '2', required: true },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it('rejects invalid port numbers', () => {
    expect(() =>
      parseTemplate({
        ...validTemplate,
        ports: [{ name: 'Game', port: 70000, protocol: 'udp' }],
      }),
    ).toThrow(TemplateParseError);
  });
});

describe('built-in templates', () => {
  it('all ship valid and include the expected games', () => {
    const { templates, errors } = loadTemplates([builtinTemplateDir()]);
    expect(errors).toEqual([]);
    const ids = templates.map((t) => t.id).sort();
    expect(ids).toEqual([
      '7-days-to-die',
      'ark-survival-evolved',
      'barotrauma',
      'counter-strike-2',
      'factorio',
      'garrys-mod',
      'insurgency-sandstorm',
      'left-4-dead-2',
      'minecraft-java',
      'minecraft-modded',
      'palworld',
      'project-zomboid',
      'rust',
      'satisfactory',
      'squad',
      'team-fortress-2',
      'terraria',
      'unturned',
      'valheim',
    ]);
  });

  it('steamcmd templates all have app ids', () => {
    const { templates } = loadTemplates([builtinTemplateDir()]);
    for (const tpl of templates.filter((t) => t.installMethod === 'steamcmd')) {
      expect(tpl.steam?.appId).toBeGreaterThan(0);
    }
  });
});
