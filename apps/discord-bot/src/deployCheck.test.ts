import { describe, expect, it } from 'vitest';
import { evaluateDeployCheck, INITIAL_DEPLOY_CHECK_STATE } from './deployCheck.js';

describe('evaluateDeployCheck', () => {
  it('does not restart and keeps no baseline when GameDock has never been self-updated', () => {
    const result = evaluateDeployCheck(INITIAL_DEPLOY_CHECK_STATE, null);
    expect(result.restart).toBe(false);
    expect(result.nextState.baselineCommit).toBeNull();
  });

  it('establishes a baseline on the first successful observation without restarting', () => {
    const result = evaluateDeployCheck(INITIAL_DEPLOY_CHECK_STATE, 'abc123');
    expect(result.restart).toBe(false);
    expect(result.nextState.baselineCommit).toBe('abc123');
  });

  it('does not restart while the observed commit matches the baseline', () => {
    const state = { baselineCommit: 'abc123' };
    const result = evaluateDeployCheck(state, 'abc123');
    expect(result.restart).toBe(false);
    expect(result.nextState).toEqual(state);
  });

  it('signals a restart once the observed commit diverges from the baseline', () => {
    const state = { baselineCommit: 'abc123' };
    const result = evaluateDeployCheck(state, 'def456');
    expect(result.restart).toBe(true);
  });

  it('keeps treating a null observation as inconclusive once a baseline is set', () => {
    const state = { baselineCommit: 'abc123' };
    const result = evaluateDeployCheck(state, null);
    expect(result.restart).toBe(false);
    expect(result.nextState).toEqual(state);
  });
});
