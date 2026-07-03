import { describe, expect, it } from 'vitest';
import { isPortVariableKey, planInstancePorts } from './ports.js';

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
