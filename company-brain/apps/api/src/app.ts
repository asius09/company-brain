/**
 * API composition root.
 *
 * Route order matters only in that `/api/auth/*` is mounted first, so Better
 * Auth claims its own paths before the catch-all 404.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { createAuth } from '@company-brain/auth';
import { getEnv, notFound } from '@company-brain/core';
import { errorHandler, requestContext } from './middleware';
import { auth } from './middleware/auth';
import { chatRoute } from './routes/chat';
import { documentsRoute } from './routes/documents';
import { sourcesRoute } from './routes/sources';
import { searchRoute } from './routes/search';

export function createApi(): Hono {
  const env = getEnv();
  const app = new Hono();

  app.use('*', logger());
  app.onError(errorHandler);

  // The web app runs on its own origin in dev, so CORS is not optional there.
  // `credentials` is required for the session cookie, which rules out `*`.
  app.use(
    '/api/*',
    cors({
      origin: env.CORS_ORIGINS,
      allowHeaders: ['content-type', 'authorization', 'x-request-id'],
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      credentials: true,
      maxAge: 86_400,
    }),
    requestContext,
  );

  app.get('/health', (c) =>
    c.json({ success: true, data: { status: 'ok', uptimeSeconds: Math.round(process.uptime()) } }),
  );

  /**
   * Better Auth handles its own authentication and error shape, so it bypasses
   * this app's envelope and middleware entirely.
   */
  app.on(['GET', 'POST'], '/api/auth/*', (c) => {
    const handler = auth().handler;
    return handler(c.req.raw);
  });

  app.route('/api/sources', sourcesRoute);
  app.route('/api/documents', documentsRoute);
  app.route('/api/chat', chatRoute);
  app.route('/api/search', searchRoute);

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json(
        {
          success: false,
          error: { code: 'NOT_FOUND', message: `No route for ${c.req.method} ${c.req.path}` },
          meta: { requestId: c.get('requestId') },
        },
        404,
      );
    }
    throw notFound('Route');
  });

  return app;
}

export { createAuth };
