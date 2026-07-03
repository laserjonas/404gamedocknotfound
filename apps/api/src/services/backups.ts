import { mkdir, rm, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as tar from 'tar';
import type { BackupDto } from '@gamedock/shared';
import type { BackupRepository, BackupRow } from '../db/repositories/backups.js';
import { isSafeName } from '../utils/safePath.js';
import { badRequest, notFound } from '../errors.js';

export function toBackupDto(row: BackupRow): BackupDto {
  return {
    id: row.id,
    instanceId: row.instance_id,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    note: row.note,
  };
}

/**
 * Creates and restores .tar.gz archives of instance directories.
 * Archives live in <backupDir>/<instanceId>/.
 */
export class BackupService {
  constructor(
    private backupDir: string,
    private backups: BackupRepository,
  ) {}

  private instanceBackupDir(instanceId: string): string {
    return join(this.backupDir, instanceId);
  }

  archivePath(row: BackupRow): string {
    if (!isSafeName(row.file_name)) {
      throw badRequest('Backup has an invalid file name');
    }
    return join(this.instanceBackupDir(row.instance_id), row.file_name);
  }

  async list(instanceId: string): Promise<BackupDto[]> {
    const rows = await this.backups.listForInstance(instanceId);
    return rows
      .filter((row) => existsSync(join(this.instanceBackupDir(instanceId), row.file_name)))
      .map(toBackupDto);
  }

  async create(params: {
    instanceId: string;
    instanceDir: string;
    note: string | null;
    excludePaths: string[];
    onLog: (line: string) => void;
  }): Promise<BackupRow> {
    const { instanceId, instanceDir } = params;
    if (!existsSync(instanceDir)) {
      throw notFound('Instance directory does not exist');
    }

    const targetDir = this.instanceBackupDir(instanceId);
    await mkdir(targetDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `backup-${stamp}.tar.gz`;
    const target = join(targetDir, fileName);

    const excludes = params.excludePaths
      .map((p) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
      .filter(Boolean);

    params.onLog(`Creating archive ${fileName}`);
    if (excludes.length > 0) {
      params.onLog(`Excluding: ${excludes.join(', ')}`);
    }

    const entries = await readdir(instanceDir);
    if (entries.length === 0) {
      throw badRequest('Instance directory is empty; nothing to back up');
    }

    await tar.create(
      {
        gzip: true,
        file: target,
        cwd: instanceDir,
        portable: true,
        filter: (entryPath) => {
          const normalized = entryPath.replace(/\\/g, '/').replace(/^\.\//, '');
          for (const exclude of excludes) {
            if (normalized === exclude || normalized.startsWith(exclude + '/')) {
              return false;
            }
          }
          return true;
        },
      },
      entries,
    );

    const size = (await stat(target)).size;
    params.onLog(`Archive created (${(size / 1024 / 1024).toFixed(1)} MiB)`);
    return await this.backups.create(instanceId, fileName, size, params.note);
  }

  async restore(params: {
    backup: BackupRow;
    instanceDir: string;
    onLog: (line: string) => void;
  }): Promise<void> {
    const archive = this.archivePath(params.backup);
    if (!existsSync(archive)) {
      throw notFound('Backup archive file is missing on disk');
    }

    params.onLog('Clearing instance directory...');
    if (existsSync(params.instanceDir)) {
      const entries = await readdir(params.instanceDir);
      for (const entry of entries) {
        await rm(join(params.instanceDir, entry), { recursive: true, force: true });
      }
    } else {
      await mkdir(params.instanceDir, { recursive: true });
    }

    params.onLog(`Extracting ${params.backup.file_name}...`);
    await tar.extract({ file: archive, cwd: params.instanceDir });
    params.onLog('Restore complete');
  }

  async delete(row: BackupRow): Promise<void> {
    const archive = this.archivePath(row);
    await rm(archive, { force: true });
    await this.backups.delete(row.id);
  }
}
