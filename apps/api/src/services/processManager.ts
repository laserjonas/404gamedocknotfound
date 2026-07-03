import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
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
  proc: ChildProcess;
  pid: number | null;
  status: Extract<InstanceStatus, 'starting' | 'running' | 'stopping'>;
  startedAt: number;
  stopRequested: boolean;
  killTimer: NodeJS.Timeout | null;
  buffer: ConsoleLine[];
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

/**
 * Manages game servers as supervised child processes. Designed so a
 * systemd-unit-per-instance backend can be swapped in later: the public
 * surface is start/stop/kill/sendCommand/status/usage only.
 */
export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();

  constructor(
    private logDir: string,
    private events: EventHub,
    private sink: ProcessStatusSink,
    private logger: Logger,
  ) {}

  isActive(instanceId: string): boolean {
    return this.processes.has(instanceId);
  }

  statusOf(instanceId: string): InstanceStatus | null {
    return this.processes.get(instanceId)?.status ?? null;
  }

  pidOf(instanceId: string): number | null {
    return this.processes.get(instanceId)?.pid ?? null;
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

    const instanceLogDir = join(this.logDir, 'instances');
    mkdirSync(instanceLogDir, { recursive: true });
    const logFilePath = join(instanceLogDir, `${input.instanceId}.log`);
    this.rotateLogIfNeeded(logFilePath);

    const proc = spawn(input.command.executable, input.command.args, {
      cwd,
      env: { ...this.baseEnv(), ...input.command.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    const managed: ManagedProcess = {
      instanceId: input.instanceId,
      instanceName: input.instanceName,
      proc,
      pid: proc.pid ?? null,
      status: 'starting',
      startedAt: Date.now(),
      stopRequested: false,
      killTimer: null,
      buffer: [],
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
      managed.pid = proc.pid ?? null;
      this.setStatus(managed, 'running');
      this.runSink(
        'record instance.started event',
        this.sink.recordEvent(
          'instance.started',
          input.instanceId,
          `pid ${managed.pid ?? 'unknown'}`,
        ),
      );
    });

    proc.stdout?.on('data', (chunk: Buffer) => this.ingest(managed, chunk, 'stdout'));
    proc.stderr?.on('data', (chunk: Buffer) => this.ingest(managed, chunk, 'stderr'));

    proc.on('error', (err) => {
      this.appendSystemLine(managed, `Failed to start process: ${err.message}`);
      this.logger.warn({ instanceId: input.instanceId, err: err.message }, 'process start error');
      // 'close' may not fire after a spawn error; finalize here if needed.
      if (managed.pid === null) {
        this.finalize(managed, null, 'crashed');
      }
    });

    proc.on('close', (code, signal) => {
      const wasStopRequested = managed.stopRequested;
      const status: InstanceStatus =
        wasStopRequested || (code === 0 && managed.status !== 'starting') ? 'stopped' : 'crashed';
      this.appendSystemLine(
        managed,
        `Process exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`,
      );
      this.finalize(managed, code, status);
    });
  }

  private finalize(
    managed: ManagedProcess,
    exitCode: number | null,
    status: 'stopped' | 'crashed',
  ): void {
    if (!this.processes.has(managed.instanceId)) return;
    if (managed.killTimer) clearTimeout(managed.killTimer);
    managed.logStream?.end();
    this.processes.delete(managed.instanceId);
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
    if (status === 'crashed') {
      this.runSink(
        'record instance.crashed event',
        this.sink.recordEvent(
          'instance.crashed',
          managed.instanceId,
          `exit code ${exitCode ?? 'unknown'}`,
        ),
      );
    } else {
      this.runSink(
        'record instance.stopped event',
        this.sink.recordEvent('instance.stopped', managed.instanceId, `exit code ${exitCode ?? 0}`),
      );
    }
    for (const waiter of managed.waiters) waiter();
  }

  private setStatus(managed: ManagedProcess, status: ManagedProcess['status']): void {
    managed.status = status;
    this.runSink(
      'persist instance status',
      this.sink.persistStatus(managed.instanceId, status, managed.pid),
    );
    this.events.publish({
      kind: 'instance_status',
      instanceId: managed.instanceId,
      status,
      pid: managed.pid,
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

  sendCommand(instanceId: string, command: string): void {
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
    if (!managed.proc.stdin || managed.proc.stdin.destroyed) {
      throw conflict('Server console is not accepting input');
    }
    managed.proc.stdin.write(command + '\n');
    this.appendLine(managed, { ts: Date.now(), stream: 'system', line: `> ${command}` });
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
      managed.proc.kill('SIGKILL');
    } else {
      this.setStatus(managed, 'stopping');
      const stopCfg = managed.template.stop;
      if (stopCfg.method === 'command' && stopCfg.command && managed.proc.stdin?.writable) {
        this.appendSystemLine(managed, `Sending stop command: ${stopCfg.command}`);
        managed.proc.stdin.write(stopCfg.command + '\n');
      } else {
        const signal = stopCfg.method === 'sigint' ? 'SIGINT' : 'SIGTERM';
        this.appendSystemLine(managed, `Sending ${signal}`);
        managed.proc.kill(signal);
      }
      managed.killTimer = setTimeout(() => {
        if (this.processes.has(instanceId)) {
          this.appendSystemLine(managed, 'Grace period expired, sending SIGKILL');
          managed.proc.kill('SIGKILL');
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
    if (!managed || managed.pid === null) return null;
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

  /** Graceful shutdown of all managed processes (used on daemon exit). */
  async shutdownAll(): Promise<void> {
    const ids = [...this.processes.keys()];
    await Promise.allSettled(ids.map((id) => this.stop(id)));
  }
}
