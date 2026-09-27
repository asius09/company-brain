/**
 * End-to-end verification of the durable queue against a real PostgreSQL.
 *
 * The properties that matter are the ones a unit test with a mocked pool cannot
 * prove: that `FOR UPDATE SKIP LOCKED` really gives exclusive claims when
 * workers race, that stale leases are recovered, and that the RLS policy on
 * `jobs` does not break the cross-tenant claim path.
 */
import { createLogger, getEnv } from '@company-brain/core';
import { closePool, jobs, organization, user, withSystemAccess, withTenant } from '@company-brain/db';
import { eq } from 'drizzle-orm';
import {
  DelayedJobError,
  PermanentJobError,
  QueueWorker,
  claimBatch,
  completeJob,
  enqueue,
  extendLease,
  failJob,
  reclaimStaleJobs,
} from '../src/index';

const log = createLogger('queue:verify');
const RUN = String(Date.now());
let failures = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    log.info('verify.pass', label, {});
  } else {
    failures += 1;
    log.error('verify.fail', label, { detail });
  }
}

const ORG_A = `q-verify-a-${RUN}`;
const ORG_B = `q-verify-b-${RUN}`;

async function seed(): Promise<void> {
  await withSystemAccess(async (tx) => {
    await tx.insert(user).values({ id: `q-user-${RUN}`, name: 'Queue Verify', email: `q-${RUN}@example.test` });
    await tx.insert(organization).values([
      { id: ORG_A, name: 'A', slug: ORG_A },
      { id: ORG_B, name: 'B', slug: ORG_B },
    ]);
  });
}

async function cleanup(): Promise<void> {
  await withSystemAccess(async (tx) => {
    await tx.delete(organization).where(eq(organization.slug, ORG_A));
    await tx.delete(organization).where(eq(organization.slug, ORG_B));
    await tx.delete(user).where(eq(user.email, `q-${RUN}@example.test`));
  });
}

const row = (id: string) => withSystemAccess((tx) => tx.select().from(jobs).where(eq(jobs.id, id)).limit(1));

async function main(): Promise<void> {
  await seed();

  // --- enqueue + basic claim -------------------------------------------------
  const one = await enqueue({
    organizationId: ORG_A,
    type: 'source.sync',
    payload: { sourceId: 'src-1' },
  });
  check('enqueue returns an id', one.id.length > 0 && !one.deduped, one);

  const claimed = await claimBatch('w1', 5);
  check('claimBatch returns the queued job', claimed.length === 1, claimed.map((c) => c.type));
  check('claim increments attempts', claimed[0]?.attempts === 1, claimed[0]?.attempts);
  check('claim stamps the worker', claimed[0]?.lockedBy === 'w1', claimed[0]?.lockedBy);

  const second = await claimBatch('w2', 5);
  check('a claimed job is invisible to other workers', second.length === 0, second);

  // --- priority -------------------------------------------------------------
  // The guarantee is *batch composition* (the top N by priority), not the order
  // rows are processed in — Postgres does not order a sub-select that drives
  // UPDATE ... FROM.
  await enqueue({ organizationId: ORG_A, type: 'document.ingest', payload: { documentId: 'd-low', sourceId: 's1' }, priority: 900 });
  await enqueue({ organizationId: ORG_A, type: 'document.ingest', payload: { documentId: 'd-high', sourceId: 's1' }, priority: 1 });
  const composed = await claimBatch('w-order', 1);
  check('a full batch is topped up by the highest-priority job', composed[0]?.priority === 1, composed.map((o) => o.priority));
  await completeJob(composed[0]!.id, 'w-order');
  const rest = await claimBatch('w-order');
  check('the next batch takes the remaining job', rest.length === 1 && rest[0]?.priority === 900, rest.map((o) => o.priority));
  for (const job of rest) await completeJob(job.id, 'w-order');

  // --- idempotency -----------------------------------------------------------
  const key = `dup-${RUN}`;
  const a1 = await enqueue({ organizationId: ORG_A, type: 'chunk.embed', payload: { documentId: 'd1' }, idempotencyKey: key });
  const a2 = await enqueue({ organizationId: ORG_A, type: 'chunk.embed', payload: { documentId: 'd1' }, idempotencyKey: key });
  check('idempotencyKey dedupes', a1.id === a2.id && a2.deduped, { a1, a2 });
  // Different tenants must not collide on the same key.
  const b1 = await enqueue({ organizationId: ORG_B, type: 'chunk.embed', payload: { documentId: 'd1' }, idempotencyKey: key });
  check('idempotencyKey is scoped per tenant', b1.id !== a1.id, { a1, a2, b1 });
  await completeJob(a1.id, 'w1');
  await completeJob(b1.id, 'w1');

  // --- completion is guarded by lease ownership ------------------------------
  const guarded = await enqueue({ organizationId: ORG_A, type: 'document.delete', payload: { documentId: 'd9' } });
  await claimBatch('owner-w');
  const byOther = await completeJob(guarded.id, 'impostor');
  check('a non-owner cannot complete a job', byOther === false, byOther);
  const byOwner = await completeJob(guarded.id, 'owner-w');
  check('the lease owner can complete a job', byOwner === true, byOwner);
  check('completed job is marked done', (await row(guarded.id))[0]?.status === 'completed');

  // --- retry budget ----------------------------------------------------------
  const flaky = await enqueue({ organizationId: ORG_A, type: 'source.sync', payload: { sourceId: 's' }, maxAttempts: 2 });
  const flakyClaim = (await claimBatch('w-retry'))[0];
  const retried = await failJob(flakyClaim!, 'w-retry', new Error('boom'));
  check('first failure schedules a retry', retried.retrying === true, retried);
  check('retry is delayed into the future', (retried.runAfter?.getTime() ?? 0) > Date.now() - 1);

  // Not yet runnable.
  check('a delayed retry is not immediately claimable', (await claimBatch('w-retry')).length === 0);

  // Make it runnable and burn the final attempt.
  await withSystemAccess((tx) =>
    tx.update(jobs).set({ runAfter: new Date(Date.now() - 1000) }).where(eq(jobs.id, flaky.id)),
  );
  const secondAttempt = (await claimBatch('w-retry'))[0];
  check('attempts increment across retries', secondAttempt?.attempts === 2, secondAttempt?.attempts);
  const exhausted = await failJob(secondAttempt!, 'w-retry', new Error('boom again'));
  check('the job fails once the budget is spent', exhausted.retrying === false, exhausted);
  check('failed job retains the error', (await row(flaky.id))[0]?.lastError === 'boom again');

  // --- runAfter gating -------------------------------------------------------
  const future = await enqueue({
    organizationId: ORG_A,
    type: 'source.schedule',
    payload: { sourceId: 's', intervalMinutes: 5 },
    runAfter: new Date(Date.now() + 60_000),
  });
  check('a job with a future runAfter is not claimable', (await claimBatch('w-future')).length === 0);
  await withSystemAccess((tx) => tx.delete(jobs).where(eq(jobs.id, future.id)));

  // --- stale lease recovery --------------------------------------------------
  const orphan = await enqueue({ organizationId: ORG_B, type: 'document.reingest', payload: { documentId: 'd1', sourceId: 's1' } });
  await claimBatch('dead-worker');
  check('an orphaned job is locked', (await row(orphan.id))[0]?.status === 'running');
  check('a live lease is not reclaimed', (await reclaimStaleJobs()) === 0);

  // Backdate the lease past the stale window.
  const staleBefore = Date.now() - (getEnv().WORKER_STALE_LOCK_MS + 60_000);
  await withSystemAccess((tx) =>
    tx.update(jobs).set({ lockedAt: new Date(staleBefore) }).where(eq(jobs.id, orphan.id)),
  );
  check('a stale lease is reclaimed', (await reclaimStaleJobs()) >= 1);
  const reclaimed = (await row(orphan.id))[0];
  check('reclaimed job returns to queued', reclaimed?.status === 'queued', reclaimed?.status);
  check('reclaimed job releases the lock', reclaimed?.lockedBy === null, reclaimed?.lockedBy);
  check('a reclaimed job is claimable again', (await claimBatch('w-after'))[0]?.id === orphan.id);

  // --- stale lease past the attempt budget -> failed, not retried forever -----
  const doomed = await enqueue({ organizationId: ORG_B, type: 'document.ingest', payload: { documentId: 'd1', sourceId: 's1' }, maxAttempts: 1 });
  await claimBatch('dead-2');
  await withSystemAccess((tx) =>
    tx.update(jobs).set({ lockedAt: new Date(staleBefore) }).where(eq(jobs.id, doomed.id)),
  );
  await reclaimStaleJobs();
  check('a stale job with no budget left is failed, not looped', (await row(doomed.id))[0]?.status === 'failed');

  // --- heartbeat -------------------------------------------------------------
  const beat = await enqueue({ organizationId: ORG_A, type: 'document.ingest', payload: { documentId: 'd1', sourceId: 's1' } });
  await claimBatch('w-beat');
  check('a stranger cannot extend a lease', (await extendLease(beat.id, 'impostor')) === false);
  check('the owner can extend its lease', (await extendLease(beat.id, 'w-beat', 42)) === true);
  const beatRow = (await row(beat.id))[0];
  check('progress is persisted', beatRow?.progress === 42, beatRow?.progress);
  check('progress is clamped to 0-100', (await extendLease(beat.id, 'w-beat', 500)) === true);
  check('over-100 progress is clamped', (await row(beat.id))[0]?.progress === 100);
  await completeJob(beat.id, 'w-beat');

  // --- concurrency: no double delivery, no lost jobs -----------------------
  const N = 40;
  const enqueuedIds: string[] = [];
  for (let i = 0; i < N; i += 1) {
    const r = await enqueue({ organizationId: ORG_A, type: 'document.ingest', payload: { documentId: `d${i}`, sourceId: 's1' } });
    enqueuedIds.push(r.id);
  }

  // Six workers racing on the same table at once.
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => claimBatch(`racer-${i}`, 10)),
  );
  const firstWave = results.flat();
  const firstIds = firstWave.map((j) => j.id);

  check(
    'concurrent workers never double-claim a job',
    new Set(firstIds).size === firstIds.length,
    { claimed: firstIds.length, unique: new Set(firstIds).size },
  );
  check('all claims are spread across workers', new Set(firstWave.map((j) => j.lockedBy)).size > 1);
  check(
    'a racing worker claims at most its batch size',
    results.every((batch) => batch.length <= 10),
    results.map((b) => b.length),
  );

  // `SKIP LOCKED` deliberately lets a colliding worker take *fewer* rows rather
  // than block, so the first wave need not drain the table. What must hold is
  // that sweeping repeatedly yields every enqueued job exactly once, with none
  // lost and none double-delivered.
  const seen = new Set(firstIds);
  for (let sweep = 0; sweep < 20; sweep += 1) {
    const batch = await claimBatch('sweeper', 25);
    if (batch.length === 0) break;
    for (const job of batch) {
      check('a swept job was never already claimed', !seen.has(job.id), job.id);
      seen.add(job.id);
    }
  }
  check('every enqueued job is eventually claimed', seen.size === N, { claimed: seen.size, expected: N });
  check(
    'the claimed set is exactly the enqueued set',
    enqueuedIds.every((id) => seen.has(id)) && [...seen].every((id) => enqueuedIds.includes(id)),
  );
  check('no job is left queued', (await claimBatch('after-sweep', 50)).length === 0);

  // --- worker end-to-end -----------------------------------------------------
  const handled: string[] = [];
  const failing = await enqueue({ organizationId: ORG_A, type: 'document.delete', payload: { documentId: 'nope' } });
  const ok = await enqueue({ organizationId: ORG_B, type: 'chunk.embed', payload: { documentId: 'd1' } });

  const worker = new QueueWorker(
    {
      'chunk.embed': async (ctx) => {
        handled.push(ctx.job.id);
        await ctx.progress(50);
      },
      'document.delete': async () => {
        throw new PermanentJobError('not retryable');
      },
      'document.ingest': async () => undefined,
    },
    { workerId: 'verify-worker', concurrency: 2, pollIntervalMs: 25, heartbeatIntervalMs: 200 },
  );

  void worker.start();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const doneOk = (await row(ok.id))[0]?.status === 'completed';
    const doneFail = (await row(failing.id))[0]?.status === 'failed';
    if (doneOk && doneFail) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await worker.stop(2_000);

  check('worker runs a handler to completion', (await row(ok.id))[0]?.status === 'completed', (await row(ok.id))[0]?.status);
  check('worker records the handler as run', handled.includes(ok.id), handled);
  check('PermanentJobError fails without retrying', (await row(failing.id))[0]?.status === 'failed');
  check(
    'PermanentJobError keeps its message',
    (await row(failing.id))[0]?.lastError === 'not retryable',
    (await row(failing.id))[0]?.lastError,
  );
  check('a permanent failure consumes exactly one attempt', (await row(failing.id))[0]?.attempts === 1);

  // --- transient failure is retried by the worker ---------------------------
  const transient = await enqueue({ organizationId: ORG_A, type: 'source.sync', payload: { sourceId: 's1' } });
  let tries = 0;
  const worker2 = new QueueWorker(
    {
      'source.sync': async () => {
        tries += 1;
        if (tries === 1) throw new DelayedJobError('rate limited', 10);
      },
    },
    { workerId: 'verify-worker-2', concurrency: 1, pollIntervalMs: 20 },
  );
  void worker2.start();
  const deadline2 = Date.now() + 15_000;
  while (Date.now() < deadline2) {
    if ((await row(transient.id))[0]?.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await worker2.stop(2_000);
  check('a transient failure is retried until it succeeds', (await row(transient.id))[0]?.status === 'completed', {
    status: (await row(transient.id))[0]?.status,
    tries,
  });
  check('the retry actually re-ran the handler', tries === 2, tries);

  // --- unknown job type is failed, not retried forever ----------------------
  const orphanType = await enqueue({ organizationId: ORG_A, type: 'document.ingest', payload: { documentId: 'd1', sourceId: 's1' } });
  const worker3 = new QueueWorker({}, { workerId: 'verify-worker-3', concurrency: 1, pollIntervalMs: 20 });
  void worker3.start();
  const deadline3 = Date.now() + 15_000;
  while (Date.now() < deadline3) {
    if ((await row(orphanType.id))[0]?.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await worker3.stop(2_000);
  check('a job with no registered handler is failed', (await row(orphanType.id))[0]?.status === 'failed');

  // A stopped worker must not touch the queue again. A tick that is already on a
  // `claimBatch` round trip outlives the abort, so `stop()` waits for the poll
  // loop to unwind; without that, this worker -- which has no handlers at all --
  // would claim the next job and fail it as unhandled, and the concurrency checks
  // below would lose jobs to a worker that was supposed to be gone.
  const afterStop = await enqueue({ organizationId: ORG_A, type: 'document.ingest', payload: { documentId: 'after-stop' } });
  await new Promise((r) => setTimeout(r, 300));
  check(
    'a stopped worker claims nothing',
    (await row(afterStop.id))[0]?.status === 'queued',
    (await row(afterStop.id))[0]?.status,
  );

  // --- tenant scoping on enqueue -------------------------------------------
  const wrongTenant = await withTenant(ORG_B, (tx) =>
    tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.organizationId, ORG_A)).limit(1),
  );
  check('RLS hides another tenant jobs rows', wrongTenant.length === 0, wrongTenant);
}

main()
  .catch((error) => {
    failures += 1;
    log.error('verify.crashed', 'verify crashed', {}, error);
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch (error) {
      log.error('verify.cleanup_failed', 'could not remove verify rows', {}, error);
      failures += 1;
    }
    await closePool();
    log.info('verify.done', failures === 0 ? 'all checks passed' : `${failures} check(s) failed`, { failures });
    process.exit(failures === 0 ? 0 : 1);
  });
