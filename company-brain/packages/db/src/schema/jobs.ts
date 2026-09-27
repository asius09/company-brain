import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { idColumn, jsonb } from './columns';
import { jobStatusEnum, jobTypeEnum } from './enums';
import { organization } from './auth';

export const jobStatus = pgEnum('job_status', jobStatusEnum);
export const jobType = pgEnum('job_type', jobTypeEnum);

/**
 * The durable work queue.
 *
 * Workers claim rows with `FOR UPDATE SKIP LOCKED`, so N workers can poll the
 * same table without coordination. Progress lives in Postgres, which means jobs
 * survive a deploy, and a crashed worker's rows are reclaimed once
 * `locked_at` passes `WORKER_STALE_LOCK_MS`.
 *
 * The hot claim query is served by `jobs_claim_idx`, a partial index over
 * exactly the rows that are claimable.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: idColumn(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),

    type: jobType('type').notNull(),
    payload: jsonb<Record<string, unknown>>('payload').notNull().default(sql`'{}'::jsonb`),

    status: jobStatus('status').notNull().default('queued'),
    /** Higher runs first. */
    priority: integer('priority').notNull().default(100),

    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),

    /** Earliest time this job may be claimed; used for backoff. */
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),

    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),

    lastError: text('last_error'),
    progress: integer('progress'),

    /**
     * De-dupes equivalent work. Re-syncing the same source while a sync is
     * already queued collapses into the existing job instead of piling up.
     *
     * Scoped to the tenant: the key is a caller-supplied natural key, and a
     * global unique index would let one tenant's key block another's enqueue.
     */
    idempotencyKey: text('idempotency_key'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('jobs_idempotency_idx')
      .on(table.organizationId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    // Partial: only queued rows take space in the index.
    index('jobs_claim_idx')
      .on(table.priority, table.runAfter, table.createdAt)
      .where(sql`${table.status} = 'queued'`),
    index('jobs_org_status_idx').on(table.organizationId, table.status),
    index('jobs_org_created_idx').on(table.organizationId, table.createdAt),
    index('jobs_locked_idx')
      .on(table.lockedAt)
      .where(sql`${table.status} = 'running'`),
  ],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
