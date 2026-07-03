import type { PortProtocol } from '@gamedock/shared';

/**
 * Collision-free port assignment for new instances.
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
/** Way beyond any realistic instance count; bail out instead of scanning forever. */
const MAX_OFFSET = 10000;

export function isPortVariableKey(key: string): boolean {
  return key.toUpperCase().includes('PORT');
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
      const defaultPort = Number.parseInt(pv.default, 10);
      const value = Number.parseInt(variables[pv.key] ?? '', 10);
      if (
        Number.isInteger(defaultPort) &&
        Number.isInteger(value) &&
        defaultPort === entry.port &&
        value !== entry.port
      ) {
        return { ...entry, port: value };
      }
    }
    return entry;
  });

  let offset = 0;
  while (
    ports.some((entry) => usedPorts.has(entry.port + offset) || entry.port + offset > MAX_PORT)
  ) {
    offset += 1;
    if (offset > MAX_OFFSET) {
      throw new Error('Could not find a free port range for this instance - too many ports in use');
    }
  }

  if (offset === 0) {
    return { ports, variables, offset };
  }

  const preOffsetPorts = new Set(ports.map((entry) => entry.port));
  const shiftedVariables = { ...variables };
  for (const pv of portVariables) {
    const value = Number.parseInt(shiftedVariables[pv.key] ?? '', 10);
    if (Number.isInteger(value) && preOffsetPorts.has(value)) {
      shiftedVariables[pv.key] = String(value + offset);
    }
  }

  return {
    ports: ports.map((entry) => ({ ...entry, port: entry.port + offset })),
    variables: shiftedVariables,
    offset,
  };
}
