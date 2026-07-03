import type { RoleQuotaRow } from './db/repositories/roleQuotas.js';

/** Stored in place of a template id list to mean "every game", including
 * ones added after the quota was configured. */
export const ALL_GAMES_SENTINEL = '*';

export interface EffectiveQuota {
  maxServers: number;
  allowsAllGames: boolean;
  allowedTemplateIds: Set<string>;
  matchedRoleLabels: string[];
}

export function quotaAllowsTemplate(quota: EffectiveQuota, templateId: string): boolean {
  return quota.allowsAllGames || quota.allowedTemplateIds.has(templateId);
}

/**
 * Resolves a Discord member's effective quota from the role_quotas rows
 * matching their role memberships. When multiple roles match: the highest
 * max_servers wins (not summed - summing would let a user stack multiple
 * special roles into an unbounded limit) and allowed templates are the
 * union across all matching roles (if any matching role allows all games,
 * the effective quota allows all games too).
 */
export function resolveQuota(matchingRows: RoleQuotaRow[]): EffectiveQuota | null {
  if (matchingRows.length === 0) return null;

  let maxServers = 0;
  let allowsAllGames = false;
  const allowedTemplateIds = new Set<string>();
  const matchedRoleLabels: string[] = [];

  for (const row of matchingRows) {
    if (row.max_servers > maxServers) maxServers = row.max_servers;
    matchedRoleLabels.push(row.label);
    for (const templateId of JSON.parse(row.allowed_template_ids) as string[]) {
      if (templateId === ALL_GAMES_SENTINEL) {
        allowsAllGames = true;
      } else {
        allowedTemplateIds.add(templateId);
      }
    }
  }

  return { maxServers, allowsAllGames, allowedTemplateIds, matchedRoleLabels };
}
