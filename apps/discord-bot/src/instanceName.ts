import { randomBytes } from 'node:crypto';

const MAX_NAME_LENGTH = 64;

/**
 * Derives a GameDock-safe instance name from a Discord user id and template
 * id - never the raw Discord display name, which can contain characters
 * (unicode, emoji) outside GameDock's INSTANCE_NAME_RE
 * (`apps/api/src/services/instances.ts`: `/^[A-Za-z0-9][A-Za-z0-9 _.-]{1,63}$/`).
 * Every component here is already restricted to that charset, so any
 * length-64 prefix of the result still satisfies the pattern.
 */
export function deriveInstanceName(discordUserId: string, templateId: string): string {
  const safeTemplateId = templateId.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 24) || 'server';
  const suffix = randomBytes(3).toString('hex');
  return `discord-${discordUserId}-${safeTemplateId}-${suffix}`.slice(0, MAX_NAME_LENGTH);
}
