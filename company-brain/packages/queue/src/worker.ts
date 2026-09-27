import { hostname } from 'node:os';
import { createLogger, getEnv, serializeError, toAppError } from '@company-brain/core';
import {
  backoffMs,
  claimBatch,
  completeJob,
  extendLease,
  failJob,
  reclaimStaleJobs,
  requeueJob,
} from './claim';
import {
  DelayedJobError,
  PermanentJobError,
  type ClaimedJob,
  type HandlerContext,
  type JobHandler,
  type QueueJobType,
} from './types';

const log = createLogger('queue.worker');

export interface WorkerOptions {
  /** Stable identity for leases. Defaults to `${hostname}:${pid}`. */
  workerId?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  /** How often a running job pushes its lease out. Defaults to a third of the stale window. */
  heartbeatIntervalMs?: number;
  /** Runs once per loop; the point at which stale-lease recovery is due. */
  reclaim?: () => Promise<number>;
}

export type JobHandlers = {
  [K in QueueJobType]?: JobHandler<K>;
};

/**
 * Leases are three times the stale window: generous enough to survive a GC pause
 * or a slow database, tight enough that a dead worker's jobs come back quickly.
 */
function defaultHeartbeat(env: ReturnType<typeof getEnv>): number {
  return Math.max(1_000, Math.floor(env.WORKER_STALE_LOCK_MS / 3));
}

function defaultWorkerId(): string {
  return `${hostname()}:${process.pid}`;
}

/**
 * A handler with its payload type erased. The registry is heterogeneous by
 * nature, so it cannot be typed as a `Map<string, JobHandler<T>>`.
 */
type ErasedHandler = (ctx: ErasedContext) => Promise<void>;

interface ErasedContext {
  job: ClaimedJob;
  payload: Record<string, unknown>;
  organizationId: string;
  signal: AbortSignal;
  progress: (percent: number) => Promise<void>;
  requeue: (reason: string) => Promise<never>;
}

interface Running {
  job: ClaimedJob;
  controller: AbortController;
  timer: ReturnType<typeof setInterval>;
  heartbeat: Promise<void> | null;
}

/**
 * Drains the queue until `stop()`.
 *
 * Deliberately simple: a poll loop plus a concurrency gate. At this scale a
 * broker would only add an operational dependency, and the durability story
 * ("progress lives in Postgres") is stronger because the queue and the data it
 * protects share one transactional store.
 */
export class QueueWorker {
  readonly workerId: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly reclaim: () => Promise<number>;
  private readonly handlers: Map<string, ErasedHandler>;

  private readonly running = new Map<string, Running>();
  private readonly abort = new AbortController();
  private stopped = false;
  private lastReclaimAt = 0;
  private loop: Promise<void> | null = null;

  constructor(handlers: JobHandlers, options: WorkerOptions = {}) {
    const env = getEnv();
    this.workerId = options.workerId ?? defaultWorkerId();
    this.concurrency = options.concurrency ?? env.WORKER_CONCURRENCY;
    this.pollIntervalMs = options.pollIntervalMs ?? env.WORKER_POLL_INTERVAL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? defaultHeartbeat(env);
    this.reclaim = options.reclaim ?? reclaimStaleJobs;
    this.handlers = new Map(
      Object.entries(handlers).map(([type, handler]) => [type, handler as ErasedHandler]),
    );
  }

  /** Job types this worker can run. Useful to assert at boot. */
  get handledTypes(): string[] {
    return [...this.handlers.keys()].sort();
  }

  private inFlight(): number {
    return this.running.size;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;

    const env = getEnv();
    const now = Date.now();
    if (now - this.lastReclaimAt > env.WORKER_STALE_LOCK_MS / 2) {
      this.lastReclaimAt = now;
      // Fire-and-forget: recovery must never delay claiming real work.
      void this.reclaim().catch((error) =>
        log.error('worker.reclaim_failed', 'stale lease recovery errored', {}, error),
      );
    }

    const slots = this.concurrency - this.inFlight();
    if (slots <= 0) return;

    console.log('TICK', Date.now(), this.workerId, 'stopped=', this.stopped);
    let claimed: ClaimedJob[] = [];
    try {
      claimed = await claimBatch(this.workerId, slots);
      if (claimed.length) console.log('TICKCLAIM', Date.now(), this.workerId, claimed.length);
    } catch (error) {
      log.error('worker.claim_failed', 'could not claim jobs', {}, error);
      return;
    }

    for (const job of claimed) {
      if (this.inFlight() >= this.concurrency) {
        // Raced with another tick; put it straight back rather than dropping it.
        await requeueJob(job, this.workerId, 'concurrency limit reached');
        continue;
      }
      void this.execute(job);
    }
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const started = Date.now();
    const handler = this.handlers.get(job.type);

    if (!handler) {
      log.error('worker.no_handler', 'no handler registered for job type', {
        jobId: job.id,
        type: job.type,
      });
      await failJob(job, this.workerId, new PermanentJobError(`no handler for ${job.type}`), {
        permanent: true,
      });
      return;
    }

    const controller = new AbortController();
    let leaseLost = false;

    const timer = setInterval(() => {
      // Serialise heartbeats so a slow extend cannot overlap the next tick and
      // report a stale `running` state.
      if (leaseLost) return;
      const beat = extendLease(job.id, this.workerId).then((held) => {
        if (!held) {
          leaseLost = true;
          controller.abort();
        }
      });
      this.running.set(job.id, {
        ...(this.running.get(job.id) as Running),
        heartbeat: beat,
      });
      void beat.catch(() => undefined);
    }, this.heartbeatIntervalMs);
    timer.unref?.();

    this.running.set(job.id, { job, controller, timer, heartbeat: null });

    const ctx: ErasedContext = {
      job,
      payload: job.payload,
      organizationId: job.organizationId,
      signal: controller.signal,
      progress: async (percent) => {
        if (leaseLost) return;
        const held = await extendLease(job.id, this.workerId, percent);
        if (!held) {
          leaseLost = true;
          controller.abort();
        }
      },
      requeue: async (reason) => {
        await requeueJob(job, this.workerId, reason);
        throw new DelayedJobError(reason, 0);
      },
    };

    try {
      // Re-assert the payload against the job's own `type`. This is the one
      // place the erased registry becomes type-safe again, and it holds because
      // `enqueue` is the only producer of job rows and is compile-time checked
      // against `JobPayloads`.
      await (handler as JobHandler)(ctx as unknown as HandlerContext);
      if (leaseLost) {
        log.warn('worker.lease_lost', 'abandoning work after losing the lease', {
          jobId: job.id,
          type: job.type,
        });
        return;
      }
      await completeJob(job.id, this.workerId);
      log.info('worker.job_completed', 'job completed', {
        jobId: job.id,
        type: job.type,
        organizationId: job.organizationId,
        attempt: job.attempts,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      if (leaseLost) {
        // Another worker owns it now; touching the row would corrupt its state.
        log.warn('worker.abandoned', 'not recording failure for a job we no longer own', {
          jobId: job.id,
          type: job.type,
        });
        return;
      }

      if (this.abort.signal.aborted && !isShutdownError(error)) {
        // SIGTERM mid-job: park it so a deploy does not burn a retry.
        await requeueJob(job, this.workerId, 'worker shutting down');
        log.info('worker.requeued_on_shutdown', 'parked job for another worker', {
          jobId: job.id,
          type: job.type,
        });
        return;
      }

      const permanent =
        error instanceof PermanentJobError ||
        toAppError(error).status === 400 ||
        toAppError(error).status === 422;

      const retryInMs = error instanceof DelayedJobError ? error.delayMs : undefined;

      await failJob(job, this.workerId, error, { permanent, retryInMs }).catch((writeError) => {
        log.error('worker.fail_write_failed', 'could not record job failure', {}, writeError);
      });

      if (permanent && !(error instanceof DelayedJobError)) {
        log.error('worker.job_permanent_failure', 'job failed permanently', {
          jobId: job.id,
          type: job.type,
          ...serializeError(error),
        });
      }
    } finally {
      clearInterval(timer);
      this.running.delete(job.id);
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.loop = this.run();
    await this.loop;
  }

  private async run(): Promise<void> {
    console.log('RUNSTART', Date.now(), this.workerId);
    log.info('worker.started', 'queue worker started', {
      workerId: this.workerId,
      concurrency: this.concurrency,
      pollIntervalMs: this.pollIntervalMs,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
    });

    while (!this.stopped) {
      await this.tick();
      if (this.stopped) break;
      if (this.inFlight() === 0) {
        // Nothing to do: wait rather than spin. Keeps an idle worker near zero CPU.
        await sleep(this.pollIntervalMs, this.abort.signal);
      } else {
        // Saturated: yield briefly so completed work frees slots promptly.
        await sleep(Math.min(this.pollIntervalMs, 100), this.abort.signal);
      }
    }

    console.log('RUNEND', Date.now(), this.workerId);
    await this.drain();
    log.info('worker.stopped', 'queue worker stopped', { workerId: this.workerId });
  }

  /** Stops polling, then waits for in-flight jobs to finish. */
  async stop(gracePeriodMs = 30_000): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();

    // Wait for the poll loop to unwind before draining. A tick can be sitting
    // on a `claimBatch` round trip, and aborting the sleep does not cancel a
    // query already in flight: without this wait, `stop()` would return while
    // that tick went on to claim a fresh batch and run it, so a worker could
    // keep taking jobs -- and failing any type it has no handler for -- after
    // its owner had already declared it shut down.
    const loop = this.loop;
    if (loop) {
      await Promise.race([
        loop.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, gracePeriodMs)),
      ]);
    }

    await this.drain(gracePeriodMs);
  }

  private async drain(gracePeriodMs = 30_000): Promise<void> {
    if (this.running.size === 0) return;
    const deadline = Date.now() + gracePeriodMs;
    log.info('worker.draining', 'waiting for in-flight jobs', {
      inFlight: this.running.size,
      gracePeriodMs,
    });
    while (this.running.size > 0 && Date.now() < deadline) {
      await sleep(100);
    }
    if (this.running.size > 0) {
      // Out of time: abort the handlers. Their rows stay `running` until the
      // lease expires, and then reclaimStaleJobs puts them back on the queue.
      for (const entry of this.running.values()) entry.controller.abort();
      log.warn('worker.drain_timeout', 'aborted in-flight jobs after grace period', {
        inFlight: this.running.size,
      });
    }
  }
}

function isShutdownError(error: unknown): boolean {
  const err = toAppError(error);
  return err.status === 499 || err.message === 'Worker shutting down';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export { backoffMs };
