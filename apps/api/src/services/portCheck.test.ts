import { createServer, type Server } from 'node:net';
import { createSocket } from 'node:dgram';
import { describe, expect, it } from 'vitest';
import { findBusyPorts } from './portCheck.js';

function listenTcp(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: '0.0.0.0' }, () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

describe('findBusyPorts', () => {
  it('detects a busy tcp port and reports a free one as free', async () => {
    const { server, port } = await listenTcp();
    try {
      expect(await findBusyPorts([{ port, protocol: 'tcp' }])).toEqual([{ port, protocol: 'tcp' }]);
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(await findBusyPorts([{ port, protocol: 'tcp' }])).toEqual([]);
  });

  it('detects a busy udp port', async () => {
    const socket = createSocket('udp4');
    const port = await new Promise<number>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind({ port: 0, address: '0.0.0.0' }, () =>
        resolve((socket.address() as { port: number }).port),
      );
    });
    try {
      expect(await findBusyPorts([{ port, protocol: 'udp' }])).toEqual([{ port, protocol: 'udp' }]);
      // A 'both' row on the same number is busy because its udp half is taken.
      expect(await findBusyPorts([{ port, protocol: 'both' }])).toEqual([
        { port, protocol: 'both' },
      ]);
    } finally {
      await new Promise((r) => {
        socket.close(() => r(undefined));
      });
    }
  });

  it('checks each port/protocol pair only once', async () => {
    const entries = [
      { port: 15000, protocol: 'udp' as const },
      { port: 15000, protocol: 'udp' as const },
    ];
    const busy = await findBusyPorts(entries);
    expect(busy.length).toBeLessThanOrEqual(1);
  });
});
