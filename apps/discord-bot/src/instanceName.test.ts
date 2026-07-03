import { describe, expect, it } from 'vitest';
import { deriveInstanceName } from './instanceName.js';

// Mirrors apps/api/src/services/instances.ts's INSTANCE_NAME_RE exactly -
// the two must stay in sync, since a name this helper produces has to pass
// GameDock's own validation on the other end of the API call.
const INSTANCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,63}$/;

describe('deriveInstanceName', () => {
  it('produces a name that satisfies GameDock’s INSTANCE_NAME_RE', () => {
    const name = deriveInstanceName('123456789012345678', 'valheim');
    expect(name).toMatch(INSTANCE_NAME_RE);
    expect(name.length).toBeLessThanOrEqual(64);
  });

  it('sanitizes template ids containing characters outside the allowed set', () => {
    const name = deriveInstanceName('123456789012345678', 'weird/id!<script>');
    expect(name).toMatch(INSTANCE_NAME_RE);
  });

  it('falls back to a safe default when the template id sanitizes to nothing', () => {
    const name = deriveInstanceName('123456789012345678', '!!!');
    expect(name).toMatch(INSTANCE_NAME_RE);
    expect(name).toContain('server');
  });

  it('produces different names on repeated calls (random suffix)', () => {
    const a = deriveInstanceName('123456789012345678', 'valheim');
    const b = deriveInstanceName('123456789012345678', 'valheim');
    expect(a).not.toBe(b);
  });
});
