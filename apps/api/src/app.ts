import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { AppContext } from './context.js';
import { AppError } from './errors.js';
import { buildAuthHook } from './plugins/auth.js';
import { PathTraversalError } from './utils/safePath.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerPasskeyRoutes } from './routes/passkeys.js';
import { registerApiTokenRoutes } from './routes/apiTokens.js';
import { registerUserRoutes } from './routes/users.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerInstanceRoutes } from './routes/instances.js';
import { registerFileRoutes } from './routes/files.js';
import { registerBackupRoutes } from './routes/backups.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerEventRoutes } from './routes/events.js';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.componentLogger('http') as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
    disableRequestLogging: !ctx.config.isProduction ? false : true,
  });

  await app.register(fastifyCookie, { secret: ctx.config.sessionSecret });
  await app.register(fastifyMultipart, {
    limits: { fileSize: ctx.config.maxUploadBytes, files: 1 },
  });

  // Minimal security headers (a reverse proxy may add more).
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
  });

  app.addHook('preHandler', buildAuthHook(ctx.auth));

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        statusCode: error.statusCode,
      });
      return;
    }
    if (error instanceof PathTraversalError) {
      ctx.logger.warn({ url: request.url }, 'blocked path traversal attempt');
      reply.code(400).send({ error: 'bad_request', message: 'Invalid path', statusCode: 400 });
      return;
    }
    // Fastify validation / body parse errors carry a statusCode < 500.
    const err = error as { statusCode?: unknown; message?: unknown };
    const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (statusCode >= 500) {
      ctx.logger.error({ err: error, url: request.url }, 'unhandled error');
      reply.code(500).send({
        error: 'internal_error',
        message: 'Internal server error',
        statusCode: 500,
      });
    } else {
      reply.code(statusCode).send({
        error: 'bad_request',
        message: typeof err.message === 'string' ? err.message : 'Request error',
        statusCode,
      });
    }
  });

  registerAuthRoutes(app, ctx);
  registerPasskeyRoutes(app, ctx);
  registerApiTokenRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerTemplateRoutes(app, ctx);
  registerInstanceRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerBackupRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  registerEventRoutes(app, ctx);

  // Serve the built web UI in production (apps/web/dist copied to ../web-dist
  // by install.sh, or resolved from the monorepo layout).
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), '..', 'web-dist'),
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist'),
  ];
  const webRoot = candidates.find((dir) => existsSync(join(dir, 'index.html')));
  if (webRoot) {
    // preCompressed serves the .br/.gz variants emitted by
    // apps/web/scripts/compress-dist.mjs when the client accepts them -
    // the main bundle shrinks to roughly a quarter. index.html (and other
    // non-hashed files) keep the default max-age=0 + ETag revalidation, so
    // clients pick up new builds immediately after an update.
    await app.register(fastifyStatic, { root: webRoot, prefix: '/', preCompressed: true });
    if (existsSync(join(webRoot, 'assets'))) {
      // Vite content-hashes everything under assets/ - safe to cache forever.
      // The more specific /assets/ wildcard route wins over the '/' one.
      await app.register(fastifyStatic, {
        root: join(webRoot, 'assets'),
        prefix: '/assets/',
        preCompressed: true,
        decorateReply: false,
        maxAge: '1y',
        immutable: true,
      });
    }
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply
          .code(404)
          .send({ error: 'not_found', message: 'Endpoint not found', statusCode: 404 });
      } else {
        // SPA fallback
        reply.sendFile('index.html');
      }
    });
    ctx.logger.info({ webRoot }, 'serving web UI');
  } else {
    app.setNotFoundHandler((request, reply) => {
      reply.code(404).send({
        error: 'not_found',
        message: request.url.startsWith('/api/')
          ? 'Endpoint not found'
          : 'Web UI build not found. Run: pnpm --filter @gamedock/web build',
        statusCode: 404,
      });
    });
  }

  return app;
}
