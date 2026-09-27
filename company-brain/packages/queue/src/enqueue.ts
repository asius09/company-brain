import { createLogger, getEnv } from '@company-brain/core';
import { jobs, withTenant, type Job } from '@company-brain/db';
import { and, eq } from 'drizzle-orm';
import type { JobPayloads, QueueJobType } from './types';

const log = createLogger('queue.enqueue');

export interface EnqueueInput<T extends QueueJobType> {
  organizationId: string;
  type: T;
  payload: JobPayloads[T];
  /** Lower runs first. Defaults to 100. */
  priority?: number;
  maxAttempts?: number;
  /** Not claimable before this instant; used for backoff and scheduling. */
  runAfter?: Date;
  /**
   * Collapses duplicates: enqueueing with a key that already has a
   * queued-or-running job returns that job instead of creating a new one.
   * Pass a natural key like `source.sync:${sourceId}:incremental`.
   */
  idempotencyKey?: string;
}

export interface EnqueueResult {
  id: string;
  /** True when an existing job was reused because of `idempotencyKey`. */
  deduped: boolean;
}

/**
 * Adds a job. Runs inside `withTenant` because the row carries a tenant
 * `organization_id` and the RLS policy on `jobs` requires the connection to be
 * stamped for the INSERT's WITH CHECK to pass.
 */
export async function enqueue<T extends QueueJobType>(input: EnqueueInput<T>): Promise<EnqueueResult> {
  const { organizationId, type, payload } = input;

  return withTenant(organizationId, async (tx) => {
    if (input.idempotencyKey) {
      const existing = await tx
        .select({ id: jobs.id, status: jobs.status })
        .from(jobs)
        .where(
          and(
            eq(jobs.organizationId, organizationId),
            eq(jobs.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);

      const found = existing[0];
      if (found) {
        log.debug('enqueue.deduped', 'reusing existing job', {
          jobId: found.id,
          type,
          idempotencyKey: input.idempotencyKey,
        });
        return { id: found.id, deduped: true };
      }
    }

    const inserted = await tx
      .insert(jobs)
      .values({
        organizationId,
        type,
        payload: payload as Record<string, unknown>,
        priority: input.priority ?? 100,
        maxAttempts: input.maxAttempts ?? getEnv().WORKER_MAX_ATTEMPTS,
        runAfter: input.runAfter ?? new Date(),
        idempotencyKey: input.idempotencyKey ?? null,
      })
      // No conflict target: the guard is a *partial* unique index on
      // (organization_id, idempotency_key), and Postgres only matches a bare
      // DO NOTHING against partial indexes reliably. A targeted conflict clause
      // cannot infer this index.
      .onConflictDoNothing()
      .returning({ id: jobs.id, status: jobs.status, runAfter: jobs.runAfter });

    if (inserted.length === 0) {
      // Lost a race against a concurrent enqueue with the same key. The insert
      // was a no-op rather than an error, so adopt the winner's row.
      const winner = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.organizationId, organizationId),
            eq(jobs.idempotencyKey, input.idempotencyKey ?? ''),
          ),
        )
        .limit(1);

      const won = winner[0];
      if (won) {
        log.debug('enqueue.deduped_race', 'concurrent enqueue won the idempotency race', {
          jobId: won.id,
          type,
          idempotencyKey: input.idempotencyKey,
        });
        return { id: won.id, deduped: true };
      }

      // The conflicting row belongs to a different tenant and the partial index
      // says that is allowed, so reaching here means something else is wrong.
      throw new Error(
        `enqueue conflict for ${type} (key=${input.idempotencyKey}) but no existing job was found`,
      );
    }

    const row = inserted[0];
    if (!row) {
      throw new Error(`enqueue for ${type} inserted no row`);
    }
    log.info('enqueue.created', 'job queued', {
      jobId: row.id,
      type,
      organizationId,
      runAfter: row.runAfter,
    });
    return { id: row.id, deduped: false };
  });
}

export interface EnqueueManyResult {
  enqueued: number;
  deduped: number;
  ids: string[];
}

/** Bulk enqueue within one tenant transaction. */
export async function enqueueMany<T extends QueueJobType>(
  organizationId: string,
  inputs: EnqueueInput<T>[],
): Promise<EnqueueManyResult> {
  const results = await Promise.all(
    inputs.map((input) => enqueue({ ...input, organizationId })),
  );

  return {
    enqueued: results.filter((r) => !r.deduped).length,
    deduped: results.filter((r) => r.deduped).length,
    ids: results.map((r) => r.id),
  };
}

export async function cancelJob(organizationId: string, jobId: string): Promise<boolean> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .update(jobs)
      .set({ status: 'cancelled', lockedBy: null, lockedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(jobs.organizationId, organizationId),
          eq(jobs.id, jobId),
          eq(jobs.status, 'queued'),
        ),
      )
      .returning({ id: jobs.id });
    return rows.length > 0;
  });
}

export type { Job };
