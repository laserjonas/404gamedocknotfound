import { describe, expect, it } from 'vitest';
import { ALL_GAMES_SENTINEL, quotaAllowsTemplate, resolveQuota } from './quota.js';
import type { RoleQuotaRow } from './db/repositories/roleQuotas.js';

function row(overrides: Partial<RoleQuotaRow> = {}): RoleQuotaRow {
  return {
    discord_role_id: '1',
    label: 'Gold',
    max_servers: 3,
    allowed_template_ids: JSON.stringify(['valheim']),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('resolveQuota', () => {
  it('returns null when no roles match', () => {
    expect(resolveQuota([])).toBeNull();
  });

  it('resolves a single matching role directly', () => {
    const quota = resolveQuota([row()]);
    expect(quota?.maxServers).toBe(3);
    expect(quota?.allowedTemplateIds.has('valheim')).toBe(true);
    expect(quota?.matchedRoleLabels).toEqual(['Gold']);
  });

  it('uses the highest max_servers across multiple matching roles, not the sum', () => {
    const quota = resolveQuota([
      row({ discord_role_id: '1', label: 'Bronze', max_servers: 1 }),
      row({ discord_role_id: '2', label: 'Gold', max_servers: 3 }),
    ]);
    expect(quota?.maxServers).toBe(3);
  });

  it('unions allowed templates across all matching roles', () => {
    const quota = resolveQuota([
      row({ discord_role_id: '1', allowed_template_ids: JSON.stringify(['valheim']) }),
      row({
        discord_role_id: '2',
        allowed_template_ids: JSON.stringify(['minecraft-java', 'valheim']),
      }),
    ]);
    expect([...(quota?.allowedTemplateIds ?? [])].sort()).toEqual(['minecraft-java', 'valheim']);
  });

  it('treats the "all games" sentinel as allowing every template', () => {
    const quota = resolveQuota([
      row({ allowed_template_ids: JSON.stringify([ALL_GAMES_SENTINEL]) }),
    ]);
    expect(quota?.allowsAllGames).toBe(true);
    expect(quota && quotaAllowsTemplate(quota, 'anything-not-listed')).toBe(true);
  });

  it('allows all games if any matching role grants it, even alongside a role with a specific list', () => {
    const quota = resolveQuota([
      row({
        discord_role_id: '1',
        label: 'Specific',
        allowed_template_ids: JSON.stringify(['valheim']),
      }),
      row({
        discord_role_id: '2',
        label: 'VIP',
        allowed_template_ids: JSON.stringify([ALL_GAMES_SENTINEL]),
      }),
    ]);
    expect(quota?.allowsAllGames).toBe(true);
    expect(quota && quotaAllowsTemplate(quota, 'rust')).toBe(true);
  });

  it('does not allow arbitrary templates when no role grants "all"', () => {
    const quota = resolveQuota([row({ allowed_template_ids: JSON.stringify(['valheim']) })]);
    expect(quota?.allowsAllGames).toBe(false);
    expect(quota && quotaAllowsTemplate(quota, 'rust')).toBe(false);
  });
});
