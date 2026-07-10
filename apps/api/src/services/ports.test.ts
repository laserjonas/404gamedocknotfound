import { describe, expect, it } from 'vitest';
import {
  claimedPortSet,
  findPortConflicts,
  isPortVariableKey,
  planInstancePorts,
  syncInstancePorts,
} from './ports.js';

describe('planInstancePorts', () => {
  const valheimPorts = [
    { name: 'Game', port: 2456, protocol: 'udp' as const },
    { name: 'Query', port: 2457, protocol: 'udp' as const },
  ];
  const valheimPortVars = [{ key: 'GAME_PORT', default: '2456' }];

  it('leaves everything untouched when no ports are in use', () => {
    const plan = planInstancePorts({
      ports: valheimPorts,
      variables: { GAME_PORT: '2456', SERVER_NAME: 'My Server' },
      portVariables: valheimPortVars,
      usedPorts: new Set(),
    });
    expect(plan.offset).toBe(0);
    expect(plan.ports).toEqual(valheimPorts);
    expect(plan.variables.GAME_PORT).toBe('2456');
  });

  it('shifts the whole set by a common offset past used ports, keeping relations intact', () => {
    // First valheim instance holds 2456+2457; second must land on 2458+2459.
    const plan = planInstancePorts({
      ports: valheimPorts,
      variables: { GAME_PORT: '2456' },
      portVariables: valheimPortVars,
      usedPorts: new Set([2456, 2457]),
    });
    expect(plan.offset).toBe(2);
    expect(plan.ports.map((p) => p.port)).toEqual([2458, 2459]);
    expect(plan.variables.GAME_PORT).toBe('2458');
  });

  it('assigns a second minecraft server the next free port', () => {
    const plan = planInstancePorts({
      ports: [{ name: 'Game', port: 25565, protocol: 'tcp' }],
      variables: { GAME_PORT: '25565', ACCEPT_EULA: 'true' },
      portVariables: [{ key: 'GAME_PORT', default: '25565' }],
      usedPorts: new Set([25565]),
    });
    expect(plan.ports[0].port).toBe(25566);
    expect(plan.variables.GAME_PORT).toBe('25566');
    expect(plan.variables.ACCEPT_EULA).toBe('true');
  });

  it('honors a user-chosen free port without shifting', () => {
    const plan = planInstancePorts({
      ports: valheimPorts,
      variables: { GAME_PORT: '3000' },
      portVariables: valheimPortVars,
      usedPorts: new Set([2456]),
    });
    expect(plan.offset).toBe(0);
    // Game row follows the user's variable; query row keeps its (free) default.
    expect(plan.ports.map((p) => p.port)).toEqual([3000, 2457]);
    expect(plan.variables.GAME_PORT).toBe('3000');
  });

  it('still shifts when a non-variable port row collides despite a custom main port', () => {
    // User moved the game port, but the first instance still holds the query
    // row's default - the whole set shifts together by the common offset.
    const plan = planInstancePorts({
      ports: valheimPorts,
      variables: { GAME_PORT: '3000' },
      portVariables: valheimPortVars,
      usedPorts: new Set([2456, 2457]),
    });
    expect(plan.offset).toBe(1);
    expect(plan.ports.map((p) => p.port)).toEqual([3001, 2458]);
    expect(plan.variables.GAME_PORT).toBe('3001');
  });

  it('moves a user-chosen port that collides with an existing instance', () => {
    const plan = planInstancePorts({
      ports: [{ name: 'Game', port: 25565, protocol: 'tcp' }],
      variables: { GAME_PORT: '26000' },
      portVariables: [{ key: 'GAME_PORT', default: '25565' }],
      usedPorts: new Set([26000]),
    });
    expect(plan.ports[0].port).toBe(26001);
    expect(plan.variables.GAME_PORT).toBe('26001');
  });

  it('does not touch non-port variables or unlinked port rows', () => {
    const plan = planInstancePorts({
      ports: [
        { name: 'Game', port: 8211, protocol: 'udp' },
        { name: 'Query', port: 27015, protocol: 'udp' },
      ],
      variables: { GAME_PORT: '8211', MAX_PLAYERS: '32' },
      portVariables: [{ key: 'GAME_PORT', default: '8211' }],
      usedPorts: new Set([8211]),
    });
    expect(plan.offset).toBe(1);
    expect(plan.ports.map((p) => p.port)).toEqual([8212, 27016]);
    expect(plan.variables.GAME_PORT).toBe('8212');
    expect(plan.variables.MAX_PLAYERS).toBe('32');
  });

  it('throws instead of scanning forever when no free range exists', () => {
    expect(() =>
      planInstancePorts({
        ports: [{ name: 'Game', port: 65535, protocol: 'tcp' }],
        variables: {},
        portVariables: [],
        usedPorts: new Set([65535]),
      }),
    ).toThrow(/free port/);
  });
});

describe('isPortVariableKey', () => {
  it('matches GAME_PORT/QUERY_PORT-style keys and rejects others', () => {
    expect(isPortVariableKey('GAME_PORT')).toBe(true);
    expect(isPortVariableKey('QUERY_PORT')).toBe(true);
    expect(isPortVariableKey('BEACON_PORT')).toBe(true);
    expect(isPortVariableKey('MAX_PLAYERS')).toBe(false);
    expect(isPortVariableKey('SERVER_NAME')).toBe(false);
  });
});

describe('claimedPortSet / findPortConflicts', () => {
  const claims = [
    { port: 25565, instanceId: 'a', instanceName: 'MC One' },
    { port: 25566, instanceId: 'a', instanceName: 'MC One' },
    { port: 2456, instanceId: 'b', instanceName: 'Valheim' },
    { port: 8340, instanceId: null, instanceName: 'the GameDock panel' },
  ];

  it('builds the used set, optionally excluding one instance', () => {
    expect(claimedPortSet(claims)).toEqual(new Set([25565, 25566, 2456, 8340]));
    expect(claimedPortSet(claims, { excludeInstanceId: 'a' })).toEqual(new Set([2456, 8340]));
  });

  it('names the instance holding each conflicting port, once per port', () => {
    const conflicts = findPortConflicts([25565, 25565, 9999, 8340], claims);
    expect(conflicts).toEqual([
      { port: 25565, instanceName: 'MC One' },
      { port: 8340, instanceName: 'the GameDock panel' },
    ]);
  });

  it('ignores the instance being edited itself', () => {
    expect(findPortConflicts([25565], claims, { excludeInstanceId: 'a' })).toEqual([]);
  });
});

describe('syncInstancePorts', () => {
  const currentPorts = [
    { name: 'Game', port: 2456, protocol: 'udp' as const },
    { name: 'Query', port: 2457, protocol: 'udp' as const },
  ];
  const currentVariables = { GAME_PORT: '2456', SERVER_NAME: 'My Server' };

  it('moves the linked port row when a port variable is edited', () => {
    const sync = syncInstancePorts({
      currentPorts,
      currentVariables,
      requestedVariables: { GAME_PORT: '3456', SERVER_NAME: 'My Server' },
      portVariableKeys: ['GAME_PORT'],
    });
    expect(sync.ports.map((p) => p.port)).toEqual([3456, 2457]);
    expect(sync.variables.GAME_PORT).toBe('3456');
    expect(sync.introducedPorts).toEqual([3456]);
  });

  it('moves the row even when the request also sends the stale rows (web UI flow)', () => {
    // The settings page sends variables AND the unchanged ports draft together.
    const sync = syncInstancePorts({
      currentPorts,
      currentVariables,
      requestedPorts: currentPorts,
      requestedVariables: { GAME_PORT: '3456', SERVER_NAME: 'My Server' },
      portVariableKeys: ['GAME_PORT'],
    });
    expect(sync.ports.map((p) => p.port)).toEqual([3456, 2457]);
    expect(sync.variables.GAME_PORT).toBe('3456');
  });

  it('moves the linked variable when a port row is edited', () => {
    const sync = syncInstancePorts({
      currentPorts,
      currentVariables,
      requestedPorts: [
        { name: 'Game', port: 4000, protocol: 'udp' },
        { name: 'Query', port: 2457, protocol: 'udp' },
      ],
      portVariableKeys: ['GAME_PORT'],
    });
    expect(sync.ports.map((p) => p.port)).toEqual([4000, 2457]);
    expect(sync.variables.GAME_PORT).toBe('4000');
    expect(sync.introducedPorts).toEqual([4000]);
  });

  it('lets the variable win when both sides are edited to different values', () => {
    const sync = syncInstancePorts({
      currentPorts,
      currentVariables,
      requestedPorts: [
        { name: 'Game', port: 5000, protocol: 'udp' },
        { name: 'Query', port: 2457, protocol: 'udp' },
      ],
      requestedVariables: { GAME_PORT: '4000', SERVER_NAME: 'My Server' },
      portVariableKeys: ['GAME_PORT'],
    });
    // The variable feeds the game's startup command, so the row follows it.
    expect(sync.ports.map((p) => p.port)).toEqual([4000, 2457]);
    expect(sync.variables.GAME_PORT).toBe('4000');
  });

  it('does not touch unlinked rows or variables', () => {
    const sync = syncInstancePorts({
      currentPorts,
      currentVariables,
      requestedVariables: { GAME_PORT: '3456', SERVER_NAME: 'Renamed' },
      portVariableKeys: ['GAME_PORT'],
    });
    expect(sync.ports[1]).toEqual({ name: 'Query', port: 2457, protocol: 'udp' });
    expect(sync.variables.SERVER_NAME).toBe('Renamed');
  });

  it('reports only newly introduced ports, not ones the instance already held', () => {
    const sync = syncInstancePorts({
      currentPorts,
      currentVariables,
      requestedPorts: [
        { name: 'Game', port: 2456, protocol: 'udp' },
        { name: 'Query', port: 2457, protocol: 'udp' },
        { name: 'Extra', port: 9000, protocol: 'tcp' },
      ],
      portVariableKeys: ['GAME_PORT'],
    });
    expect(sync.introducedPorts).toEqual([9000]);
  });

  it('is a no-op when neither ports nor variables are being edited differently', () => {
    const sync = syncInstancePorts({
      currentPorts,
      currentVariables,
      requestedPorts: currentPorts,
      requestedVariables: currentVariables,
      portVariableKeys: ['GAME_PORT'],
    });
    expect(sync.ports).toEqual(currentPorts);
    expect(sync.variables).toEqual(currentVariables);
    expect(sync.introducedPorts).toEqual([]);
  });
});
