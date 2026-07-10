import { describe, expect, it } from 'vitest';
import { mergeIni, mergeProperties } from './properties.js';

describe('mergeProperties', () => {
  it('replaces the managed key in place, preserving everything else', () => {
    const existing =
      '# Minecraft server properties\nmotd=A curated pack\nserver-port=25565\nview-distance=12\n';
    const merged = mergeProperties(existing, 'server-port=25570\n');
    expect(merged).toBe(
      '# Minecraft server properties\nmotd=A curated pack\nserver-port=25570\nview-distance=12\n',
    );
  });

  it('appends managed keys that are not in the file yet', () => {
    const merged = mergeProperties(
      'motd=hello\n',
      '# comment in managed content\nserver-port=25570\n',
    );
    expect(merged).toBe('motd=hello\nserver-port=25570\n');
  });

  it('returns just the managed lines for an empty file', () => {
    expect(mergeProperties('', 'server-port=25570\n')).toBe('server-port=25570\n');
  });

  it('ignores commented-out lines when matching keys', () => {
    const existing = '# server-port=1111\nserver-port=2222\n';
    const merged = mergeProperties(existing, 'server-port=3333\n');
    expect(merged).toBe('# server-port=1111\nserver-port=3333\n');
  });
});

describe('mergeIni', () => {
  const managed = '[ServerSettings]\nActiveMods=123,456\n';

  it('replaces the key inside the right section only', () => {
    const existing = [
      '[SessionSettings]',
      'SessionName=My ARK',
      'ActiveMods=in-wrong-section',
      '[ServerSettings]',
      'ServerPassword=secret',
      'ActiveMods=999',
      'MaxPlayers=70',
      '',
    ].join('\n');
    expect(mergeIni(existing, managed)).toBe(
      [
        '[SessionSettings]',
        'SessionName=My ARK',
        'ActiveMods=in-wrong-section',
        '[ServerSettings]',
        'ServerPassword=secret',
        'ActiveMods=123,456',
        'MaxPlayers=70',
        '',
      ].join('\n'),
    );
  });

  it('appends a missing key to its existing section', () => {
    const existing = '[ServerSettings]\nMaxPlayers=70\n[MessageOfTheDay]\nMessage=hi\n';
    expect(mergeIni(existing, managed)).toBe(
      '[ServerSettings]\nMaxPlayers=70\nActiveMods=123,456\n[MessageOfTheDay]\nMessage=hi\n',
    );
  });

  it('appends a whole missing section at the end', () => {
    const existing = '[MessageOfTheDay]\nMessage=hi\n';
    expect(mergeIni(existing, managed)).toBe(
      '[MessageOfTheDay]\nMessage=hi\n[ServerSettings]\nActiveMods=123,456\n',
    );
  });

  it('returns the managed content verbatim for an empty file', () => {
    expect(mergeIni('', managed)).toBe(managed);
    expect(mergeIni('  \n', managed)).toBe(managed);
  });

  it('preserves comments and unrelated content', () => {
    const existing = '; ARK config\n[ServerSettings]\n; ActiveMods=commented\nActiveMods=1\n';
    expect(mergeIni(existing, managed)).toBe(
      '; ARK config\n[ServerSettings]\n; ActiveMods=commented\nActiveMods=123,456\n',
    );
  });
});
