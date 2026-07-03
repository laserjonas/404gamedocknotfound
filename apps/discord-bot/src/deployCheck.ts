/**
 * Detects when GameDock (and therefore this bot's own code, since both are
 * built and deployed atomically by the same install/self-update rsync) has
 * been redeployed to a new commit while this process was already running,
 * so it can exit and let its own systemd unit's Restart=always bring it
 * back up on the new build - self-update only restarts the main API
 * process, it has no way to know a separate systemd unit exists.
 */
export interface DeployCheckState {
  /** The commit this process first observed GameDock running - null until
   * a health check succeeds at least once. */
  baselineCommit: string | null;
}

export const INITIAL_DEPLOY_CHECK_STATE: DeployCheckState = { baselineCommit: null };

export interface DeployCheckResult {
  restart: boolean;
  nextState: DeployCheckState;
}

/**
 * observedCommit is whatever GameDock's /api/system/health currently
 * reports (null if self-update has never been used on that install - in
 * that case there's nothing to compare against, so this never fires).
 */
export function evaluateDeployCheck(
  state: DeployCheckState,
  observedCommit: string | null,
): DeployCheckResult {
  if (observedCommit === null) {
    return { restart: false, nextState: state };
  }
  if (state.baselineCommit === null) {
    // First successful observation - establish the baseline, don't restart on it.
    return { restart: false, nextState: { baselineCommit: observedCommit } };
  }
  if (observedCommit !== state.baselineCommit) {
    return { restart: true, nextState: state };
  }
  return { restart: false, nextState: state };
}
