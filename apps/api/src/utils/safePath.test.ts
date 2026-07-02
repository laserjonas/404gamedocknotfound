import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  PathTraversalError,
  isSafeName,
  resolveSafePath,
  sanitizeRelativePath,
  toRelativePath,
} from './safePath.js';

const ROOT = resolve(process.platform === 'win32' ? 'C:/srv/instances/abc' : '/srv/instances/abc');

describe('resolveSafePath', () => {
  it('resolves simple relative paths inside the root', () => {
    expect(resolveSafePath(ROOT, 'server.properties')).toBe(resolve(ROOT, 'server.properties'));
    expect(resolveSafePath(ROOT, 'config/server.cfg')).toBe(resolve(ROOT, 'config/server.cfg'));
    expect(resolveSafePath(ROOT, '.')).toBe(ROOT);
    expect(resolveSafePath(ROOT, '')).toBe(ROOT);
  });

  it('allows .. segments that stay inside the root', () => {
    expect(resolveSafePath(ROOT, 'a/../b.txt')).toBe(resolve(ROOT, 'b.txt'));
  });

  it('blocks parent directory escapes', () => {
    expect(() => resolveSafePath(ROOT, '..')).toThrow(PathTraversalError);
    expect(() => resolveSafePath(ROOT, '../other')).toThrow(PathTraversalError);
    expect(() => resolveSafePath(ROOT, 'a/../../escape')).toThrow(PathTraversalError);
    expect(() => resolveSafePath(ROOT, '../../../../etc/passwd')).toThrow(PathTraversalError);
  });

  it('blocks backslash-based escapes', () => {
    expect(() => resolveSafePath(ROOT, '..\\..\\windows')).toThrow(PathTraversalError);
    expect(() => resolveSafePath(ROOT, 'a\\..\\..\\escape')).toThrow(PathTraversalError);
  });

  it('blocks absolute paths outside the root', () => {
    const outside = process.platform === 'win32' ? 'C:/Windows/system32' : '/etc/passwd';
    expect(() => resolveSafePath(ROOT, outside)).toThrow(PathTraversalError);
  });

  it('blocks null bytes', () => {
    expect(() => resolveSafePath(ROOT, 'file\0.txt')).toThrow(PathTraversalError);
  });

  it('blocks sibling directories with the root as prefix', () => {
    // /srv/instances/abc must not grant access to /srv/instances/abc-evil
    expect(() => resolveSafePath(ROOT, '../abc-evil/file')).toThrow(PathTraversalError);
  });
});

describe('sanitizeRelativePath', () => {
  it('normalizes and accepts safe input', () => {
    expect(sanitizeRelativePath('a/b/../c')).toBe(
      process.platform === 'win32' ? 'a\\c'.replace(/\\/g, '/') : 'a/c',
    );
    expect(sanitizeRelativePath('.')).toBe('');
  });

  it('rejects traversal after normalization', () => {
    expect(() => sanitizeRelativePath('../x')).toThrow(PathTraversalError);
    expect(() => sanitizeRelativePath('a/../../x')).toThrow(PathTraversalError);
  });
});

describe('isSafeName', () => {
  it('accepts normal file names', () => {
    expect(isSafeName('backup-2025.tar.gz')).toBe(true);
    expect(isSafeName('world.wld')).toBe(true);
  });

  it('rejects traversal and separators', () => {
    expect(isSafeName('..')).toBe(false);
    expect(isSafeName('.')).toBe(false);
    expect(isSafeName('a/b')).toBe(false);
    expect(isSafeName('a\\b')).toBe(false);
    expect(isSafeName('a\0b')).toBe(false);
    expect(isSafeName('')).toBe(false);
  });
});

describe('toRelativePath', () => {
  it('produces forward-slash relative paths', () => {
    const abs = resolve(ROOT, 'config/server.cfg');
    expect(toRelativePath(ROOT, abs)).toBe('config/server.cfg');
  });
});
