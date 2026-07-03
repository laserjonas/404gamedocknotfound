import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireRole } from '../plugins/auth.js';
import { badRequest } from '../errors.js';
import { sanitizeRelativePath } from '../utils/safePath.js';

const pathQuerySchema = z.object({
  path: z.string().max(1024).default(''),
});

const writeSchema = z.object({
  path: z.string().min(1).max(1024),
  content: z.string(),
});

const mkdirSchema = z.object({
  path: z.string().min(1).max(1024),
});

export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  const instanceDirOf = async (id: string): Promise<string> => {
    await ctx.instances.getRow(id); // 404 when unknown
    return ctx.instances.instanceDir(id);
  };

  app.get('/api/instances/:id/files', { preHandler: requireRole('viewer') }, async (request) => {
    const { id } = request.params as { id: string };
    const query = pathQuerySchema.safeParse(request.query);
    if (!query.success) throw badRequest('Invalid path');
    const rel = sanitizeRelativePath(query.data.path);
    return ctx.files.list(await instanceDirOf(id), rel);
  });

  app.get(
    '/api/instances/:id/files/content',
    { preHandler: requireRole('viewer') },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = pathQuerySchema.safeParse(request.query);
      if (!query.success || !query.data.path) throw badRequest('A file path is required');
      const rel = sanitizeRelativePath(query.data.path);
      return ctx.files.readText(await instanceDirOf(id), rel);
    },
  );

  app.put(
    '/api/instances/:id/files/content',
    { preHandler: requireRole('operator') },
    async (request) => {
      const { id } = request.params as { id: string };
      const parsed = writeSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest('path and content are required');
      const rel = sanitizeRelativePath(parsed.data.path);
      await ctx.files.writeText(await instanceDirOf(id), rel, parsed.data.content);
      await ctx.audit({
        userId: request.auth!.user.id,
        username: request.auth!.user.username,
        action: 'file.write',
        targetType: 'instance',
        targetId: id,
        detail: rel,
      });
      return { ok: true };
    },
  );

  app.post(
    '/api/instances/:id/files/mkdir',
    { preHandler: requireRole('operator') },
    async (request) => {
      const { id } = request.params as { id: string };
      const parsed = mkdirSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest('A directory path is required');
      const rel = sanitizeRelativePath(parsed.data.path);
      await ctx.files.createDirectory(await instanceDirOf(id), rel);
      return { ok: true };
    },
  );

  app.post(
    '/api/instances/:id/files/upload',
    { preHandler: requireRole('operator') },
    async (request) => {
      const { id } = request.params as { id: string };
      const instanceDir = await instanceDirOf(id);

      const file = await request.file();
      if (!file) throw badRequest('No file uploaded (multipart field "file" expected)');

      const dirField = file.fields['path'];
      const rawDir =
        dirField && 'value' in dirField && typeof dirField.value === 'string' ? dirField.value : '';
      const relDir = sanitizeRelativePath(rawDir);
      const fileName = file.filename;
      if (!fileName || /[/\\\0]/.test(fileName)) {
        throw badRequest('Invalid upload file name');
      }
      const relPath = relDir ? `${relDir}/${fileName}` : fileName;

      const written = await ctx.files.upload(instanceDir, relPath, file.file);
      await ctx.audit({
        userId: request.auth!.user.id,
        username: request.auth!.user.username,
        action: 'file.upload',
        targetType: 'instance',
        targetId: id,
        detail: `${relPath} (${written} bytes)`,
      });
      return { ok: true, path: relPath, sizeBytes: written };
    },
  );

  app.delete(
    '/api/instances/:id/files',
    { preHandler: requireRole('operator') },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = pathQuerySchema.safeParse(request.query);
      if (!query.success || !query.data.path) throw badRequest('A path is required');
      const rel = sanitizeRelativePath(query.data.path);
      await ctx.files.delete(await instanceDirOf(id), rel);
      await ctx.audit({
        userId: request.auth!.user.id,
        username: request.auth!.user.username,
        action: 'file.delete',
        targetType: 'instance',
        targetId: id,
        detail: rel,
      });
      return { ok: true };
    },
  );
}
