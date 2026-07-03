import { spawn, execFileSync } from 'node:child_process';
import { open } from 'node:fs/promises';
import {
  constants as fsConstants,
  createWriteStream,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import pidusage from 'pidusage';
import type { ConsoleLine, InstanceStatus, InstanceUsageDto } from '@gamedock/shared';
import type { GameTemplate } from '@gamedock/game-templates';
import type { StartCommand } from './variables.js';
import type { EventHub } from './events.js';
import type { Logger } from '../logger.js';
import { badRequest, conflict } from '../errors.js';
import { containsControlChars } from './variables.js';
import { resolveSafePath } from '../utils/safePath.js';

const LOG_BUFFER_LINES = 1000;
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
/** How often the poll loop checks liveness and tails output of every managed process. */
const POLL_INTERVAL_MS = 500;

/**
 * Callbacks the process manager uses to persist state and record events.
 * Async because they write to the database - invoked fire-and-forget from
 * raw child_process event callbacks below, which can't themselves await.
 */
export interface ProcessStatusSink {
  persistStatus(instanceId: string, status: InstanceStatus, pid: number | null): Promise<void>;
  recordEvent(action: string, instanceId: string, detail: string): Promise<void>;
}

interface ManagedProcess {
  instanceId: string;
  instanceName: string;
  /** -1 until the OS confirms a pid for a just-issued spawn. */
  pid: number;
  /** Set when this instance runs as its own dedicated Linux user (see linuxUsers.ts). */
  linuxUsername: string | null;
  status: Extract<InstanceStatus, 'starting' | 'running' | 'stopping'>;
  startedAt: number;
  stopRequested: boolean;
  killTimer: NodeJS.Timeout | null;
  buffer: ConsoleLine[];
  fifoPath: string;
  stdoutRawPath: string;
  stderrRawPath: string;
  stdoutOffset: number;
  stderrOffset: number;
  stdoutRemainder: string;
  stderrRemainder: string;
  logFilePath: string;
  logStream: ReturnType<typeof createWriteStream> | null;
  template: GameTemplate;
  waiters: (() => void)[];
}

export interface StartProcessInput {
  instanceId: string;
  instanceName: string;
  instanceDir: string;
  command: StartCommand;
  template: GameTemplate;
  /** When set, the process runs as this dedicated Linux user via sudo instead of as gamedock. */
  linuxUsername?: string | null;
}

export interface AdoptProcessInput {
  instanceId: string;
  instanceName: string;
  pid: number;
  template: GameTemplate;
  linuxUsername?: string | null;
}

/**
 * Existence of /proc/<pid> works uniformly whether the pid belongs to
 * gamedock itself or a different dedicated per-instance user - unlike
 * process.kill(pid, 0), which fails with EPERM for a different uid even
 * though the process is alive (see docs/SECURITY.md "Process isolation").
 */
function isPidAlive(pid: number): boolean {
  return existsSync(`/proc/${pid}`);
}

/** Scans /proc for a process whose parent is parentPid. Readable across uids without sudo. */
function findChildPid(parentPid: number): number | null {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, 'utf8');
      const match = /^PPid:\s+(\d+)/m.exec(status);
      if (match && Number(match[1]) === parentPid) return Number(entry);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Manages game servers as detached child processes whose stdio is routed
 * through the filesystem (a FIFO for stdin, plain files for stdout/stderr)
 * instead of anonymous pipes. This means a game server keeps running, and
 * GameDock can keep sending console commands and streaming its output, across
 * a restart of the API process itself (self-update, crash, systemd restart) -
 * liveness and output are recovered by polling rather than by holding a
 * ChildProcess handle. Requires the systemd unit to use KillMode=process (see
 * scripts/systemd/gamedock.service) so systemd doesn't kill the detached
 * children when the API process stops.
 */
export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();

  constructor(
    private logDir: string,
    private events: EventHub,
    private sink: ProcessStatusSink,
    private logger: Logger,
  ) {
    const timer = setInterval(() => this.pollTick(), POLL_INTERVAL_MS);
    timer.unref();
  }

  isActive(instanceId: string): boolean {
    return this.processes.has(instanceId);
  }

  statusOf(instanceId: string): InstanceStatus | null {
    return this.processes.get(instanceId)?.status ?? null;
  }

  pidOf(instanceId: string): number | null {
    const pid = this.processes.get(instanceId)?.pid;
    return pid && pid > 0 ? pid : null;
  }

  /** Fire-and-forget a sink call from a sync/event-callback context, logging failures. */
  private runSink(label: string, promise: Promise<void>): void {
    void promise.catch((err) => {
      this.logger.warn({ err: (err as Error).message }, `failed to ${label}`);
    });
  }

  /** Minimal, sanitized environment for game processes (no GameDock secrets). */
  private baseEnv(): Record<string, string> {
    const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];
    const env: Record<string, string> = {};
    for (const key of keep) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    return env;
  }

  private paths(instanceId: string) {
    const dir = join(this.logDir, 'instances', instanceId);
    return {
      dir,
      fifoPath: join(dir, 'stdin.fifo'),
      stdoutRawPath: join(dir, 'stdout.raw'),
      stderrRawPath: join(dir, 'stderr.raw'),
      logFilePath: join(this.logDir, 'instances', `${instanceId}.log`),
    };
  }

  /**
   * Best-effort check that a persisted pid is still the process GameDock
   * started for this instance (guards against pid reuse across a restart).
   *
   * For a dedicated-user (isolated) instance, expectedUid is the strong
   * signal: /proc/<pid>/cwd and /proc/<pid>/exe are NOT readable across
   * uids without sudo (verified live), but /proc/<pid>/status - which
   * includes the owning Uid - is readable by anyone, so this needs no
   * privilege escalation at all.
   *
   * Otherwise (shared gamedock user), cwd is the primary signal - every
   * instance gets its own unique working directory, whereas
   * /proc/<pid>/exe can resolve to a differently-named real binary than
   * the one that was launched (e.g. "python3" -> a version-suffixed
   * interpreter, or "java" via a wrapper), so an exe-name mismatch alone
   * should not disqualify an otherwise-matching process.
   */
  pidMatches(pid: number, executable: string, cwd: string, expectedUid?: number): boolean {
    if (pid <= 0) return false;
    if (expectedUid !== undefined) {
      try {
        const status = readFileSync(`/proc/${pid}/status`, 'utf8');
        const match = /^Uid:\s+(\d+)/m.exec(status);
        return match !== null && Number(match[1]) === expectedUid;
      } catch {
        return false;
      }
    }
    try {
      if (readlinkSync(`/proc/${pid}/cwd`) === cwd) return true;
    } catch {
      // fall through to the executable-name check
    }
    try {
      const exeBase = basename(readlinkSync(`/proc/${pid}/exe`));
      const expectedBase = basename(executable);
      return exeBase === expectedBase || exeBase.startsWith(expectedBase);
    } catch {
      return false;
    }
  }

  start(input: StartProcessInput): void {
    if (this.processes.has(input.instanceId)) {
      throw conflict('Server is already running');
    }

    const cwd = resolveSafePath(input.instanceDir, input.command.workingDir || '.');
    if (!existsSync(cwd)) {
      throw badRequest(
        'Instance working directory does not exist. Install the server files first.',
      );
    }

    const { dir, fifoPath, stdoutRawPath, stderrRawPath, logFilePath } = this.paths(
      input.instanceId,
    );
    mkdirSync(dir, { recursive: true });
    this.rotateLogIfNeeded(logFilePath);

    rmSync(fifoPath, { force: true });
    execFileSync('mkfifo', [fifoPath]);

    // Opening the fifo read-write (not read-only) never blocks waiting for a
    // writer - the standard trick for a self-contained, always-open reader.
    const stdinFd = openSync(fifoPath, 'r+');
    const stdoutFd = openSync(stdoutRawPath, 'w');
    const stderrFd = openSync(stderrRawPath, 'w');
    const linuxUsername = input.linuxUsername ?? null;
    let proc;
    try {
      proc = linuxUsername
        ? spawn(
            'sudo',
            ['-n', '-u', linuxUsername, '--', input.command.executable, ...input.command.args],
            {
              cwd,
              env: { ...this.baseEnv(), ...input.command.env },
              shell: false,
              stdio: [stdinFd, stdoutFd, stderrFd],
              detached: true,
            },
          )
        : spawn(input.command.executable, input.command.args, {
            cwd,
            env: { ...this.baseEnv(), ...input.command.env },
            shell: false,
            stdio: [stdinFd, stdoutFd, stderrFd],
            detached: true,
          });
    } finally {
      closeSync(stdinFd);
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
    proc.unref();

    const managed: ManagedProcess = {
      instanceId: input.instanceId,
      instanceName: input.instanceName,
      // For a sudo-wrapped launch, proc.pid is sudo's own monitor pid, not
      // the game server's (Debian's sudo forks rather than exec-replacing -
      // verified live) - resolved to the real pid in the 'spawn' handler below.
      pid: linuxUsername ? -1 : (proc.pid ?? -1),
      linuxUsername,
      status: 'starting',
      startedAt: Date.now(),
      stopRequested: false,
      killTimer: null,
      buffer: [],
      fifoPath,
      stdoutRawPath,
      stderrRawPath,
      stdoutOffset: 0,
      stderrOffset: 0,
      stdoutRemainder: '',
      stderrRemainder: '',
      logFilePath,
      logStream: createWriteStream(logFilePath, { flags: 'a' }),
      template: input.template,
      waiters: [],
    };
    this.processes.set(input.instanceId, managed);
    this.setStatus(managed, 'starting');

    this.appendSystemLine(
      managed,
      `Starting: ${input.command.executable} ${input.command.args.join(' ')}`,
    );

    proc.on('spawn', () => {
      if (linuxUsername) {
        void this.resolveSudoChildPid(proc.pid!).then((realPid) => {
          if (!this.processes.has(input.instanceId)) return; // already finalized in the meantime
          if (realPid === null) {
            this.appendSystemLine(
              managed,
              'Failed to find the game server process after launching it via sudo',
            );
            this.finalize(managed, 'crashed');
            return;
          }
          managed.pid = realPid;
          this.setStatus(managed, 'running');
          this.runSink(
            'record instance.started event',
            this.sink.recordEvent(
              'instance.started',
              input.instanceId,
              `pid ${realPid} (user ${linuxUsername})`,
            ),
          );
        });
        return;
      }
      managed.pid = proc.pid ?? managed.pid;
      this.setStatus(managed, 'running');
      this.runSink(
        'record instance.started event',
        this.sink.recordEvent(
          'instance.started',
          input.instanceId,
          `pid ${managed.pid > 0 ? managed.pid : 'unknown'}`,
        ),
      );
    });

    proc.on('error', (err) => {
      this.appendSystemLine(managed, `Failed to start process: ${err.message}`);
      this.logger.warn({ instanceId: input.instanceId, err: err.message }, 'process start error');
      this.finalize(managed, 'crashed');
    });
  }

  /**
   * Resolves the real game-server pid after a sudo-wrapped spawn (Debian's
   * sudo forks a monitor rather than exec-replacing itself - verified live).
   * The child typically appears within ~65ms; polls briefly before giving up.
   */
  private resolveSudoChildPid(sudoPid: number, attemptsLeft = 40): Promise<number | null> {
    return new Promise((resolve) => {
      const attempt = (remaining: number) => {
        const childPid = findChildPid(sudoPid);
        if (childPid !== null) {
          resolve(childPid);
        } else if (remaining <= 0) {
          resolve(null);
        } else {
          setTimeout(() => attempt(remaining - 1), 50);
        }
      };
      attempt(attemptsLeft);
    });
  }

  /** Re-registers bookkeeping for a process that was already running before this restart. */
  adopt(input: AdoptProcessInput): void {
    if (this.processes.has(input.instanceId)) return;
    const { dir, fifoPath, stdoutRawPath, stderrRawPath, logFilePath } = this.paths(
      input.instanceId,
    );
    mkdirSync(dir, { recursive: true });
    const stdoutOffset = existsSync(stdoutRawPath) ? statSync(stdoutRawPath).size : 0;
    const stderrOffset = existsSync(stderrRawPath) ? statSync(stderrRawPath).size : 0;

    const managed: ManagedProcess = {
      instanceId: input.instanceId,
      instanceName: input.instanceName,
      pid: input.pid,
      linuxUsername: input.linuxUsername ?? null,
      status: 'running',
      startedAt: Date.now(),
      stopRequested: false,
      killTimer: null,
      buffer: [],
      fifoPath,
      stdoutRawPath,
      stderrRawPath,
      stdoutOffset,
      stderrOffset,
      stdoutRemainder: '',
      stderrRemainder: '',
      logFilePath,
      logStream: createWriteStream(logFilePath, { flags: 'a' }),
      template: input.template,
      waiters: [],
    };
    this.processes.set(input.instanceId, managed);
    this.appendSystemLine(managed, `Reattached to already-running process (pid ${input.pid})`);
    this.events.publish({
      kind: 'instance_status',
      instanceId: input.instanceId,
      status: 'running',
      pid: input.pid,
    });
  }

  private pollTick(): void {
    for (const managed of [...this.processes.values()]) {
      if (managed.pid <= 0) continue;
      if (!isPidAlive(managed.pid)) {
        this.appendSystemLine(managed, 'Process is no longer running');
        this.finalize(managed, managed.stopRequested ? 'stopped' : 'crashed');
        continue;
      }
      this.tailFile(managed, 'stdout');
      this.tailFile(managed, 'stderr');
    }
  }

  private tailFile(managed: ManagedProcess, stream: 'stdout' | 'stderr'): void {
    const path = stream === 'stdout' ? managed.stdoutRawPath : managed.stderrRawPath;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    const offset = stream === 'stdout' ? managed.stdoutOffset : managed.stderrOffset;
    if (size <= offset) return;
    try {
      const fd = openSync(path, 'r');
      try {
        const length = size - offset;
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, offset);
        this.ingest(managed, buffer, stream);
      } finally {
        closeSync(fd);
      }
    } catch {
      return;
    }
    if (stream === 'stdout') managed.stdoutOffset = size;
    else managed.stderrOffset = size;
  }

  private finalize(managed: ManagedProcess, status: 'stopped' | 'crashed'): void {
    if (!this.processes.has(managed.instanceId)) return;
    if (managed.killTimer) clearTimeout(managed.killTimer);
    managed.logStream?.end();
    this.processes.delete(managed.instanceId);
    try {
      rmSync(managed.fifoPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    this.runSink(
      'persist instance status',
      this.sink.persistStatus(managed.instanceId, status, null),
    );
    this.events.publish({
      kind: 'instance_status',
      instanceId: managed.instanceId,
      status,
      pid: null,
    });
    const action = status === 'crashed' ? 'instance.crashed' : 'instance.stopped';
    this.runSink(
      `record ${action} event`,
      this.sink.recordEvent(action, managed.instanceId, 'detected via liveness check'),
    );
    for (const waiter of managed.waiters) waiter();
  }

  private setStatus(managed: ManagedProcess, status: ManagedProcess['status']): void {
    managed.status = status;
    this.runSink(
      'persist instance status',
      this.sink.persistStatus(managed.instanceId, status, managed.pid > 0 ? managed.pid : null),
    );
    this.events.publish({
      kind: 'instance_status',
      instanceId: managed.instanceId,
      status,
      pid: managed.pid > 0 ? managed.pid : null,
    });
  }

  private ingest(managed: ManagedProcess, chunk: Buffer, stream: 'stdout' | 'stderr'): void {
    const text =
      (stream === 'stdout' ? managed.stdoutRemainder : managed.stderrRemainder) +
      chunk.toString('utf8');
    const lines = text.split(/\r?\n/);
    const remainder = lines.pop() ?? '';
    if (stream === 'stdout') managed.stdoutRemainder = remainder;
    else managed.stderrRemainder = remainder;

    for (const line of lines) {
      if (line.length === 0) continue;
      this.appendLine(managed, { ts: Date.now(), stream, line: line.slice(0, 4000) });
    }
  }

  private appendSystemLine(managed: ManagedProcess, line: string): void {
    this.appendLine(managed, { ts: Date.now(), stream: 'system', line });
  }

  private appendLine(managed: ManagedProcess, entry: ConsoleLine): void {
    managed.buffer.push(entry);
    if (managed.buffer.length > LOG_BUFFER_LINES) {
      managed.buffer.splice(0, managed.buffer.length - LOG_BUFFER_LINES);
    }
    managed.logStream?.write(
      `${new Date(entry.ts).toISOString()} [${entry.stream}] ${entry.line}\n`,
    );
    this.events.publishConsole(managed.instanceId, entry);
  }

  private rotateLogIfNeeded(logFilePath: string): void {
    try {
      if (existsSync(logFilePath) && statSync(logFilePath).size > LOG_FILE_MAX_BYTES) {
        renameSync(logFilePath, `${logFilePath}.old`);
      }
    } catch {
      // rotation is best-effort
    }
  }

  recentLines(instanceId: string): ConsoleLine[] {
    return this.processes.get(instanceId)?.buffer.slice() ?? [];
  }

  /** Tail of the persisted log file, for instances that are not running. */
  async recentLinesFromFile(instanceId: string, maxLines = 200): Promise<string[]> {
    const logFilePath = join(this.logDir, 'instances', `${instanceId}.log`);
    if (!existsSync(logFilePath)) return [];
    const size = statSync(logFilePath).size;
    const readBytes = Math.min(size, 128 * 1024);
    const handle = await open(logFilePath, 'r');
    try {
      const buffer = Buffer.alloc(readBytes);
      await handle.read(buffer, 0, readBytes, size - readBytes);
      const lines = buffer.toString('utf8').split('\n').filter(Boolean);
      return lines.slice(-maxLines);
    } finally {
      await handle.close();
    }
  }

  private async writeToFifo(fifoPath: string, text: string): Promise<void> {
    let handle;
    try {
      handle = await open(fifoPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENXIO') {
        throw conflict('Server console is not accepting input');
      }
      throw err;
    }
    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
  }

  async sendCommand(instanceId: string, command: string): Promise<void> {
    const managed = this.processes.get(instanceId);
    if (!managed || managed.status !== 'running') {
      throw conflict('Server is not running');
    }
    if (!managed.template.console.supportsInput) {
      throw badRequest('This game server does not support console input');
    }
    if (containsControlChars(command) || command.includes('\n') || command.includes('\r')) {
      throw badRequest('Command contains illegal characters');
    }
    if (command.length === 0 || command.length > 1000) {
      throw badRequest('Command must be between 1 and 1000 characters');
    }
    await this.writeToFifo(managed.fifoPath, command + '\n');
    this.appendLine(managed, { ts: Date.now(), stream: 'system', line: `> ${command}` });
  }

  /**
   * Signals a managed process. gamedock cannot signal a process owned by a
   * different uid directly (kill(pid, sig) fails with EPERM even though the
   * process is alive - verified live), so a dedicated-user instance routes
   * the signal through sudo -u <that user> instead.
   */
  private async killPid(
    pid: number,
    signal: NodeJS.Signals,
    linuxUsername: string | null,
  ): Promise<void> {
    if (pid <= 0) return;
    if (!linuxUsername) {
      try {
        process.kill(pid, signal);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
      }
      return;
    }
    await new Promise<void>((resolve) => {
      const signalName = signal.replace(/^SIG/, '');
      const child = spawn(
        'sudo',
        ['-n', '-u', linuxUsername, '--', 'kill', '-s', signalName, String(pid)],
        { stdio: 'ignore' },
      );
      child.on('error', (err) => {
        this.logger.warn(
          { pid, linuxUsername, signal, err: err.message },
          'failed to send signal via sudo',
        );
        resolve();
      });
      child.on('close', (code) => {
        if (code !== 0) {
          this.logger.warn({ pid, linuxUsername, signal, code }, 'sudo kill exited non-zero');
        }
        resolve();
      });
    });
  }

  /** Graceful stop: console command or signal first, SIGKILL after timeout. */
  async stop(instanceId: string, options?: { force?: boolean }): Promise<void> {
    const managed = this.processes.get(instanceId);
    if (!managed) {
      throw conflict('Server is not running');
    }
    managed.stopRequested = true;

    if (options?.force) {
      this.appendSystemLine(managed, 'Force killing process (SIGKILL)');
      this.setStatus(managed, 'stopping');
      await this.killPid(managed.pid, 'SIGKILL', managed.linuxUsername);
    } else {
      this.setStatus(managed, 'stopping');
      const stopCfg = managed.template.stop;
      if (stopCfg.method === 'command' && stopCfg.command) {
        this.appendSystemLine(managed, `Sending stop command: ${stopCfg.command}`);
        try {
          await this.writeToFifo(managed.fifoPath, stopCfg.command + '\n');
        } catch (err) {
          this.appendSystemLine(managed, `Failed to send stop command: ${(err as Error).message}`);
        }
      } else {
        const signal = stopCfg.method === 'sigint' ? 'SIGINT' : 'SIGTERM';
        this.appendSystemLine(managed, `Sending ${signal}`);
        await this.killPid(managed.pid, signal, managed.linuxUsername);
      }
      managed.killTimer = setTimeout(() => {
        if (this.processes.has(instanceId)) {
          this.appendSystemLine(managed, 'Grace period expired, sending SIGKILL');
          void this.killPid(managed.pid, 'SIGKILL', managed.linuxUsername);
        }
      }, stopCfg.timeoutSeconds * 1000);
      managed.killTimer.unref();
    }

    await new Promise<void>((resolve) => {
      if (!this.processes.has(instanceId)) return resolve();
      managed.waiters.push(resolve);
    });
  }

  async usage(instanceId: string): Promise<InstanceUsageDto | null> {
    const managed = this.processes.get(instanceId);
    if (!managed || managed.pid <= 0) return null;
    try {
      const stats = await pidusage(managed.pid);
      return {
        cpuPercent: Math.round(stats.cpu * 10) / 10,
        memoryBytes: stats.memory,
        uptimeSeconds: Math.floor((Date.now() - managed.startedAt) / 1000),
      };
    } catch {
      return null;
    }
  }

  runningCount(): number {
    return this.processes.size;
  }
}
