import type { RoleQuotaRow } from './db/repositories/roleQuotas.js';

export interface EffectiveQuota {
  maxServers: number;
  allowedTemplateIds: Set<string>;
  matchedRoleLabels: string[];
}

/**
 * Resolves a Discord member's effective quota from the role_quotas rows
 * matching their role memberships. When multiple roles match: the highest
 * max_servers wins (not summed - summing would let a user stack multiple
 * special roles into an unbounded limit) and allowed templates are the
 * union across all matching roles.
 */
export function resolveQuota(matchingRows: RoleQuotaRow[]): EffectiveQuota | null {
  if (matchingRows.length === 0) return null;

  let maxServers = 0;
  const allowedTemplateIds = new Set<string>();
  const matchedRoleLabels: string[] = [];

  for (const row of matchingRows) {
    if (row.max_servers > maxServers) maxServers = row.max_servers;
    matchedRoleLabels.push(row.label);
    for (const templateId of JSON.parse(row.allowed_template_ids) as string[]) {
      allowedTemplateIds.add(templateId);
    }
  }

  return { maxServers, allowedTemplateIds, matchedRoleLabels };
}
