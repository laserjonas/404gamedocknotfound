import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import { createDatabase, type DatabaseClient } from './db/database.js';
import { runMigrations } from './db/migrations.js';
import { UserRepository } from './db/repositories/users.js';
import { SessionRepository } from './db/repositories/sessions.js';
import { InstanceRepository } from './db/repositories/instances.js';
import { JobRepository } from './db/repositories/jobs.js';
import { BackupRepository } from './db/repositories/backups.js';
import { AuditRepository } from './db/repositories/audit.js';
import { SettingsRepository } from './db/repositories/settings.js';
import { AuthService } from './auth/service.js';
import { TemplateService } from './services/templates.js';
import { EventHub } from './services/events.js';
import { ProcessManager } from './services/processManager.js';
import { JobService } from './services/jobs.js';
import { BackupService } from './services/backups.js';
import { FileService } from './services/files.js';
import { InstanceService } from './services/instances.js';
import { SystemStatsService } from './services/systemStats.js';
import { CrashRestartTracker } from './services/crashRestart.js';
import { toAuditDto } from './db/repositories/audit.js';

const CRASH_RESTART_LIMITS = { maxRestarts: 4, windowMs: 5 * 60 * 1000 };
const CRASH_RESTART_DELAY_MS = 5000;
const BACKUP_SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;

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
  };
  auth: AuthService;
  templates: TemplateService;
  events: EventHub;
  processes: ProcessManager;
  jobs: JobService;
  backups: BackupService;
  files: FileService;
  instances: InstanceService;
  systemStats: SystemStatsService;
  audit(entry: {
    userId?: string | null;
    username?: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    detail?: string;
  }): void;
  shutdown(): Promise<void>;
}

export function createContext(config: AppConfig, logger: Logger): AppContext {
  const db = createDatabase(config.databaseUrl, config.dataDir);
  runMigrations(db, logger);

  const repos = {
    users: new UserRepository(db),
    sessions: new SessionRepository(db),
    instances: new InstanceRepository(db),
    jobs: new JobRepository(db),
    backups: new BackupRepository(db),
    audit: new AuditRepository(db),
    settings: new SettingsRepository(db),
  };

  const events = new EventHub();

  const audit: AppContext['audit'] = (entry) => {
    const row = repos.audit.add(entry);
    events.publish({ kind: 'audit', entry: toAuditDto(row) });
  };

  const auth = new AuthService(repos.users, repos.sessions);
  const templates = new TemplateService(db, config.dataDir, logger);
  templates.reload();

  const processes = new ProcessManager(
    config.logDir,
    events,
    {
      persistStatus: (instanceId, status, pid) => {
        // The instance row may already be gone when deletion races a stop.
        if (repos.instances.findById(instanceId)) {
          repos.instances.update(instanceId, { status, lastPid: pid });
        }
      },
      recordEvent: (action, instanceId, detail) => {
        const name = repos.instances.findById(instanceId)?.name ?? instanceId;
        audit({
          action,
          targetType: 'instance',
          targetId: instanceId,
          detail: `${name}: ${detail}`,
        });
      },
    },
    logger,
  );

  const jobService = new JobService(repos.jobs, repos.instances, events, logger);
  const backups = new BackupService(config.backupDir, repos.backups);
  const files = new FileService(config.maxUploadBytes);
  const instances = new InstanceService(
    repos.instances,
    repos.backups,
    templates,
    jobService,
    processes,
    backups,
    config,
    logger,
  );
  const systemStats = new SystemStatsService();

  // Periodic session cleanup.
  const sessionCleanup = setInterval(() => auth.cleanupExpired(), 60 * 60 * 1000);
  sessionCleanup.unref();

  // Scheduled backups: enqueue a backup for any installed instance whose
  // configured interval has elapsed since its last backup.
  const backupScheduler = setInterval(
    () => instances.runDueScheduledBackups(),
    BACKUP_SCHEDULER_INTERVAL_MS,
  );
  backupScheduler.unref();
  queueMicrotask(() => instances.runDueScheduledBackups());

  // Crash auto-restart: opt-in per instance, capped to avoid restart loops
  // on a server that crashes immediately every time (bad config, corrupt world).
  const crashRestartTracker = new CrashRestartTracker();
  const unsubscribeCrashRestart = events.onEvent((event) => {
    if (event.kind !== 'instance_status' || event.status !== 'crashed') return;
    const row = repos.instances.findById(event.instanceId);
    if (!row || row.crash_restart !== 1 || row.installed !== 1) return;

    const allowed = crashRestartTracker.recordAndCheck(event.instanceId, CRASH_RESTART_LIMITS);
    if (!allowed) {
      logger.warn({ instanceId: event.instanceId }, 'crash-restart limit reached, giving up');
      audit({
        action: 'instance.crash_restart_giving_up',
        targetType: 'instance',
        targetId: event.instanceId,
        detail: `${row.name}: crashed repeatedly, pausing automatic restart`,
      });
      return;
    }

    const timer = setTimeout(() => {
      if (processes.isActive(event.instanceId)) return;
      try {
        instances.start(event.instanceId);
        audit({
          action: 'instance.auto_restarted',
          targetType: 'instance',
          targetId: event.instanceId,
          detail: row.name,
        });
      } catch (err) {
        logger.warn(
          { instanceId: event.instanceId, err: (err as Error).message },
          'automatic restart after crash failed',
        );
      }
    }, CRASH_RESTART_DELAY_MS);
    timer.unref();
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
    systemStats,
    audit,
    async shutdown() {
      clearInterval(sessionCleanup);
      clearInterval(backupScheduler);
      unsubscribeCrashRestart();
      await processes.shutdownAll();
      db.close();
    },
  };
}
