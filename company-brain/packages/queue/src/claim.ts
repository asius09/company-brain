import { createLogger, getEnv } from '@company-brain/core';
import { jobs, withSystemAccess, type Job } from '@company-brain/db';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { ClaimedJob } from './types';

const log = createLogger('queue.claim');

/**
 * Claiming runs under `withSystemAccess` on purpose: a worker drains jobs for
 * every tenant at once, so it cannot have a single tenant stamped on the
 * connection. This is the sanctioned cross-tenant path — it touches only the
 * `jobs` table, never tenant content.
 */

function toClaimed(row: Job): ClaimedJob {
  return {
    id: row.id,
    organizationId: row.organizationId,
    type: row.type,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    priority: row.priority,
    lockedBy: row.lockedBy,
    startedAt: row.startedAt,
    runAfter: row.runAfter,
    enqueuedAt: row.createdAt,
  };
}

/**
 * Returns expired `running` jobs to the queue. A worker that was killed
 * mid-job leaves its rows locked forever otherwise; this is what makes the queue
 * durable across deploys and OOM kills.
 *
 * Jobs already past their attempt budget are failed outright rather than
 * re-queued, so they cannot loop forever.
 */
export async function reclaimStaleJobs(): Promise<number> {
  const { WORKER_STALE_LOCK_MS } = getEnv();

  return withSystemAccess(async (tx) => {
    const requeued = await tx
      .update(jobs)
      .set({
        status: 'queued',
        lockedBy: null,
        lockedAt: null,
        runAfter: new Date(),
        lastError: 'worker lease expired; requeued',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobs.status, 'running'),
          lte(
            sql`coalesce(${jobs.lockedAt}, ${jobs.startedAt}, ${jobs.createdAt})`,
            // A Date beside a raw expression has no inferred type, so the driver
            // hands postgres.js a Date object and it rejects it. Bind the ISO
            // string and let the cast restore the type.
            sql`${new Date(Date.now() - WORKER_STALE_LOCK_MS).toISOString()}::timestamptz`,
          ),
          sql`${jobs.attempts} < ${jobs.maxAttempts}`,
        ),
      )
      .returning({ id: jobs.id });

    const exhausted = await tx
      .update(jobs)
      .set({
        status: 'failed',
        lockedBy: null,
        lockedAt: null,
        completedAt: new Date(),
        lastError: 'worker lease expired and retry budget exhausted',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobs.status, 'running'),
          lte(
            sql`coalesce(${jobs.lockedAt}, ${jobs.startedAt}, ${jobs.createdAt})`,
            // A Date beside a raw expression has no inferred type, so the driver
            // hands postgres.js a Date object and it rejects it. Bind the ISO
            // string and let the cast restore the type.
            sql`${new Date(Date.now() - WORKER_STALE_LOCK_MS).toISOString()}::timestamptz`,
          ),
          sql`${jobs.attempts} >= ${jobs.maxAttempts}`,
        ),
      )
      .returning({ id: jobs.id });

    const total = requeued.length + exhausted.length;
    if (total > 0) {
      log.warn('claim.reclaimed_stale', 'recovered jobs from dead workers', {
        requeued: requeued.length,
        failed: exhausted.length,
        staleAfterMs: WORKER_STALE_LOCK_MS,
      });
    }
    return total;
  });
}

/**
 * Atomically claims up to `limit` runnable jobs for `workerId`.
 *
 * `FOR UPDATE SKIP LOCKED` inside the candidate sub-select is what lets N workers
 * poll the same table with no coordination and no double-delivery: a row another
 * worker is already holding is skipped rather than blocked on. The outer UPDATE
 * then flips status and increments `attempts`, and `RETURNING` hands back exactly
 * the rows this worker won.
 */
export async function claimBatch(workerId: string, limit?: number): Promise<ClaimedJob[]> {
  const batchSize = limit ?? getEnv().WORKER_BATCH_SIZE;

  return withSystemAccess(async (tx) => {
    const candidates = tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.status, 'queued'), lte(jobs.runAfter, new Date())))
      // This decides *which* rows make the batch — the top N by priority, so a
      // flood of low-priority work can never starve a high-priority job. It does
      // not decide the order the batch is then processed in: Postgres gives no
      // ordering guarantee for a sub-select driving UPDATE ... FROM, and there
      // is no ORDER BY on UPDATE to ask for one. Concurrency is bounded anyway,
      // so every row in the batch runs promptly.
      .orderBy(asc(jobs.priority), asc(jobs.runAfter), asc(jobs.createdAt))
      .limit(batchSize)
      .for('update', { skipLocked: true })
      .as('candidate');

    // The join condition is spelled out rather than inferred: Drizzle's
    // `.from()` cannot know how a table relates to an arbitrary sub-select, so
    // omitting it produces `UPDATE jobs SET ... FROM candidates` with no WHERE —
    // a cross join that locks and rewrites *every* row in the table. That bug
    // silently defeated the whole no-double-delivery guarantee.
    const claimed = await tx
      .update(jobs)
      .set({
        status: 'running',
        // A delivery counts as an attempt even if the worker dies immediately,
        // so a poison job cannot be retried forever.
        attempts: sql`${jobs.attempts} + 1`,
        lockedAt: new Date(),
        lockedBy: workerId,
        startedAt: sql`coalesce(${jobs.startedAt}, now())`,
        updatedAt: new Date(),
      })
      .from(candidates)
      .where(eq(jobs.id, candidates.id))
      .returning();

    if (claimed.length > 0) {
      log.debug('claim.batch', 'claimed jobs', {
        workerId,
        count: claimed.length,
        types: claimed.map((row) => row.type),
      });
    }
    return claimed.map(toClaimed);
  });
}

/**
 * Pushes the lease out and records progress. Returns false if the job is no
 * longer ours — the handler should then abandon its work.
 */
export async function extendLease(jobId: string, workerId: string, percent?: number): Promise<boolean> {
  return withSystemAccess(async (tx) => {
    const rows = await tx
      .update(jobs)
      .set({
        lockedAt: new Date(),
        ...(percent === undefined ? {} : { progress: Math.max(0, Math.min(100, Math.round(percent))) }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.lockedBy, workerId),
          eq(jobs.status, 'running'),
        ),
      )
      .returning({ id: jobs.id });
    return rows.length > 0;
  });
}

/**
 * Guarded by `lockedBy` so a handler whose lease already expired cannot mark a
 * job completed after another worker picked it up.
 */
export async function completeJob(jobId: string, workerId: string): Promise<boolean> {
  return withSystemAccess(async (tx) => {
    const rows = await tx
      .update(jobs)
      .set({
        status: 'completed',
        progress: 100,
        lockedBy: null,
        lockedAt: null,
        completedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.lockedBy, workerId),
          eq(jobs.status, 'running'),
        ),
      )
      .returning({ id: jobs.id });

    if (rows.length === 0) {
      log.warn('complete.stale_worker', 'ignored completion from a worker that no longer owns the job', {
        jobId,
        workerId,
      });
    }
    return rows.length > 0;
  });
}

export interface FailOptions {
  /** Overrides the computed backoff, e.g. to honour a provider `retry-after`. */
  retryInMs?: number;
  /** Marks the job failed regardless of remaining attempts. */
  permanent?: boolean;
}

const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 15 * 60_000;

/**
 * Exponential backoff with full jitter. Full jitter (random over the whole
 * window, not a small band) is what stops a fleet of workers that all failed on
 * the same provider outage from retrying in lockstep and re-creating the outage.
 */
export function backoffMs(attempts: number, retryInMs?: number): number {
  if (retryInMs !== undefined) return Math.max(retryInMs, 0);
  const window = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
  return Math.floor(Math.random() * window);
}

/**
 * Records a failure. Retries with backoff while the attempt budget allows,
 * otherwise marks the job failed. The job row stays for inspection either way —
 * dropping it would lose the error trail.
 */
export async function failJob(
  job: ClaimedJob,
  workerId: string,
  error: unknown,
  options: FailOptions = {},
): Promise<{ retrying: boolean; runAfter: Date | null; reason: string }> {
  const reason = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;
  const retrying = !exhausted && !options.permanent;

  if (!retrying) {
    await withSystemAccess(async (tx) => {
      await tx
        .update(jobs)
        .set({
          status: 'failed',
          lockedBy: null,
          lockedAt: null,
          completedAt: new Date(),
          lastError: reason.slice(0, 4_000),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.lockedBy, workerId),
            eq(jobs.status, 'running'),
          ),
        );
    });

    log.error('fail.permanent', 'job failed permanently', {
      jobId: job.id,
      type: job.type,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      reason,
    });
    return { retrying: false, runAfter: null, reason };
  }

  const delay = backoffMs(job.attempts, options.retryInMs);
  const runAfter = new Date(Date.now() + delay);

  await withSystemAccess(async (tx) => {
    await tx
      .update(jobs)
      .set({
        status: 'queued',
        lockedBy: null,
        lockedAt: null,
        runAfter,
        lastError: reason.slice(0, 4_000),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobs.id, job.id),
          eq(jobs.lockedBy, workerId),
          eq(jobs.status, 'running'),
        ),
      );
  });

  log.warn('fail.retry_scheduled', 'job will be retried', {
    jobId: job.id,
    type: job.type,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    retryInMs: delay,
    reason,
  });
  return { retrying: true, runAfter, reason };
}

/**
 * Hands a claimed job back to the queue without consuming an attempt — used by
 * `HandlerContext.requeue` when a worker is shedding load.
 */
export async function requeueJob(job: ClaimedJob, workerId: string, reason: string): Promise<boolean> {
  return withSystemAccess(async (tx) => {
    const rows = await tx
      .update(jobs)
      .set({
        status: 'queued',
        lockedBy: null,
        lockedAt: null,
        runAfter: new Date(),
        attempts: sql`greatest(0, ${jobs.attempts} - 1)`,
        lastError: reason.slice(0, 4_000),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobs.id, job.id),
          eq(jobs.lockedBy, workerId),
          eq(jobs.status, 'running'),
        ),
      )
      .returning({ id: jobs.id });
    return rows.length > 0;
  });
}
