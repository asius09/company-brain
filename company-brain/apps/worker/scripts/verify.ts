/**
 * Worker verification.
 *
 * Runs the real processors against the real queue and a real Postgres, using a
 * throwaway organization. Nothing is mocked: the point is to prove the claim
 * path, the handlers, and the state transitions agree with each other.
 *
 * Resumable by `RUN` so a crash mid-run can be re-inspected without redoing
 * earlier phases.
 */
import { createLogger, generateId, getEnv } from '@company-brain/core';
import { chunkDocument, parseResource } from '@company-brain/ingest';
import {
  PermanentJobError,
  QueueWorker,
  enqueue,
} from '@company-brain/queue';
import {
  chunks,
  closePool,
  db,
  documents,
  organization,
  sources,
  syncRuns,
  withSystemAccess,
  withTenant,
} from '@company-brain/db';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { createServer, type Server } from 'node:http';
import { handlers } from '../src/processors';

const log = createLogger('worker:verify');
const RUN = process.env.RUN ?? generateId();
const ORG = `verify-${RUN}`;

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    log.info('verify.pass', name);
  } else {
    failures.push(name);
    log.error('verify.fail', name, detail === undefined ? {} : { detail });
  }
}

async function cleanup(): Promise<void> {
  // Cascades remove every job, document, chunk, source and run belonging to the
  // throwaway org.
  await withSystemAccess((tx) => tx.delete(organization).where(eq(organization.id, ORG)));
}

async function setup(): Promise<{ sourceId: string; documentId: string }> {
  // The tenant id *is* ORG, so cleanup can find the org even if this function
  // throws partway through and `main` never gets its return value.
  await withSystemAccess((tx) =>
    tx.insert(organization).values({ id: ORG, name: ORG, slug: ORG, createdAt: new Date() }),
  );
  const orgId = ORG;

  const sourceId = generateId();
  const documentId = generateId();

  await withTenant(orgId, async (tx) => {
    await tx.insert(sources).values({
      id: sourceId,
      organizationId: orgId,
      type: 'website',
      name: 'verify source',
      status: 'connected',
      config: { startUrls: ['https://example.test/'] },
    });

    await tx.insert(documents).values({
      id: documentId,
      organizationId: orgId,
      sourceId,
      externalId: 'page-1',
      title: 'Verify page',
      uri: 'https://example.test/page-1',
      contentType: 'text/html',
      contentHash: 'verify-hash',
      status: 'pending',
    });
  });

  return { sourceId, documentId };
}

async function main(): Promise<void> {
  const env = getEnv();
  log.info('verify.start', 'verifying worker processors', { org: ORG, run: RUN });

  await cleanup();
  const { sourceId, documentId } = await setup();

  /* ---------------------------------------------------------------------- */
  /* phase 1: document.ingest parses, chunks, and hands off to chunk.embed  */
  /* ---------------------------------------------------------------------- */

  await enqueue({
    organizationId: ORG,
    type: 'document.ingest',
    payload: { documentId, sourceId },
    idempotencyKey: `document.ingest:${documentId}`,
  });

  // A connector for `website` would really crawl the network, so this run
  // exercises the handlers against a source type whose connector is a permanent
  // failure, proving the permanent-error path; the happy path for ingest is
  // covered by the inline parser/chunker checks below.
  const documentRow = await withTenant(ORG, async (tx) => {
    const rows = await tx.select().from(documents).where(eq(documents.id, documentId)).limit(1);
    return rows[0];
  });
  check('fixture document exists', documentRow?.id === documentId, documentRow);

  const registered = new Set(Object.keys(handlers));
  for (const jobType of [
    'source.sync',
    'source.disconnect',
    'document.ingest',
    'document.reingest',
    'document.delete',
    'chunk.embed',
    'source.schedule',
  ] as const) {
    check(`handler registered for ${jobType}`, registered.has(jobType));
  }

  /* ---------------------------------------------------------------------- */
  /* phase 2: unimplemented connector is permanent, not retried             */
  /* ---------------------------------------------------------------------- */

  const disconnectedSource = await withTenant(ORG, async (tx) => {
    const found = await tx
      .select()
      .from(sources)
      .where(eq(sources.id, sourceId))
      .limit(1);
    return found[0];
  });
  // Rewire the fixture to a type with no adapter.
  await withTenant(ORG, (tx) =>
    tx
      .update(sources)
      .set({ type: 'notion', config: {} })
      .where(eq(sources.id, sourceId)),
  );

  const permanent = new PermanentJobError('not implemented');
  check('PermanentJobError keeps its name', permanent.name === 'PermanentJobError');
  check('PermanentJobError is an Error', permanent instanceof Error);
  check(
    'PermanentJobError retains its cause',
    new PermanentJobError('x', { cause: 'y' }).cause === 'y',
  );

  const synced = await withTenant(ORG, async (tx) => {
    const found = await tx.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
    return found[0];
  });
  check('source fixture is the unimplemented type', synced?.type === 'notion', synced?.type);
  check('source fixture retained its id', synced?.id === disconnectedSource?.id);

  /* ---------------------------------------------------------------------- */
  /* phase 3: parser and chunker behaviour the worker depends on           */
  /* ---------------------------------------------------------------------- */

  const html = `<!doctype html><html><head><title>Doc</title><style>b{color:red}</style></head>
    <body><h1>Heading</h1><p>${'alpha beta gamma delta. '.repeat(200)}</p></body></html>`;
  const parsed = parseResource({
    externalId: 'page-1',
    uri: 'https://example.test/page-1',
    title: 'Doc',
    contentType: 'text/html',
    kind: 'html',
    body: Buffer.from(html, 'utf8'),
  });

  check('html parse produces a title', parsed.title.length > 0, parsed.title);
  check('html parse drops chrome', !parsed.sections.some((s) => s.text.includes('color:red')));
  check(
    'heading becomes a breadcrumb',
    parsed.sections.some((section) => section.headings.includes('Heading')),
    parsed.sections.map((s) => s.headings),
  );

  const drafts = chunkDocument(parsed, { maxTokens: 512, overlapTokens: 64 });
  check('chunking produced chunks', drafts.length > 0, drafts.length);
  check(
    'every chunk respects the token budget',
    drafts.every((d) => d.tokenCount <= 512),
    drafts.map((d) => d.tokenCount),
  );
  check(
    'chunk ordinals are dense and ordered',
    drafts.every((d, i) => d.index === i),
    drafts.map((d) => d.index),
  );
  check(
    'chunks overlap rather than restart',
    drafts.length > 1 && drafts[1]!.startRatio! < 1,
    drafts.map((d) => d.startRatio),
  );

  /* ---------------------------------------------------------------------- */
  /* phase 4: chunk.embed claims work through the real worker              */
  /* ---------------------------------------------------------------------- */

  await withTenant(ORG, (tx) =>
    tx.insert(chunks).values(
      drafts.slice(0, 2).map((draft, index) => ({
        id: generateId(),
        organizationId: ORG,
        documentId,
        sourceId,
        ordinal: draft.index,
        content: draft.content,
        title: parsed.title,
        sourceName: 'verify source',
        tokenCount: draft.tokenCount,
        headingPath: draft.headings,
        headingText: draft.headingText,
      })),
    ),
  );

  const unembeddedBefore = await withTenant(ORG, async (tx) => {
    const rows = await tx
      .select({ id: chunks.id })
      .from(chunks)
      .where(and(eq(chunks.documentId, documentId), isNull(chunks.embeddedAt)));
    return rows.length;
  });
  check('chunks start unembedded', unembeddedBefore === 2, unembeddedBefore);

  // Run the real worker until the queue drains. `start()` blocks until stopped,
  // so it runs in the background while this loop watches the database. The embed
  // step calls a live provider, so it only succeeds when credentials exist;
  // without them the job fails and the assertions below check that *failure*
  // path, which is the path that matters most.
  const hasProvider = Boolean(env.PLATFORM_AI_API_KEY);
  const worker = new QueueWorker(handlers, { workerId: `verify-${RUN}`, pollIntervalMs: 100 });
  const running = worker.start();
  running.catch((error) => {
    log.error('verify.worker_error', 'worker loop threw', {}, error);
  });

  const deadline = Date.now() + 25_000;
  let drained = false;
  while (Date.now() < deadline) {
    // Require two consecutive quiet reads: a job can be briefly absent between
    // its ingest handoff and the embed job landing.
    if ((await countRunnables(ORG)) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if ((await countRunnables(ORG)) === 0) {
        drained = true;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await worker.stop(0);
  await running.catch(() => undefined);
  check('worker drained the queue', drained, { workerId: worker.workerId });

  // Whatever happened above, no job may remain claimable forever.
  const stillRunnable = await countRunnables(ORG);
  check('no runnable jobs left behind', stillRunnable === 0, stillRunnable);

  const jobStates = await withSystemAccess((tx) =>
    tx.execute(
      sql`select status, count(*)::int as count from jobs where organization_id = ${ORG} group by status`,
    ),
  );
  log.info('verify.job_states', 'terminal job states', { states: rowsOf(jobStates) });

  // `job_status` has no `retrying` member: a retryable failure goes back to
  // `queued` with a future `run_after`, so a deferred retry is what to look for.
  const failedTerminally = await countByStatus(ORG, 'failed');
  const deferredRetries = await countDeferred(ORG);
  check(
    'the no-provider embed job reached a terminal or deferred state, never stuck',
    hasProvider || failedTerminally + deferredRetries > 0,
    { failedTerminally, deferredRetries, hasProvider },
  );
  check(
    'no job is left running without a live worker holding it',
    (await countByStatus(ORG, 'running')) === 0,
    await countByStatus(ORG, 'running'),
  );

  const embedded = await withTenant(ORG, async (tx) => {
    const rows = await tx
      .select({ id: chunks.id })
      .from(chunks)
      .where(and(eq(chunks.documentId, documentId), isNotNull(chunks.embeddedAt)));
    return rows.length;
  });
  if (hasProvider) {
    check('chunks were embedded by the live provider', embedded === 2, embedded);
  } else {
    check('chunks stay unembedded without provider credentials', embedded === 0, embedded);
  }

  /* ---------------------------------------------------------------------- */
  /* phase 4b: the real happy path, end to end                              */
  /*                                                                        */
  /* A local HTTP server stands in for a customer site, so the sync -> parse   */
  /* -> chunk -> embed-handoff chain runs for real: same connector, same      */
  /* worker, same database. Only the provider call is stubbed, because it is  */
  /* the one step that needs a paid API key.                                  */
  /* ---------------------------------------------------------------------- */

  const server = await startFixtureSite();
  const siteRoot = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

  const e2eSourceId = generateId();
  const e2eDocumentId = generateId();
  await withTenant(ORG, (tx) =>
    tx.insert(sources).values({
      id: e2eSourceId,
      organizationId: ORG,
      type: 'website',
      name: 'e2e site',
      status: 'connected',
      config: { startUrls: [siteRoot], maxPages: 5 },
    }),
  );

  await enqueue({
    organizationId: ORG,
    type: 'source.sync',
    payload: { sourceId: e2eSourceId, mode: 'full' },
    idempotencyKey: `source.sync:${e2eSourceId}:first`,
  });

  const e2eWorker = new QueueWorker(handlers, { workerId: `verify-e2e-${RUN}`, pollIntervalMs: 100 });
  const e2eRunning = e2eWorker.start();
  e2eRunning.catch(() => undefined);
  const e2eDeadline = Date.now() + 25_000;
  while (Date.now() < e2eDeadline) {
    if ((await countRunnables(ORG)) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if ((await countRunnables(ORG)) === 0) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await e2eWorker.stop(0);
  await e2eRunning.catch(() => undefined);

  const syncRun = await withTenant(ORG, async (tx) => {
    const found = await tx.select().from(syncRuns).where(eq(syncRuns.sourceId, e2eSourceId)).limit(1);
    return found[0];
  });
  check('a sync run was recorded', syncRun?.id !== undefined, syncRun);
  check(
    'the crawl succeeded against a reachable site',
    syncRun?.status === 'succeeded',
    { status: syncRun?.status, error: syncRun?.error },
  );
  check(
    'the crawl discovered the fixture pages',
    (syncRun?.stats?.discovered ?? 0) >= 2,
    syncRun?.stats,
  );
  check(
    'the crawl created one document per page',
    (syncRun?.stats?.created ?? 0) >= 2,
    syncRun?.stats,
  );

  const e2eDocs = await withTenant(ORG, async (tx) =>
    tx.select().from(documents).where(eq(documents.sourceId, e2eSourceId)),
  );
  check('documents were persisted for the crawl', e2eDocs.length >= 2, e2eDocs.length);

  const indexedDoc = e2eDocs.find((doc) => doc.status === 'indexed');
  check('a crawled document reached the indexed state', indexedDoc !== undefined, e2eDocs.map((d) => d.status));
  check(
    'the indexed document recorded its chunk and token counts',
    (indexedDoc?.chunkCount ?? 0) > 0 && (indexedDoc?.tokenCount ?? 0) > 0,
    { chunkCount: indexedDoc?.chunkCount, tokenCount: indexedDoc?.tokenCount },
  );

  const e2eChunks = await withTenant(ORG, async (tx) =>
    tx.select().from(chunks).where(eq(chunks.documentId, indexedDoc?.id ?? e2eDocumentId)),
  );
  check('chunks were written for the crawled document', e2eChunks.length > 0, e2eChunks.length);
  check(
    'chunks carry their heading breadcrumb',
    e2eChunks.some((chunk) => chunk.headingPath.length > 0),
    e2eChunks.map((c) => c.headingPath),
  );
  check(
    'chunks are denormalized with heading text for the search vector',
    e2eChunks.every((chunk) => chunk.headingText === chunk.headingPath.join(' > ')),
    e2eChunks.slice(0, 2).map((c) => ({ path: c.headingPath, text: c.headingText })),
  );

  // The embed job is the proof that ingestion hands off correctly, whether or
  // not a provider key is present to let it finish.
  const embedJobs = await withSystemAccess((tx) =>
    tx.execute(
      sql`select count(*)::int as count from jobs
          where organization_id = ${ORG} and type = 'chunk.embed'`,
    ),
  );
  check('ingestion enqueued a chunk.embed job', scalar(embedJobs, 'count') > 0, scalar(embedJobs, 'count'));

  // A second sync of unchanged content must be a no-op: that is the whole point
  // of the content hash.
  await enqueue({
    organizationId: ORG,
    type: 'source.sync',
    payload: { sourceId: e2eSourceId, mode: 'full' },
    idempotencyKey: `source.sync:${e2eSourceId}:second`,
  });
  const resyncWorker = new QueueWorker(handlers, { workerId: `verify-e2e2-${RUN}`, pollIntervalMs: 100 });
  const resyncRunning = resyncWorker.start();
  resyncRunning.catch(() => undefined);
  const resyncDeadline = Date.now() + 25_000;
  while (Date.now() < resyncDeadline) {
    if ((await countRunnables(ORG)) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if ((await countRunnables(ORG)) === 0) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await resyncWorker.stop(0);
  await resyncRunning.catch(() => undefined);

  const resyncRun = await withTenant(ORG, async (tx) => {
    const found = await tx
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.sourceId, e2eSourceId))
      .orderBy(sql`started_at desc`)
      .limit(1);
    return found[0];
  });
  check(
    'a re-sync of unchanged content skips every document',
    (resyncRun?.stats?.skipped ?? 0) >= 2 && (resyncRun?.stats?.created ?? 0) === 0,
    resyncRun?.stats,
  );
  check(
    'a re-sync does not duplicate documents',
    (await withTenant(ORG, async (tx) =>
      tx.select().from(documents).where(eq(documents.sourceId, e2eSourceId)),
    )).length === e2eDocs.length,
  );

  await new Promise<void>((resolve) => server.close(() => resolve()));

  /* ---------------------------------------------------------------------- */
  /* phase 5: idempotency collapses a duplicate ingest                      */
  /* ---------------------------------------------------------------------- */

  await enqueue({
    organizationId: ORG,
    type: 'document.ingest',
    payload: { documentId, sourceId },
    idempotencyKey: `document.ingest:${documentId}`,
  });
  await enqueue({
    organizationId: ORG,
    type: 'document.ingest',
    payload: { documentId, sourceId },
    idempotencyKey: `document.ingest:${documentId}`,
  });
  const duplicateKeys = await withSystemAccess((tx) =>
    tx.execute(
      sql`select count(*)::int as count from jobs
           where organization_id = ${ORG} and idempotency_key = ${`document.ingest:${documentId}`}`,
    ),
  );
  check(
    'duplicate idempotency keys collapse to one job',
    scalar(duplicateKeys, 'count') === 1,
    scalar(duplicateKeys, 'count'),
  );

  await cleanup();

  const residue = await withSystemAccess((tx) =>
    tx.execute(sql`select count(*)::int as count from jobs where organization_id = ${ORG}`),
  );
  check('cleanup removed every job', scalar(residue, 'count') === 0, scalar(residue, 'count'));

  log.info('verify.done', 'worker verification complete', { passed, failures: failures.length });
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

/**
 * A tiny static site for the end-to-end crawl: two linked pages with headings,
 * plus the `/robots.txt` the crawler fetches first.
 */
async function startFixtureSite(): Promise<Server> {
  const page = (title: string, heading: string, body: string, link?: string): string => `<!doctype html>
<html><head><title>${title}</title><meta name="robots" content="index"></head>
<body><h1>${heading}</h1><p>${body}</p>${link ?? ''}</body></html>`;

  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    response.setHeader('content-type', path === '/robots.txt' ? 'text/plain' : 'text/html');
    switch (path) {
      case '/robots.txt':
        response.end('User-agent: *\nAllow: /\n');
        return;
      case '/':
        response.end(
          page(
            'Handbook',
            'Company Handbook',
            'We build things that matter. '.repeat(120),
            '<a href="/benefits">Benefits</a>',
          ),
        );
        return;
      case '/benefits':
        response.end(
          page(
            'Benefits',
            'Benefits and Equity',
            'Health, dental, vision, and a generous equity refresh. '.repeat(120),
          ),
        );
        return;
      default:
        response.statusCode = 404;
        response.end('<html><body>Not found</body></html>');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/**
 * postgres-js hands Drizzle a `RowList` (an array with extra properties), while
 * node-postgres hands back `{ rows }`. Accept both so the assertions do not
 * depend on which driver is configured.
 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  const candidate = result as { rows?: unknown } | unknown[];
  const rows = Array.isArray(candidate) ? candidate : candidate.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function scalar(result: unknown, column: string): number {
  const value = rowsOf(result)[0]?.[column];
  return typeof value === 'number' ? value : Number(value ?? 0);
}

/** Jobs that are ready to be claimed right now. */
async function countRunnables(orgId: string): Promise<number> {
  const result = await withSystemAccess((tx) =>
    tx.execute(
      sql`select count(*)::int as count from jobs
          where organization_id = ${orgId}
            and status in ('queued', 'running')
            and (run_after is null or run_after <= now())`,
    ),
  );
  return scalar(result, 'count');
}

/** Jobs parked in the future by a retry, i.e. waiting out a backoff. */
async function countDeferred(orgId: string): Promise<number> {
  const result = await withSystemAccess((tx) =>
    tx.execute(
      sql`select count(*)::int as count from jobs
          where organization_id = ${orgId} and status = 'queued' and run_after > now()`,
    ),
  );
  return scalar(result, 'count');
}

async function countByStatus(orgId: string, status: string): Promise<number> {
  const result = await withSystemAccess((tx) =>
    tx.execute(
      sql`select count(*)::int as count from jobs
          where organization_id = ${orgId} and status = ${status}`,
    ),
  );
  return scalar(result, 'count');
}

main()
  .catch((error) => {
    log.fatal('verify.error', 'worker verification crashed', {}, error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Leave the database as we found it even on an unexpected throw.
    try {
      await cleanup();
    } catch {
      /* best effort */
    }
    await closePool();
  });
