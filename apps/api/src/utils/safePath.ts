import { resolve, sep, normalize } from 'node:path';

export class PathTraversalError extends Error {
  constructor(public readonly attemptedPath: string) {
    super('Path escapes the allowed directory');
    this.name = 'PathTraversalError';
  }
}

function normalizeForCompare(p: string): string {
  // Windows paths are case-insensitive; normalize for containment checks.
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Resolve a user-supplied relative path against a root directory and
 * guarantee the result stays inside the root. Throws PathTraversalError
 * on any escape attempt (.., absolute paths, null bytes, drive letters).
 */
export function resolveSafePath(rootDir: string, userPath: string): string {
  if (userPath.includes('\0')) {
    throw new PathTraversalError(userPath);
  }
  // Normalize separators so "..\\" tricks behave the same everywhere.
  const cleaned = userPath.replace(/\\/g, '/');
  const root = resolve(rootDir);
  const resolved = resolve(root, cleaned);

  const rootCmp = normalizeForCompare(root);
  const resolvedCmp = normalizeForCompare(resolved);
  if (resolvedCmp !== rootCmp && !resolvedCmp.startsWith(rootCmp + sep)) {
    throw new PathTraversalError(userPath);
  }
  return resolved;
}

/** Path relative to the root (with forward slashes) for API responses. */
export function toRelativePath(rootDir: string, absolutePath: string): string {
  const root = resolve(rootDir);
  const rel = absolutePath.slice(root.length).replace(/\\/g, '/');
  return rel.startsWith('/') ? rel.slice(1) : rel;
}

/**
 * Validate a single file/directory name (no separators, no traversal).
 * Used for backup archives and other server-generated names.
 */
export function isSafeName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name === '.' || name === '..') return false;
  if (/[/\\\0]/.test(name)) return false;
  return true;
}

/** Normalize and validate a relative path string from the API (client input). */
export function sanitizeRelativePath(input: string): string {
  const cleaned = normalize(input.replace(/\\/g, '/')).replace(/\\/g, '/');
  if (cleaned.startsWith('..') || cleaned.includes('\0')) {
    throw new PathTraversalError(input);
  }
  return cleaned === '.' ? '' : cleaned;
}
