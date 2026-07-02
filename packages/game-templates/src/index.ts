import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameTemplateSchema, type GameTemplate } from './schema.js';

export { gameTemplateSchema, portSchema, templateVariableSchema } from './schema.js';
export type { GameTemplate } from './schema.js';

export class TemplateParseError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`Template "${file}": ${message}`);
    this.name = 'TemplateParseError';
  }
}

/** Directory holding the built-in template JSON files, shipped with this package. */
export function builtinTemplateDir(): string {
  // dist/index.js -> package root -> templates/
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
}

export function parseTemplate(json: unknown, file = '<inline>'): GameTemplate {
  const result = gameTemplateSchema.safeParse(json);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new TemplateParseError(file, detail);
  }
  return result.data;
}

export function loadTemplateFile(filePath: string): GameTemplate {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new TemplateParseError(filePath, `cannot read file: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new TemplateParseError(filePath, `invalid JSON: ${(err as Error).message}`);
  }
  return parseTemplate(json, filePath);
}

export interface LoadResult {
  templates: GameTemplate[];
  errors: { file: string; message: string }[];
}

/**
 * Load all *.json templates from one or more directories.
 * Later directories override earlier ones when template ids collide,
 * so user template dirs can shadow built-ins.
 * Invalid templates are collected as errors instead of aborting the load.
 */
export function loadTemplates(dirs: string[] = [builtinTemplateDir()]): LoadResult {
  const byId = new Map<string, GameTemplate>();
  const errors: { file: string; message: string }[] = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    for (const file of files) {
      const full = join(dir, file);
      try {
        const tpl = loadTemplateFile(full);
        byId.set(tpl.id, tpl);
      } catch (err) {
        errors.push({ file: full, message: (err as Error).message });
      }
    }
  }

  return { templates: [...byId.values()], errors };
}
