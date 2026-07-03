import { spawn, execFileSync } from 'node:child_process';
import { open } from 'node:fs/promises';
import {
  constants as fsConstants,
  createWriteStream,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
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
}

export interface AdoptProcessInput {
  instanceId: string;
  instanceName: string;
  pid: number;
  template: GameTemplate;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process. EPERM: it exists but we can't signal it (still alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
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
   * cwd is the primary signal - every instance gets its own unique working
   * directory, whereas /proc/<pid>/exe can resolve to a differently-named
   * real binary than the one that was launched (e.g. "python3" -> a
   * version-suffixed interpreter, or "java" via a wrapper), so an exe-name
   * mismatch alone should not disqualify an otherwise-matching process.
   */
  pidMatches(pid: number, executable: string, cwd: string): boolean {
    if (pid <= 0) return false;
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
    let proc;
    try {
      proc = spawn(input.command.executable, input.command.args, {
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
      pid: proc.pid ?? -1,
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

  private killPid(pid: number, signal: NodeJS.Signals): void {
    if (pid <= 0) return;
    try {
      process.kill(pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
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
      this.killPid(managed.pid, 'SIGKILL');
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
        this.killPid(managed.pid, signal);
      }
      managed.killTimer = setTimeout(() => {
        if (this.processes.has(instanceId)) {
          this.appendSystemLine(managed, 'Grace period expired, sending SIGKILL');
          this.killPid(managed.pid, 'SIGKILL');
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
