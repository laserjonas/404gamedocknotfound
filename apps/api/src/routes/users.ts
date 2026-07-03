import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireRole } from '../plugins/auth.js';
import { toUserDto } from '../db/repositories/users.js';
import { hashPassword, validatePasswordPolicy } from '../auth/passwords.js';
import { badRequest, conflict, notFound } from '../errors.js';

const usernameSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'Invalid username format');

const createUserSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(256),
  role: z.enum(['admin', 'operator', 'viewer']),
});

const patchUserSchema = z.object({
  password: z.string().min(1).max(256).optional(),
  role: z.enum(['admin', 'operator', 'viewer']).optional(),
  disabled: z.boolean().optional(),
});

export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/users', { preHandler: requireRole('admin') }, async () => {
    const rows = await ctx.repos.users.list();
    return rows.map(toUserDto);
  });

  app.post('/api/users', { preHandler: requireRole('admin') }, async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid input');
    const { username, password, role } = parsed.data;

    const policyError = validatePasswordPolicy(password);
    if (policyError) throw badRequest(policyError);
    if (await ctx.repos.users.findByUsername(username)) {
      throw conflict(`User "${username}" already exists`);
    }

    const user = await ctx.repos.users.create(username, await hashPassword(password), role);
    await ctx.audit({
      userId: request.auth!.user.id,
      username: request.auth!.user.username,
      action: 'user.create',
      targetType: 'user',
      targetId: user.id,
      detail: `created ${username} (${role})`,
    });
    reply.code(201);
    return toUserDto(user);
  });

  app.patch('/api/users/:id', { preHandler: requireRole('admin') }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = patchUserSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid input');

    const user = await ctx.repos.users.findById(id);
    if (!user) throw notFound('User not found');

    const patch = parsed.data;
    const changes: string[] = [];

    // Never let the last active admin lock themselves (or everyone) out.
    const demotingAdmin =
      user.role === 'admin' &&
      ((patch.role !== undefined && patch.role !== 'admin') || patch.disabled === true);
    if (demotingAdmin && (await ctx.repos.users.countAdmins()) <= 1) {
      throw conflict('Cannot demote or disable the last admin account');
    }

    const update: Parameters<typeof ctx.repos.users.update>[1] = {};
    if (patch.password !== undefined) {
      const policyError = validatePasswordPolicy(patch.password);
      if (policyError) throw badRequest(policyError);
      update.passwordHash = await hashPassword(patch.password);
      changes.push('password');
      await ctx.auth.logoutAllForUser(id);
    }
    if (patch.role !== undefined) {
      update.role = patch.role;
      changes.push(`role=${patch.role}`);
    }
    if (patch.disabled !== undefined) {
      update.disabled = patch.disabled;
      changes.push(`disabled=${patch.disabled}`);
      if (patch.disabled) await ctx.auth.logoutAllForUser(id);
    }

    await ctx.repos.users.update(id, update);
    await ctx.audit({
      userId: request.auth!.user.id,
      username: request.auth!.user.username,
      action: 'user.update',
      targetType: 'user',
      targetId: id,
      detail: `${user.username}: ${changes.join(', ')}`,
    });
    return toUserDto((await ctx.repos.users.findById(id))!);
  });

  app.delete('/api/users/:id', { preHandler: requireRole('admin') }, async (request) => {
    const { id } = request.params as { id: string };
    const user = await ctx.repos.users.findById(id);
    if (!user) throw notFound('User not found');
    if (user.id === request.auth!.user.id) {
      throw conflict('You cannot delete your own account');
    }
    if (user.role === 'admin' && (await ctx.repos.users.countAdmins()) <= 1) {
      throw conflict('Cannot delete the last admin account');
    }
    await ctx.auth.logoutAllForUser(id);
    await ctx.repos.users.delete(id);
    await ctx.audit({
      userId: request.auth!.user.id,
      username: request.auth!.user.username,
      action: 'user.delete',
      targetType: 'user',
      targetId: id,
      detail: user.username,
    });
    return { ok: true };
  });
}
