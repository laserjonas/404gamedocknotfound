import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireRole } from '../plugins/auth.js';
import { badRequest, notFound } from '../errors.js';

const createBackupSchema = z.object({
  note: z.string().max(256).nullable().optional(),
  excludePaths: z.array(z.string().max(512)).max(64).optional(),
});

export function registerBackupRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/instances/:id/backups', { preHandler: requireRole('viewer') }, async (request) => {
    const { id } = request.params as { id: string };
    await ctx.instances.getRow(id);
    return ctx.backups.list(id);
  });

  app.post(
    '/api/instances/:id/backups',
    { preHandler: requireRole('operator') },
    async (request) => {
      const { id } = request.params as { id: string };
      const parsed = createBackupSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw badRequest('Invalid backup options');
      const job = await ctx.instances.enqueueBackup(
        id,
        request.auth!.user.username,
        parsed.data.note ?? null,
        parsed.data.excludePaths ?? [],
      );
      await ctx.audit({
        userId: request.auth!.user.id,
        username: request.auth!.user.username,
        action: 'backup.create',
        targetType: 'instance',
        targetId: id,
      });
      return { job: await ctx.jobs.dto(job) };
    },
  );

  app.post(
    '/api/instances/:id/backups/:backupId/restore',
    { preHandler: requireRole('operator') },
    async (request) => {
      const { id, backupId } = request.params as { id: string; backupId: string };
      const job = await ctx.instances.enqueueRestore(id, backupId, request.auth!.user.username);
      await ctx.audit({
        userId: request.auth!.user.id,
        username: request.auth!.user.username,
        action: 'backup.restore',
        targetType: 'instance',
        targetId: id,
        detail: backupId,
      });
      return { job: await ctx.jobs.dto(job) };
    },
  );

  app.delete(
    '/api/instances/:id/backups/:backupId',
    { preHandler: requireRole('operator') },
    async (request) => {
      const { id, backupId } = request.params as { id: string; backupId: string };
      await ctx.instances.getRow(id);
      const backup = await ctx.repos.backups.findById(backupId);
      if (!backup || backup.instance_id !== id) throw notFound('Backup not found');
      await ctx.backups.delete(backup);
      await ctx.audit({
        userId: request.auth!.user.id,
        username: request.auth!.user.username,
        action: 'backup.delete',
        targetType: 'instance',
        targetId: id,
        detail: backup.file_name,
      });
      return { ok: true };
    },
  );
}
