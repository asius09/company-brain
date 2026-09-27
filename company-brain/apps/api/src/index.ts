/**
 * API entry point.
 *
 * The server is the only place that owns the port, the listen callback, and the
 * shutdown sequence, so `app.ts` stays importable from tests.
 */
import { serve } from '@hono/node-server';
import { createLogger, getEnv, toAppError } from '@company-brain/core';
import { closePool } from '@company-brain/db';
import { createApi } from './app';

const log = createLogger('api');

function main(): void {
  const env = getEnv();
  const app = createApi();

  const server = serve({ fetch: app.fetch, port: env.API_PORT, hostname: env.API_HOST }, (info) => {
    log.info('api.listening', 'API is accepting requests', {
      port: info.port,
      url: `http://${env.API_HOST}:${info.port}`,
      corsOrigins: env.CORS_ORIGINS,
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('api.signal', 'draining before exit', { signal });

    // Stop accepting new connections, let in-flight requests finish, then
    // release the pool. Without the drain, a deploy drops live SSE streams
    // mid-answer.
    server.close(async (error) => {
      if (error) log.error('api.close_failed', 'server did not close cleanly', {}, error);
      try {
        await closePool();
        log.info('api.exit', 'clean shutdown complete');
        process.exit(error ? 1 : 0);
      } catch (poolError) {
        log.error('api.pool_close_failed', 'database pool did not close', {}, poolError);
        process.exit(1);
      }
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error('api.unhandled_rejection', 'unhandled rejection outside a request', {}, reason);
  });
}

try {
  main();
} catch (error) {
  const appError = toAppError(error);
  log.fatal('api.fatal', 'API failed to start: ' + appError.message, {}, appError.cause);
  process.exit(1);
}
