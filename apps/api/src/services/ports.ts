import type { PortProtocol } from '@gamedock/shared';

/**
 * Collision-free port assignment for instances.
 *
 * Templates ship fixed default ports (Minecraft 25565, Valheim 2456/2457,
 * ...), so creating a second instance of the same game used to produce two
 * servers fighting over the same port. When the caller doesn't pin ports
 * explicitly, the whole default port set is shifted by one common offset to
 * the first slot where every port is unused. A single shared offset (rather
 * than per-port searches) preserves intra-template relationships that games
 * rely on, like Valheim's query port always being game port + 1.
 *
 * Port-carrying template variables (GAME_PORT, QUERY_PORT, ...) are what
 * actually feed the game's startup command, so any such variable whose
 * value matches a shifted port is moved along with it - otherwise only the
 * metadata would change while the game still binds its old default.
 *
 * The "used" set is derived from every instance's port rows AND its
 * port-variable values (see InstanceRepository.listAllPortClaims), so even
 * historically drifted instances - where a variable was edited without its
 * port row following - can't have their real port handed to a new instance.
 */

export interface PortPlanEntry {
  name: string;
  port: number;
  protocol: PortProtocol;
}

export interface PortVariableInfo {
  key: string;
  /** The variable's template default, used to link it to a port entry. */
  default: string;
}

/** One port number some instance (or the panel itself) already lays claim to. */
export interface PortClaim {
  port: number;
  /** null for claims that don't belong to an instance (e.g. the panel's own port). */
  instanceId: string | null;
  instanceName: string;
}

export interface PortPlanInput {
  /** Desired port rows - template defaults, or the source's rows when cloning. */
  ports: PortPlanEntry[];
  /** Fully resolved variable values for the new instance. */
  variables: Record<string, string>;
  /** Template variables that carry a port number (key contains "PORT"). */
  portVariables: PortVariableInfo[];
  /** Port numbers already claimed by existing instances. */
  usedPorts: ReadonlySet<number>;
}

export interface PortPlan {
  ports: PortPlanEntry[];
  variables: Record<string, string>;
  /** Offset applied to every port; 0 means nothing needed to move. */
  offset: number;
}

const MAX_PORT = 65535;

export function isPortVariableKey(key: string): boolean {
  return key.toUpperCase().includes('PORT');
}

/** Parses a port-variable value; null when it isn't a valid port number. */
export function parsePortValue(value: string | undefined): number | null {
  const port = Number.parseInt(value ?? '', 10);
  return Number.isInteger(port) && port >= 1 && port <= MAX_PORT ? port : null;
}

/** The set of claimed port numbers, for feeding planInstancePorts(). */
export function claimedPortSet(
  claims: PortClaim[],
  options: { excludeInstanceId?: string } = {},
): Set<number> {
  const set = new Set<number>();
  for (const claim of claims) {
    if (options.excludeInstanceId && claim.instanceId === options.excludeInstanceId) continue;
    set.add(claim.port);
  }
  return set;
}

/**
 * Which of `candidatePorts` are already claimed, and by whom. Each conflicting
 * port is reported once, against the first claim holding it.
 */
export function findPortConflicts(
  candidatePorts: Iterable<number>,
  claims: PortClaim[],
  options: { excludeInstanceId?: string } = {},
): { port: number; instanceName: string }[] {
  const byPort = new Map<number, PortClaim>();
  for (const claim of claims) {
    if (options.excludeInstanceId && claim.instanceId === options.excludeInstanceId) continue;
    if (!byPort.has(claim.port)) byPort.set(claim.port, claim);
  }
  const conflicts: { port: number; instanceName: string }[] = [];
  const seen = new Set<number>();
  for (const port of candidatePorts) {
    if (seen.has(port)) continue;
    seen.add(port);
    const claim = byPort.get(port);
    if (claim) conflicts.push({ port, instanceName: claim.instanceName });
  }
  return conflicts;
}

/**
 * Plans the port rows and port variables for a new instance so that no port
 * collides with an existing instance. Ports the user redirected via a port
 * variable (e.g. GAME_PORT=25999) are honored as the starting point; the
 * common offset only kicks in when the requested set overlaps ports in use.
 */
export function planInstancePorts(input: PortPlanInput): PortPlan {
  const { variables, portVariables, usedPorts } = input;

  // Apply user variable overrides to the port rows first: a port variable
  // whose template default matches a row links to that row, and a changed
  // value moves the row with it (keeps metadata truthful for custom ports).
  const ports = input.ports.map((entry) => {
    for (const pv of portVariables) {
      const defaultPort = parsePortValue(pv.default);
      const value = parsePortValue(variables[pv.key]);
      if (
        defaultPort !== null &&
        value !== null &&
        defaultPort === entry.port &&
        value !== entry.port
      ) {
        return { ...entry, port: value };
      }
    }
    return entry;
  });

  let offset = 0;
  if (ports.length > 0) {
    // The search only moves upward from the requested ports, so once the
    // highest one would pass 65535 no free slot exists in that direction.
    const highestPort = Math.max(...ports.map((entry) => entry.port));
    while (ports.some((entry) => usedPorts.has(entry.port + offset))) {
      offset += 1;
      if (highestPort + offset > MAX_PORT) {
        throw new Error(
          'Could not find a free port range for this instance - too many ports in use',
        );
      }
    }
  }

  if (offset === 0) {
    return { ports, variables, offset };
  }

  const preOffsetPorts = new Set(ports.map((entry) => entry.port));
  const shiftedVariables = { ...variables };
  for (const pv of portVariables) {
    const value = parsePortValue(shiftedVariables[pv.key]);
    if (value !== null && preOffsetPorts.has(value)) {
      shiftedVariables[pv.key] = String(value + offset);
    }
  }

  return {
    ports: ports.map((entry) => ({ ...entry, port: entry.port + offset })),
    variables: shiftedVariables,
    offset,
  };
}

export interface PortSyncInput {
  /** The instance's stored port rows before this update. */
  currentPorts: PortPlanEntry[];
  /** The instance's stored variable values before this update. */
  currentVariables: Record<string, string>;
  /** New port rows from the request; undefined when the request doesn't edit ports. */
  requestedPorts?: PortPlanEntry[];
  /** Fully resolved new variable values; undefined when the request doesn't edit variables. */
  requestedVariables?: Record<string, string>;
  /** Template variable keys that carry a port number. */
  portVariableKeys: string[];
}

export interface PortSyncResult {
  ports: PortPlanEntry[];
  variables: Record<string, string>;
  /** Ports this update newly introduces - the ones to check against other instances. */
  introducedPorts: number[];
}

/**
 * Keeps an instance's port rows and port variables in lockstep when either
 * side is edited. Before this existed, changing GAME_PORT in the settings
 * left the port row stale (and vice versa), so the allocator's view of used
 * ports drifted from what games actually bind - the root cause of new
 * instances being handed a port that was silently in use.
 *
 * Rules, applied to the requested rows (matched to their pre-edit selves by
 * name; renamed rows count as new):
 *  1. A row whose port was edited drags every port variable that pointed at
 *     its old port along - unless that variable was explicitly changed in
 *     the same request.
 *  2. An explicitly changed port variable drags every row that sat on its
 *     old value along, overriding a contradictory row edit in the same
 *     request: the variable is what actually feeds the game, so the row
 *     must follow it, not the other way around.
 */
export function syncInstancePorts(input: PortSyncInput): PortSyncResult {
  const { currentPorts, currentVariables } = input;
  const variables = { ...(input.requestedVariables ?? currentVariables) };

  // Pair requested rows with their stored predecessors by name.
  const unmatched = [...currentPorts];
  const rows = (input.requestedPorts ?? currentPorts).map((entry) => {
    const i = unmatched.findIndex((c) => c.name === entry.name);
    const oldPort = i === -1 ? null : unmatched.splice(i, 1)[0]!.port;
    return { entry: { ...entry }, oldPort };
  });

  const changedVariableKeys = input.portVariableKeys.filter((key) => {
    if (input.requestedVariables === undefined) return false;
    const newValue = parsePortValue(input.requestedVariables[key]);
    return newValue !== null && newValue !== parsePortValue(currentVariables[key]);
  });

  // Rule 1: row edit -> linked variables follow.
  for (const row of rows) {
    if (row.oldPort === null || row.oldPort === row.entry.port) continue;
    for (const key of input.portVariableKeys) {
      if (changedVariableKeys.includes(key)) continue;
      if (parsePortValue(currentVariables[key]) === row.oldPort) {
        variables[key] = String(row.entry.port);
      }
    }
  }

  // Rule 2: variable edit -> linked rows follow (variable wins on conflict).
  for (const key of changedVariableKeys) {
    const oldValue = parsePortValue(currentVariables[key]);
    const newValue = parsePortValue(variables[key])!;
    for (const row of rows) {
      if ((row.oldPort ?? row.entry.port) === oldValue) {
        row.entry.port = newValue;
      }
    }
  }

  // Only newly introduced ports need cross-instance conflict checks: ports the
  // instance already held must not block unrelated settings saves, even if
  // they conflict due to pre-existing (pre-fix) drift.
  const before = new Set<number>(currentPorts.map((p) => p.port));
  for (const key of input.portVariableKeys) {
    const value = parsePortValue(currentVariables[key]);
    if (value !== null) before.add(value);
  }
  const introduced = new Set<number>();
  for (const row of rows) {
    if (!before.has(row.entry.port)) introduced.add(row.entry.port);
  }
  for (const key of input.portVariableKeys) {
    const value = parsePortValue(variables[key]);
    if (value !== null && !before.has(value)) introduced.add(value);
  }

  return {
    ports: rows.map((row) => row.entry),
    variables,
    introducedPorts: [...introduced],
  };
}
