import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { SelfUpdateService } = await import('./selfUpdate.js');

/** Fakes a spawned child process that writes `stdout` then exits with `code`. */
function fakeChild(stdout: string, code = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', code, null);
  });
  return child;
}

afterEach(() => {
  spawnMock.mockReset();
});

describe('SelfUpdateService.checkForUpdate', () => {
  it('reports not configured without touching git when repoUrl is empty', async () => {
    const service = new SelfUpdateService({
      repoUrl: '',
      branch: 'main',
      appDir: '/opt/gamedock',
      stateFilePath: '/does/not/exist.json',
      stagingDir: '/does/not/exist-staging',
    });
    const status = await service.checkForUpdate();
    expect(status.configured).toBe(false);
    expect(status.updateAvailable).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports an available update when the remote commit differs from state', async () => {
    spawnMock.mockImplementation(() => fakeChild('abc123\trefs/heads/main\n'));
    const service = new SelfUpdateService({
      repoUrl: 'https://github.com/example/repo.git',
      branch: 'main',
      appDir: '/opt/gamedock',
      stateFilePath: '/does/not/exist.json',
      stagingDir: '/does/not/exist-staging',
    });
    const status = await service.checkForUpdate();
    expect(status.configured).toBe(true);
    expect(status.remoteCommit).toBe('abc123');
    expect(status.currentCommit).toBeNull();
    expect(status.updateAvailable).toBe(true);
  });

  it('throws a clear error when the branch does not exist on the remote', async () => {
    spawnMock.mockImplementation(() => fakeChild(''));
    const service = new SelfUpdateService({
      repoUrl: 'https://github.com/example/repo.git',
      branch: 'nope',
      appDir: '/opt/gamedock',
      stateFilePath: '/does/not/exist.json',
      stagingDir: '/does/not/exist-staging',
    });
    await expect(service.checkForUpdate()).rejects.toThrow(/not found/);
  });

  it('surfaces git failures with a descriptive message', async () => {
    spawnMock.mockImplementation(() => fakeChild('fatal: could not read Username', 128));
    const service = new SelfUpdateService({
      repoUrl: 'https://github.com/example/repo.git',
      branch: 'main',
      appDir: '/opt/gamedock',
      stateFilePath: '/does/not/exist.json',
      stagingDir: '/does/not/exist-staging',
    });
    await expect(service.checkForUpdate()).rejects.toThrow(/Failed to check for updates/);
  });
});
