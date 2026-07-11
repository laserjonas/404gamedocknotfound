import { describe, expect, it } from 'vitest';
import { buildSpawnInvocation } from './processManager.js';
import type { StartCommand } from './variables.js';

const command: StartCommand = {
  executable: './server_bin',
  args: ['-port', '2456'],
  workingDir: '.',
  env: { LD_LIBRARY_PATH: './linux64' },
};

const base = {
  instanceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  instanceDir: '/var/lib/gamedock/instances/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  command,
};

describe('buildSpawnInvocation', () => {
  it('runs shared-user instances directly, env handled by the caller', () => {
    const inv = buildSpawnInvocation({ ...base, linuxUsername: null });
    expect(inv).toEqual({ file: './server_bin', args: ['-port', '2456'] });
  });

  it('wraps isolated instances in sudo + env with HOME anchored to the instance dir', () => {
    const inv = buildSpawnInvocation({ ...base, linuxUsername: 'gd-00001' });
    expect(inv.file).toBe('sudo');
    expect(inv.args).toEqual([
      '-n',
      '-u',
      'gd-00001',
      '--',
      '/usr/bin/env',
      `HOME=${base.instanceDir}`,
      'LD_LIBRARY_PATH=./linux64',
      './server_bin',
      '-port',
      '2456',
    ]);
  });

  it('routes through the resource-limit wrapper when a limit is set', () => {
    const inv = buildSpawnInvocation({
      ...base,
      linuxUsername: 'gd-00001',
      limits: { memoryMaxMb: 4096, cpuQuotaPercent: 200 },
    });
    expect(inv.file).toBe('sudo');
    expect(inv.args.slice(0, 7)).toEqual([
      '-n',
      '/usr/local/sbin/gamedock-instance-run',
      base.instanceId,
      '4096',
      '200',
      '--',
      '/usr/bin/env',
    ]);
    expect(inv.args).toContain('./server_bin');
  });

  it('passes 0 for an unlimited axis when only one limit is set', () => {
    const inv = buildSpawnInvocation({
      ...base,
      linuxUsername: 'gd-00001',
      limits: { memoryMaxMb: 2048, cpuQuotaPercent: null },
    });
    expect(inv.args.slice(1, 5)).toEqual([
      '/usr/local/sbin/gamedock-instance-run',
      base.instanceId,
      '2048',
      '0',
    ]);
  });

  it('uses the plain sudo path when limits are null/absent', () => {
    const withNulls = buildSpawnInvocation({
      ...base,
      linuxUsername: 'gd-00001',
      limits: { memoryMaxMb: null, cpuQuotaPercent: null },
    });
    expect(withNulls.args.slice(0, 3)).toEqual(['-n', '-u', 'gd-00001']);
  });
});
