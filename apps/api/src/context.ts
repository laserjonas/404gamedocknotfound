import { join } from 'node:path';
import type { AppConfig } from './config.js';
import type { Logger, LoggerRegistry, LogRingBuffer } from './logger.js';
import { createDatabase, type DatabaseClient } from './db/database.js';
import { runMigrations } from './db/migrations.js';
import { UserRepository } from './db/repositories/users.js';
import { SessionRepository } from './db/repositories/sessions.js';
import { InstanceRepository } from './db/repositories/instances.js';
import { JobRepository } from './db/repositories/jobs.js';
import { BackupRepository } from './db/repositories/backups.js';
import { AuditRepository } from './db/repositories/audit.js';
import { SettingsRepository } from './db/repositories/settings.js';
import { WebauthnCredentialRepository } from './db/repositories/webauthnCredentials.js';
import { AuthService } from './auth/service.js';
import { TemplateService } from './services/templates.js';
import { EventHub } from './services/events.js';
import { ProcessManager } from './services/processManager.js';
import { JobService } from './services/jobs.js';
import { BackupService } from './services/backups.js';
import { FileService } from './services/files.js';
import { InstanceService } from './services/instances.js';
import { LinuxUserService } from './services/linuxUsers.js';
import { SystemStatsService } from './services/systemStats.js';
import { CrashRestartTracker } from './services/crashRestart.js';
import { SelfUpdateService } from './services/selfUpdate.js';
import { LogService } from './services/logs.js';
import { toAuditDto } from './db/repositories/audit.js';

const CRASH_RESTART_LIMITS = { maxRestarts: 4, windowMs: 5 * 60 * 1000 };
const CRASH_RESTART_DELAY_MS = 5000;
const BACKUP_SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;
const AUDIT_RETENTION_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface AppContext {
  config: AppConfig;
  logger: Logger;
  db: DatabaseClient;
  repos: {
    users: UserRepository;
    sessions: SessionRepository;
    instances: InstanceRepository;
    jobs: JobRepository;
    backups: BackupRepository;
    audit: AuditRepository;
    settings: SettingsRepository;
    webauthnCredentials: WebauthnCredentialRepository;
  };
  auth: AuthService;
  templates: TemplateService;
  events: EventHub;
  processes: ProcessManager;
  jobs: JobService;
  backups: BackupService;
  files: FileService;
  instances: InstanceService;
  linuxUsers: LinuxUserService;
  systemStats: SystemStatsService;
  selfUpdate: SelfUpdateService;
  logs: LogService;
  /** Creates a tagged child logger and registers it so runtime level changes reach it too. */
  componentLogger(name: string): Logger;
  audit(entry: {
    userId?: string | null;
    username?: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    detail?: string;
  }): Promise<void>;
  shutdown(): Promise<void>;
}

export async function createContext(
  config: AppConfig,
  logger: Logger,
  logRegistry: LoggerRegistry,
  logBuffer: LogRingBuffer,
): Promise<AppContext> {
  const db = createDatabase(config.databaseUrl, config.dataDir);
  await runMigrations(db, logger);

  const repos = {
    users: new UserRepository(db),
    sessions: new SessionRepository(db),
    instances: new InstanceRepository(db),
    jobs: new JobRepository(db),
    backups: new BackupRepository(db),
    audit: new AuditRepository(db),
    settings: new SettingsRepository(db),
    webauthnCredentials: new WebauthnCredentialRepository(db),
  };

  const events = new EventHub();

  const audit: AppContext['audit'] = async (entry) => {
    const row = await repos.audit.add(entry);
    events.publish({ kind: 'audit', entry: toAuditDto(row) });
  };

  // Apply a previously-saved log level before creating component child
  // loggers, so they all start at the right verbosity (pino children
  // snapshot the parent's level once at creation, see logger.ts).
  const logs = new LogService(logBuffer, logRegistry, repos.settings);
  await logs.restoreLevel();
  const componentLogger: AppContext['componentLogger'] = (name) =>
    logRegistry.register(logger.child({ component: name }));

  const auth = new AuthService(repos.users, repos.sessions, repos.webauthnCredentials, {
    rpId: config.rpId,
    origin: config.publicOrigin,
  });
  const templates = new TemplateService(db, config.dataDir, componentLogger('templates'));
  await templates.reload();

  const processes = new ProcessManager(
    config.logDir,
    events,
    {
      persistStatus: async (instanceId, status, pid) => {
        // The instance row may already be gone when deletion races a stop.
        if (await repos.instances.findById(instanceId)) {
          await repos.instances.update(instanceId, { status, lastPid: pid });
        }
      },
      recordEvent: async (action, instanceId, detail) => {
        const row = await repos.instances.findById(instanceId);
        await audit({
          action,
          targetType: 'instance',
          targetId: instanceId,
          detail: `${row?.name ?? instanceId}: ${detail}`,
        });
      },
    },
    componentLogger('process-manager'),
  );

  const jobService = new JobService(repos.jobs, repos.instances, events, componentLogger('jobs'));
  const backups = new BackupService(config.backupDir, repos.backups);
  const files = new FileService(config.maxUploadBytes);
  const linuxUsers = new LinuxUserService(
    { enabled: config.instanceUserIsolation, appDir: config.appDir },
    componentLogger('linux-users'),
  );
  const instances = new InstanceService(
    repos.instances,
    repos.backups,
    templates,
    jobService,
    processes,
    backups,
    linuxUsers,
    config,
    componentLogger('instances'),
  );
  const systemStats = new SystemStatsService();
  const selfUpdate = new SelfUpdateService({
    repoUrl: config.updateRepoUrl,
    branch: config.updateBranch,
    appDir: config.appDir,
    stateFilePath: join(config.dataDir, 'update-state.json'),
    stagingDir: join(config.dataDir, 'update-staging'),
  });

  // Periodic session cleanup.
  const sessionCleanup = setInterval(
    () => {
      void auth
        .cleanupExpired()
        .catch((err) => logger.warn({ err: (err as Error).message }, 'session cleanup failed'));
    },
    60 * 60 * 1000,
  );
  sessionCleanup.unref();

  // Audit log retention: prune entries older than the configured window so
  // the table doesn't grow forever. 0 means "keep everything".
  const auditRetentionScan = () => {
    if (config.auditRetentionDays <= 0) return;
    const cutoff = new Date(Date.now() - config.auditRetentionDays * 24 * 60 * 60 * 1000);
    void repos.audit
      .pruneOlderThan(cutoff.toISOString())
      .then((count) => {
        if (count > 0) {
          logger.info(
            { count, retentionDays: config.auditRetentionDays },
            'pruned old audit log entries',
          );
        }
      })
      .catch((err) =>
        logger.warn({ err: (err as Error).message }, 'audit log retention scan failed'),
      );
  };
  const auditRetentionInterval = setInterval(auditRetentionScan, AUDIT_RETENTION_SCAN_INTERVAL_MS);
  auditRetentionInterval.unref();
  queueMicrotask(auditRetentionScan);

  // Scheduled backups: enqueue a backup for any installed instance whose
  // configured interval has elapsed since its last backup.
  const runBackupScan = () => {
    void instances
      .runDueScheduledBackups()
      .catch((err) => logger.warn({ err: (err as Error).message }, 'scheduled backup scan failed'));
  };
  const backupScheduler = setInterval(runBackupScan, BACKUP_SCHEDULER_INTERVAL_MS);
  backupScheduler.unref();
  queueMicrotask(runBackupScan);

  // Crash auto-restart: opt-in per instance, capped to avoid restart loops
  // on a server that crashes immediately every time (bad config, corrupt world).
  const crashRestartTracker = new CrashRestartTracker();
  const handleCrashed = async (instanceId: string): Promise<void> => {
    const row = await repos.instances.findById(instanceId);
    if (!row || row.crash_restart !== 1 || row.installed !== 1) return;

    const allowed = crashRestartTracker.recordAndCheck(instanceId, CRASH_RESTART_LIMITS);
    if (!allowed) {
      logger.warn({ instanceId }, 'crash-restart limit reached, giving up');
      await audit({
        action: 'instance.crash_restart_giving_up',
        targetType: 'instance',
        targetId: instanceId,
        detail: `${row.name}: crashed repeatedly, pausing automatic restart`,
      });
      return;
    }

    const timer = setTimeout(() => {
      void (async () => {
        if (processes.isActive(instanceId)) return;
        try {
          await instances.start(instanceId);
          await audit({
            action: 'instance.auto_restarted',
            targetType: 'instance',
            targetId: instanceId,
            detail: row.name,
          });
        } catch (err) {
          logger.warn(
            { instanceId, err: (err as Error).message },
            'automatic restart after crash failed',
          );
        }
      })();
    }, CRASH_RESTART_DELAY_MS);
    timer.unref();
  };
  const unsubscribeCrashRestart = events.onEvent((event) => {
    if (event.kind !== 'instance_status' || event.status !== 'crashed') return;
    void handleCrashed(event.instanceId).catch((err) => {
      logger.warn(
        { instanceId: event.instanceId, err: (err as Error).message },
        'crash-restart handling failed',
      );
    });
  });

  return {
    config,
    logger,
    db,
    repos,
    auth,
    templates,
    events,
    processes,
    jobs: jobService,
    backups,
    files,
    instances,
    linuxUsers,
    systemStats,
    selfUpdate,
    logs,
    componentLogger,
    audit,
    async shutdown() {
      clearInterval(sessionCleanup);
      clearInterval(backupScheduler);
      clearInterval(auditRetentionInterval);
      unsubscribeCrashRestart();
      await db.close();
    },
  };
}
