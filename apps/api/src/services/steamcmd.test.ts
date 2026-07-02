import { describe, expect, it } from 'vitest';
import { buildSteamCmdArgs } from './steamcmd.js';

const INSTALL_DIR = process.platform === 'win32' ? 'C:/srv/instances/abc' : '/srv/instances/abc';

describe('buildSteamCmdArgs', () => {
  it('builds the documented anonymous install command', () => {
    expect(buildSteamCmdArgs({ installDir: INSTALL_DIR, appId: 896660 })).toEqual([
      '+force_install_dir',
      INSTALL_DIR,
      '+login',
      'anonymous',
      '+app_update',
      '896660',
      'validate',
      '+quit',
    ]);
  });

  it('supports extra args (beta branches) before validate', () => {
    expect(
      buildSteamCmdArgs({
        installDir: INSTALL_DIR,
        appId: 380870,
        extraArgs: ['-beta', 'unstable'],
      }),
    ).toEqual([
      '+force_install_dir',
      INSTALL_DIR,
      '+login',
      'anonymous',
      '+app_update',
      '380870',
      '-beta',
      'unstable',
      'validate',
      '+quit',
    ]);
  });

  it('can skip validate', () => {
    const args = buildSteamCmdArgs({ installDir: INSTALL_DIR, appId: 730, validate: false });
    expect(args).not.toContain('validate');
  });

  it('rejects non-positive or non-integer app ids', () => {
    expect(() => buildSteamCmdArgs({ installDir: INSTALL_DIR, appId: 0 })).toThrow();
    expect(() => buildSteamCmdArgs({ installDir: INSTALL_DIR, appId: -5 })).toThrow();
    expect(() => buildSteamCmdArgs({ installDir: INSTALL_DIR, appId: 1.5 })).toThrow();
    expect(() =>
      buildSteamCmdArgs({ installDir: INSTALL_DIR, appId: NaN as unknown as number }),
    ).toThrow();
  });

  it('rejects relative install dirs', () => {
    expect(() => buildSteamCmdArgs({ installDir: './relative', appId: 1 })).toThrow();
  });

  it('rejects newlines and quotes in extra args', () => {
    expect(() =>
      buildSteamCmdArgs({ installDir: INSTALL_DIR, appId: 1, extraArgs: ['a\nb'] }),
    ).toThrow();
    expect(() =>
      buildSteamCmdArgs({ installDir: INSTALL_DIR, appId: 1, extraArgs: ['"quoted"'] }),
    ).toThrow();
  });

  it('rejects newlines in the install dir', () => {
    expect(() =>
      buildSteamCmdArgs({ installDir: INSTALL_DIR + '\nmalicious', appId: 1 }),
    ).toThrow();
  });
});
