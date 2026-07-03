import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { LinuxUserService } from './linuxUsers.js';

const logger = pino({ level: 'silent' });

function service(): LinuxUserService {
  return new LinuxUserService({ enabled: true, appDir: '/opt/gamedock' }, logger);
}

// These all reach root-privileged code (a sudo-invoked script) if not caught
// first, so rejecting them before any shell interpolation happens is the
// load-bearing security property under test here.
const MALFORMED_IDS = [
  '',
  'not-a-uuid',
  '123e4567-e89b-12d3-a456-42661417400', // one hex digit short
  '123E4567-E89B-12D3-A456-426614174000', // uppercase - Node's randomUUID is always lowercase
  '123e4567-e89b-12d3-a456-426614174000; rm -rf /',
  '$(rm -rf /)',
  '`rm -rf /`',
  '../../etc/passwd',
  '123e4567-e89b-12d3-a456-426614174000\nwhoami',
  '123e4567-e89b-12d3-a456-426614174000 && whoami',
];

describe('LinuxUserService instance id validation', () => {
  for (const badId of MALFORMED_IDS) {
    it(`rejects malformed/malicious instance id: ${JSON.stringify(badId)}`, async () => {
      await expect(service().provision(badId)).rejects.toThrow();
      await expect(service().repair(badId)).rejects.toThrow();
      await expect(service().deprovision(badId)).rejects.toThrow();
    });
  }
});
