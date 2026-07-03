import { describe, expect, it } from 'vitest';
import { resolveQuota } from './quota.js';
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
});
