import { describe, expect, it } from 'vitest';
import { parseTemplate, type GameTemplate } from '@gamedock/game-templates';
import {
  buildStartCommand,
  resolveVariableValues,
  substitutePlaceholders,
  UnknownPlaceholderError,
} from './variables.js';

function makeTemplate(overrides: Record<string, unknown> = {}): GameTemplate {
  return parseTemplate({
    id: 'test-game',
    name: 'Test Game',
    installMethod: 'manual',
    os: ['linux'],
    ports: [],
    start: {
      executable: './server_bin',
      args: ['-name', '{{SERVER_NAME}}', '-port', '{{PORT}}', '-password', '{{PASSWORD}}'],
      workingDir: '.',
    },
    env: { LD_LIBRARY_PATH: './linux64' },
    stop: { method: 'sigterm', timeoutSeconds: 30 },
    console: { supportsInput: false },
    variables: [
      { key: 'SERVER_NAME', label: 'Name', default: 'My Server', required: true },
      { key: 'PORT', label: 'Port', default: '2456', required: true, pattern: '[0-9]{2,5}' },
      { key: 'PASSWORD', label: 'Password', default: '', required: false, secret: true },
    ],
    ...overrides,
  });
}

const baseInput = {
  instanceDir: '/srv/instances/xyz',
  instanceId: 'xyz',
  instanceName: 'my instance',
  instanceEnv: {},
};

describe('resolveVariableValues', () => {
  it('applies defaults and accepts valid values', () => {
    const tpl = makeTemplate();
    const values = resolveVariableValues(tpl, { PORT: '3000' });
    expect(values).toEqual({ SERVER_NAME: 'My Server', PORT: '3000', PASSWORD: '' });
  });

  it('rejects unknown variables', () => {
    const tpl = makeTemplate();
    expect(() => resolveVariableValues(tpl, { NOPE: 'x' })).toThrow(/Unknown variable/);
  });

  it('enforces patterns', () => {
    const tpl = makeTemplate();
    expect(() => resolveVariableValues(tpl, { PORT: 'abc' })).toThrow(/required format/);
    // Pattern must be fully anchored: partial matches are rejected.
    expect(() => resolveVariableValues(tpl, { PORT: '123; rm -rf /' })).toThrow(/required format/);
  });

  it('rejects control characters and newlines', () => {
    const tpl = makeTemplate();
    expect(() => resolveVariableValues(tpl, { SERVER_NAME: 'a\nb' })).toThrow(/control characters/);
    expect(() => resolveVariableValues(tpl, { SERVER_NAME: 'a\x00b' })).toThrow(
      /control characters/,
    );
  });
});

describe('substitutePlaceholders', () => {
  it('replaces known placeholders', () => {
    expect(substitutePlaceholders('port={{PORT}}', { PORT: '1234' })).toBe('port=1234');
  });

  it('throws on unknown placeholders', () => {
    expect(() => substitutePlaceholders('{{MISSING}}', {})).toThrow(UnknownPlaceholderError);
  });

  it('leaves non-placeholder braces alone', () => {
    expect(substitutePlaceholders('{not a var}', {})).toBe('{not a var}');
  });
});

describe('buildStartCommand', () => {
  it('builds argv arrays without any shell interpretation', () => {
    const tpl = makeTemplate();
    const cmd = buildStartCommand({
      template: tpl,
      ...baseInput,
      variables: { SERVER_NAME: 'Fun; rm -rf / #server', PORT: '2456', PASSWORD: 'p@ss' },
    });
    expect(cmd.executable).toBe('./server_bin');
    // The dangerous-looking name stays a single argv element - no shell ever sees it.
    expect(cmd.args).toEqual([
      '-name',
      'Fun; rm -rf / #server',
      '-port',
      '2456',
      '-password',
      'p@ss',
    ]);
    expect(cmd.env.LD_LIBRARY_PATH).toBe('./linux64');
  });

  it('drops arguments that resolve to empty strings', () => {
    const tpl = makeTemplate();
    const cmd = buildStartCommand({
      template: tpl,
      ...baseInput,
      variables: { SERVER_NAME: 'x y', PORT: '2456', PASSWORD: '' },
    });
    expect(cmd.args).toEqual(['-name', 'x y', '-port', '2456', '-password']);
  });

  it('omits conditional args when their gate variable is empty, includes them when set', () => {
    const tpl = makeTemplate({
      start: {
        executable: './bin',
        args: [
          'Map?listen',
          '-server',
          { value: '-automanagedmods', omitIfEmpty: 'MODS' },
          { value: '-clusterid={{CLUSTER}}', omitIfEmpty: 'CLUSTER' },
        ],
        workingDir: '.',
      },
      variables: [
        { key: 'MODS', label: 'Mods', default: '', required: false },
        { key: 'CLUSTER', label: 'Cluster', default: '', required: false },
      ],
    });

    const off = buildStartCommand({
      template: tpl,
      ...baseInput,
      variables: { MODS: '', CLUSTER: '' },
    });
    expect(off.args).toEqual(['Map?listen', '-server']);

    const on = buildStartCommand({
      template: tpl,
      ...baseInput,
      variables: { MODS: '123,456', CLUSTER: 'my-cluster' },
    });
    expect(on.args).toEqual(['Map?listen', '-server', '-automanagedmods', '-clusterid=my-cluster']);
  });

  it('exposes GAMEDOCK_CLUSTER_DIR when a cluster dir is configured', () => {
    const tpl = makeTemplate({
      start: {
        executable: './bin',
        args: ['-ClusterDirOverride={{GAMEDOCK_CLUSTER_DIR}}'],
        workingDir: '.',
      },
      variables: [],
    });
    const cmd = buildStartCommand({
      template: tpl,
      ...baseInput,
      clusterDir: '/var/lib/gamedock/clusters',
      variables: {},
    });
    expect(cmd.args).toEqual(['-ClusterDirOverride=/var/lib/gamedock/clusters']);
  });

  it('provides built-in GAMEDOCK_* variables', () => {
    const tpl = makeTemplate({
      start: {
        executable: './bin',
        args: ['-world', '{{GAMEDOCK_INSTANCE_DIR}}/worlds/w.wld'],
        workingDir: '.',
      },
      variables: [],
    });
    const cmd = buildStartCommand({ template: tpl, ...baseInput, variables: {} });
    expect(cmd.args).toEqual(['-world', '/srv/instances/xyz/worlds/w.wld']);
  });

  it('applies startup overrides from the instance', () => {
    const tpl = makeTemplate();
    const cmd = buildStartCommand({
      template: tpl,
      ...baseInput,
      variables: { SERVER_NAME: 'n', PORT: '2456', PASSWORD: '' },
      overrideExecutable: './custom_bin',
      overrideArgs: ['--flag'],
    });
    expect(cmd.executable).toBe('./custom_bin');
    expect(cmd.args).toEqual(['--flag']);
  });

  it('rejects invalid instance env var names', () => {
    const tpl = makeTemplate();
    expect(() =>
      buildStartCommand({
        template: tpl,
        ...baseInput,
        instanceEnv: { 'BAD NAME': 'x' },
        variables: { SERVER_NAME: 'n', PORT: '2456', PASSWORD: '' },
      }),
    ).toThrow(/Invalid environment variable name/);
  });

  it('rejects control characters in resolved arguments', () => {
    const tpl = makeTemplate({
      start: { executable: './bin', args: ['{{SERVER_NAME}}'], workingDir: '.' },
      variables: [{ key: 'SERVER_NAME', label: 'n', default: 'ok', required: true }],
    });
    expect(() =>
      buildStartCommand({
        template: tpl,
        ...baseInput,
        variables: { SERVER_NAME: 'evil\x07value' },
      }),
    ).toThrow(/control characters/);
  });
});
