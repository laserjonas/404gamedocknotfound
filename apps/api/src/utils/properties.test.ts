import { describe, expect, it } from 'vitest';
import { mergeProperties } from './properties.js';

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
