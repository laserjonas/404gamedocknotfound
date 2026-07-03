import { join } from 'node:path';
import {
  builtinTemplateDir,
  loadTemplates,
  parseTemplate,
  type GameTemplate,
} from '@gamedock/game-templates';
import type { DatabaseClient } from '../db/database.js';
import { nowIso } from '../db/database.js';
import type { Logger } from '../logger.js';
import { notFound } from '../errors.js';

/**
 * Loads game templates from the built-in package directory plus an optional
 * user directory (<dataDir>/templates) that can add new games or shadow
 * built-ins without code changes. Loaded templates are mirrored into the
 * game_templates table so other records can reference them.
 */
export class TemplateService {
  private templates = new Map<string, GameTemplate>();
  private loadErrors: { file: string; message: string }[] = [];

  constructor(
    private db: DatabaseClient,
    private dataDir: string,
    private logger: Logger,
  ) {}

  userTemplateDir(): string {
    return join(this.dataDir, 'templates');
  }

  async reload(): Promise<void> {
    const { templates, errors } = loadTemplates([builtinTemplateDir(), this.userTemplateDir()]);
    this.templates = new Map(templates.map((t) => [t.id, t]));
    this.loadErrors = errors;
    for (const err of errors) {
      this.logger.warn({ file: err.file }, `template failed to load: ${err.message}`);
    }
    await this.syncToDatabase();
    this.logger.info({ count: this.templates.size }, 'game templates loaded');
  }

  private async syncToDatabase(): Promise<void> {
    const now = nowIso();
    await this.db.transaction(async () => {
      for (const tpl of this.templates.values()) {
        await this.db.run(
          `INSERT INTO game_templates (id, name, source, definition, created_at, updated_at)
           VALUES (?, ?, 'file', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, definition = excluded.definition, updated_at = excluded.updated_at`,
          [tpl.id, tpl.name, JSON.stringify(tpl), now, now],
        );
      }
    });
  }

  list(): GameTemplate[] {
    return [...this.templates.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): GameTemplate {
    const tpl = this.templates.get(id);
    if (!tpl) throw notFound(`Unknown game template "${id}"`);
    return tpl;
  }

  has(id: string): boolean {
    return this.templates.has(id);
  }

  errors(): { file: string; message: string }[] {
    return this.loadErrors;
  }

  /** Parse a template definition snapshot stored on an instance. */
  static parseSnapshot(definition: string): GameTemplate {
    return parseTemplate(JSON.parse(definition), '<instance snapshot>');
  }
}
