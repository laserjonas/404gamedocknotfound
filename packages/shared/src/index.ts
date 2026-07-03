/**
 * Shared types between the GameDock API and the web frontend.
 * These are plain DTO shapes as returned by the REST API.
 */

// ---------------------------------------------------------------------------
// Users & auth
// ---------------------------------------------------------------------------

export type Role = 'admin' | 'operator' | 'viewer';

export const ROLE_LEVELS: Record<Role, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

export interface UserDto {
  id: string;
  username: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  disabled: boolean;
  totpEnabled: boolean;
  /** Unused 2FA recovery codes remaining. 0 if TOTP is off or none were ever generated. */
  totpRecoveryCodesRemaining: number;
}

export interface MeResponse {
  user: UserDto;
  csrfToken: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

/** Login completes in one step, or two if the account has 2FA enabled. */
export type LoginResponseDto =
  | { status: 'ok'; user: UserDto; csrfToken: string }
  | { status: 'totp_required'; challengeToken: string };

export interface TotpSetupResponseDto {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
}

// ---------------------------------------------------------------------------
// Passkeys (WebAuthn/FIDO2)
// ---------------------------------------------------------------------------

/** A completed login - the terminal shape for password(+TOTP) and passkey login alike. */
export interface AuthSuccessDto {
  user: UserDto;
  csrfToken: string;
}

export interface PasskeyDto {
  id: string;
  nickname: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: 'singleDevice' | 'multiDevice';
}

/**
 * These four are pass-through WebAuthn JSON blobs (from @simplewebauthn/server
 * on the API side, consumed by @simplewebauthn/browser on the web side).
 * Deliberately untyped here rather than importing either package's types:
 * this shared package is consumed by both apps/api and apps/web, which each
 * depend on a *different* one of the two (server vs. browser) - importing
 * either one's types here would make the other app's typecheck need a
 * package it doesn't otherwise depend on. Each side casts to its own
 * concrete library type at the point it hands off to/from the real
 * WebAuthn calls.
 */
export type PasskeyRegistrationOptionsDto = Record<string, unknown>;

export interface FinishPasskeyRegistrationRequest {
  nickname: string;
  response: Record<string, unknown>;
}

export type PasskeyAuthenticationOptionsDto = Record<string, unknown>;

export interface CompletePasskeyLoginRequest {
  response: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Game templates
// ---------------------------------------------------------------------------

export type InstallMethod = 'steamcmd' | 'url' | 'manual';
export type PortProtocol = 'tcp' | 'udp' | 'both';
export type StopMethod = 'command' | 'sigint' | 'sigterm';

export interface TemplatePortDto {
  name: string;
  port: number;
  protocol: PortProtocol;
}

export interface TemplateVariableDto {
  key: string;
  label: string;
  description?: string;
  default: string;
  required: boolean;
  secret?: boolean;
  pattern?: string;
}

export interface TemplateConfigFileDto {
  path: string;
  description: string;
  /** Path may not exist until the server ran at least once. */
  createdByServer?: boolean;
}

export interface GameTemplateDto {
  id: string;
  name: string;
  description: string;
  installMethod: InstallMethod;
  steam?: {
    appId: number;
    anonymous: boolean;
    /** Extra args appended to app_update, e.g. beta branches. */
    extraArgs?: string[];
  };
  urlInstall?: {
    /** May contain {{VAR}} placeholders resolved from instance variables. Absent when "resolver" is set. */
    url?: string;
    /** none = keep file as-is, zip/tar = extract into instance dir. */
    archive: 'none' | 'zip' | 'tar';
    /** Target filename when archive is "none". */
    targetFile?: string;
    /** When set, the download URL is resolved dynamically from this variable's value. */
    resolver?: 'mojang-version-manifest';
    versionVariable?: string;
  };
  os: ('linux' | 'windows')[];
  ports: TemplatePortDto[];
  start: {
    executable: string;
    args: string[];
    workingDir: string;
  };
  env: Record<string, string>;
  stop: {
    method: StopMethod;
    /** Console command used when method = "command". */
    command?: string;
    timeoutSeconds: number;
  };
  console: {
    supportsInput: boolean;
  };
  configFiles: TemplateConfigFileDto[];
  variables: TemplateVariableDto[];
  notes?: string;
}

// ---------------------------------------------------------------------------
// Server instances
// ---------------------------------------------------------------------------

export type InstanceStatus =
  'not_installed' | 'installing' | 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

export interface InstancePortDto {
  id: string;
  name: string;
  port: number;
  protocol: PortProtocol;
}

export interface InstanceDto {
  id: string;
  name: string;
  templateId: string;
  templateName: string;
  status: InstanceStatus;
  installed: boolean;
  autoStart: boolean;
  createdAt: string;
  updatedAt: string;
  /** Startup overrides; null means "use template default". */
  startExecutable: string | null;
  startArgs: string[] | null;
  ports: InstancePortDto[];
  envVars: Record<string, string>;
  variables: Record<string, string>;
  pid: number | null;
  /** Resource usage; only present while running and when measurable. */
  usage?: InstanceUsageDto | null;
  /** Automatically restart the server a few times if it crashes unexpectedly. */
  crashRestart: boolean;
  /** Automatic backup schedule; null means disabled. */
  backupIntervalHours: number | null;
  /** Keep only the last N automatic/manual backups; null means keep all. */
  backupRetentionCount: number | null;
}

export interface InstanceUsageDto {
  cpuPercent: number;
  memoryBytes: number;
  uptimeSeconds: number;
}

export interface CreateInstanceRequest {
  name: string;
  templateId: string;
  variables?: Record<string, string>;
  ports?: { name: string; port: number; protocol: PortProtocol }[];
}

export interface CloneInstanceRequest {
  name: string;
}

export interface UpdateInstanceRequest {
  name?: string;
  autoStart?: boolean;
  startExecutable?: string | null;
  startArgs?: string[] | null;
  envVars?: Record<string, string>;
  variables?: Record<string, string>;
  ports?: { name: string; port: number; protocol: PortProtocol }[];
  crashRestart?: boolean;
  backupIntervalHours?: number | null;
  backupRetentionCount?: number | null;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type JobType =
  'install' | 'update' | 'backup' | 'restore' | 'delete_instance' | 'system_update';

export interface JobDto {
  id: string;
  type: JobType;
  status: JobStatus;
  instanceId: string | null;
  instanceName: string | null;
  progress: number | null;
  message: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdBy: string | null;
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export interface BackupDto {
  id: string;
  instanceId: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  note: string | null;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface FileEntryDto {
  name: string;
  path: string;
  type: 'file' | 'directory';
  sizeBytes: number;
  modifiedAt: string;
}

export interface FileContentDto {
  path: string;
  content: string;
  sizeBytes: number;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export interface SystemStatsDto {
  cpu: {
    usagePercent: number;
    cores: number;
    model: string;
    loadAverage: number[];
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
  };
  disk: {
    mount: string;
    totalBytes: number;
    usedBytes: number;
  }[];
  network: {
    iface: string;
    rxBytesPerSec: number;
    txBytesPerSec: number;
  }[];
  uptimeSeconds: number;
  runningInstances: number;
  totalInstances: number;
}

export interface HealthDto {
  status: 'ok';
  uptime: number;
  version: string;
}

export interface UpdateStatusDto {
  configured: boolean;
  repoUrl: string;
  branch: string;
  currentCommit: string | null;
  currentCommitAt: string | null;
  remoteCommit: string | null;
  updateAvailable: boolean;
}

export interface DependencyStatusDto {
  name: string;
  found: boolean;
  path: string | null;
  version: string | null;
  required: boolean;
  hint: string;
}

// ---------------------------------------------------------------------------
// Application logs
// ---------------------------------------------------------------------------

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export interface LogEntryDto {
  time: number;
  level: LogLevel;
  /** Subsystem that produced this line, e.g. "instances", "jobs", "http". Null for uncategorized root logs. */
  component: string | null;
  msg: string;
  /** Extra structured fields attached to the log call (instanceId, err, etc.). */
  extra?: Record<string, unknown>;
}

export interface LogsResponseDto {
  level: LogLevel;
  entries: LogEntryDto[];
}

// ---------------------------------------------------------------------------
// Audit log / events
// ---------------------------------------------------------------------------

export interface AuditLogDto {
  id: string;
  userId: string | null;
  username: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: string | null;
  createdAt: string;
}

/** One previously-sent console command, most recent first - backs the console's recall history. */
export interface CommandHistoryEntryDto {
  command: string;
  sentAt: string;
}

/** Server-sent event payloads on /api/events/stream */
export type GameDockEvent =
  | { kind: 'instance_status'; instanceId: string; status: InstanceStatus; pid: number | null }
  | { kind: 'job_update'; job: JobDto }
  | { kind: 'audit'; entry: AuditLogDto };

export interface ConsoleLine {
  ts: number;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
}

// ---------------------------------------------------------------------------
// Generic API envelope
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  error: string;
  message: string;
  statusCode: number;
}
