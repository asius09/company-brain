/**
 * Worker entry point.
 *
 * Runs a `QueueWorker` with every registered processor, and shuts down cleanly
 * on SIGINT/SIGTERM so a deploy parks in-flight jobs instead of leaving them
 * locked until their lease expires.
 */
import { createLogger, getEnv, toAppError } from '@company-brain/core';
import { closePool } from '@company-brain/db';
import { QueueWorker } from '@company-brain/queue/worker';
import { handlers } from './processors';

const log = createLogger('worker');

async function main(): Promise<void> {
  const env = getEnv();
  const worker = new QueueWorker(handlers, {
    concurrency: env.WORKER_CONCURRENCY,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
  });

  log.info('worker.boot', 'starting', {
    workerId: worker.workerId,
    handled: worker.handledTypes,
    concurrency: env.WORKER_CONCURRENCY,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    staleLockMs: env.WORKER_STALE_LOCK_MS,
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('worker.signal', 'draining before exit', { signal });
    void worker
      .stop(30_000)
      .then(async () => {
        await closePool();
        log.info('worker.exit', 'clean shutdown complete');
        process.exit(0);
      })
      .catch((error) => {
        log.error('worker.shutdown_failed', 'forcing exit after a failed drain', {}, error);
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // An unhandled error means an unknown bug in a handler; log it loudly and keep
  // the worker alive, because every queued job is still recoverable.
  process.on('unhandledRejection', (reason) => {
    log.error('worker.unhandled_rejection', 'unhandled rejection outside a job', {}, reason);
  });

  await worker.start();
}

main().catch((error) => {
  log.fatal('worker.fatal', 'worker failed to start', {}, toAppError(error));
  process.exit(1);
});
