import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import type { PortProtocol } from '@gamedock/shared';

/**
 * Host-level port availability probe, run right before a server starts.
 *
 * The port allocator prevents two GameDock instances from *claiming* the same
 * port, but nothing stops another process on the host (or a game whose config
 * drifted from its metadata) from already sitting on it - which used to
 * surface as a cryptic in-game bind error deep in the console. Probing with a
 * short-lived bind turns that into an immediate, named error.
 *
 * Only EADDRINUSE counts as busy: privileged-port EACCES or other probe
 * failures must never block a start over a probe malfunction.
 */

export interface PortCheckEntry {
  port: number;
  protocol: PortProtocol;
}

function tcpPortBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRINUSE');
    });
    server.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      server.close(() => resolve(false));
    });
  });
}

function udpPortBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    socket.once('error', (err: NodeJS.ErrnoException) => {
      socket.close();
      resolve(err.code === 'EADDRINUSE');
    });
    socket.bind({ port, address: '0.0.0.0' }, () => {
      socket.close(() => resolve(false));
    });
  });
}

/** Returns the subset of `entries` whose port is already bound on the host. */
export async function findBusyPorts(entries: PortCheckEntry[]): Promise<PortCheckEntry[]> {
  const seen = new Set<string>();
  const busy: PortCheckEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.port}/${entry.protocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const checkTcp = entry.protocol === 'tcp' || entry.protocol === 'both';
    const checkUdp = entry.protocol === 'udp' || entry.protocol === 'both';
    if (
      (checkTcp && (await tcpPortBusy(entry.port))) ||
      (checkUdp && (await udpPortBusy(entry.port)))
    ) {
      busy.push(entry);
    }
  }
  return busy;
}
