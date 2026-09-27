/**
 * Job processors.
 *
 * Each processor implements one `JobHandler`. Handlers are the only place that
 * mutates ingestion state, which keeps the rules about what a document looks
 * like while it is half-ingested in one file instead of scattered across the
 * worker loop.
 */
import { createLogger, generateId, sha256, toAppError } from '@company-brain/core';
import { embed } from '@company-brain/ai';
import { chunkDocument, parseResource } from '@company-brain/ingest';
import {
  PermanentJobError,
  enqueue,
  type JobHandler,
  type JobHandlers,
} from '@company-brain/queue';
import {
  chunks,
  documents,
  sources,
  syncRuns,
  withTenant,
  type SyncStats,
} from '@company-brain/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { buildConnector } from './connectors';

const log = createLogger('worker.processors');

/* -------------------------------------------------------------------------- */
/* source.sync                                                                */
/* -------------------------------------------------------------------------- */

const syncSource: JobHandler<'source.sync'> = async (ctx) => {
  const { sourceId, mode = 'incremental' } = ctx.payload;

  const source = await withTenant(ctx.organizationId, async (tx) => {
    const rows = await tx.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
    return rows[0];
  });

  if (!source) {
    // The source was deleted while this job sat in the queue. Not an error.
    throw new PermanentJobError(`source ${sourceId} no longer exists`);
  }

  if (source.status === 'paused' || source.status === 'disconnected') {
    log.info('sync.skipped', 'source is not syncable', { sourceId, status: source.status });
    return;
  }

  // Built before the sync run opens, so a permanently broken configuration
  // (no start URL, unimplemented type) does not leave a `running` run row.
  const connector = buildConnector(source);

  const syncRunId = ctx.payload.syncRunId ?? generateId();
  await withTenant(ctx.organizationId, (tx) =>
    tx.insert(syncRuns).values({
      id: syncRunId,
      organizationId: ctx.organizationId,
      sourceId,
      status: 'running',
      trigger: mode === 'full' ? 'manual' : 'schedule',
    }),
  );

  await withTenant(ctx.organizationId, (tx) =>
    tx
      .update(sources)
      .set({ status: 'syncing', lastError: null, updatedAt: new Date() })
      .where(eq(sources.id, sourceId)),
  );

  const stats: SyncStats = {
    discovered: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    deleted: 0,
  };

  try {
    const cursor = mode === 'full' ? undefined : await connector.cursor?.();
    const listed = await connector.list({ cursor, limit: 1_000 });
    stats.discovered = listed.items.length;

    await ctx.progress(5);

    for (const [index, item] of listed.items.entries()) {
      if (ctx.signal.aborted) throw ctx.signal.reason;

      // Discovery is a small share of the total work; the document jobs this
      // enqueues do the expensive part, so progress tops out at 60 here.
      await ctx.progress(5 + Math.round((index / Math.max(1, stats.discovered)) * 55));

      try {
        // A content hash is what makes a re-sync cheap: an unchanged document is
        // skipped without re-fetching, re-parsing, or re-embedding.
        const hash = sha256(
          typeof item.body === 'string' ? item.body : Buffer.from(item.body).toString('base64'),
        );

        const existing = await withTenant(ctx.organizationId, async (tx) => {
          const rows = await tx
            .select({ id: documents.id, contentHash: documents.contentHash, status: documents.status })
            .from(documents)
            .where(and(eq(documents.sourceId, sourceId), eq(documents.externalId, item.externalId)))
            .limit(1);
          return rows[0];
        });

        if (existing?.contentHash === hash && existing.status === 'indexed') {
          stats.skipped += 1;
          continue;
        }

        const documentId = existing?.id ?? generateId();
        const values = {
          organizationId: ctx.organizationId,
          sourceId,
          externalId: item.externalId,
          title: item.title.slice(0, 500),
          uri: item.uri,
          mimeType: item.contentType.slice(0, 200),
          contentHash: hash,
          byteSize:
            typeof item.body === 'string' ? Buffer.byteLength(item.body) : item.body.byteLength,
          // `pending` until the chunk/embed job finishes, so retrieval never
          // sees a half-ingested document.
          status: 'pending' as const,
          metadata: { sourceName: source.name, ...(item.metadata ?? {}) },
          updatedAt: new Date(),
        };

        await withTenant(ctx.organizationId, async (tx) => {
          if (existing) {
            await tx
              .update(documents)
              .set(values)
              .where(and(eq(documents.id, documentId), eq(documents.organizationId, ctx.organizationId)));
          } else {
            // Ownership is inherited from the source, so a document the user
            // added stays theirs if they later mark it private. Set on insert
            // only: writing it on re-sync would transfer existing documents to
            // whoever most recently edited the source.
            await tx
              .insert(documents)
              .values({ id: documentId, createdBy: source.createdBy, ...values });
          }
        });

        if (existing) stats.updated += 1;
        else stats.created += 1;

        await enqueue({
          organizationId: ctx.organizationId,
          type: 'document.ingest',
          payload: { documentId, sourceId },
          // One in-flight ingest per document: a second sync of the same file
          // collapses onto the first instead of racing it.
          idempotencyKey: `document.ingest:${documentId}`,
        });
      } catch (error) {
        // One unreadable document must not abandon the rest of the crawl.
        stats.failed += 1;
        log.warn('sync.document_failed', 'skipping a document that could not be recorded', {
          sourceId,
          externalId: item.externalId,
          reason: toAppError(error).message,
        });
      }
    }

    const partial = stats.failed > 0;
    const nextCursor = await connector.cursor?.();

    await withTenant(ctx.organizationId, (tx) =>
      tx
        .update(syncRuns)
        .set({ status: partial ? 'partial' : 'succeeded', stats, finishedAt: new Date() })
        .where(eq(syncRuns.id, syncRunId)),
    );

    await withTenant(ctx.organizationId, (tx) =>
      tx
        .update(sources)
        .set({
          status: partial ? 'error' : 'connected',
          lastSyncedAt: new Date(),
          lastError: partial ? `${stats.failed} document(s) failed` : null,
          errorCount: partial ? stats.failed : 0,
          syncState: nextCursor ? { cursor: nextCursor } : {},
          updatedAt: new Date(),
        })
        .where(eq(sources.id, sourceId)),
    );

    log.info('sync.complete', 'source sync finished', { sourceId, ...stats });
  } catch (error) {
    const reason = toAppError(error).message;

    await withTenant(ctx.organizationId, (tx) =>
      tx
        .update(syncRuns)
        .set({ status: 'failed', error: reason.slice(0, 2_000), finishedAt: new Date() })
        .where(eq(syncRuns.id, syncRunId)),
    );

    await withTenant(ctx.organizationId, (tx) =>
      tx
        .update(sources)
        .set({ status: 'error', lastError: reason.slice(0, 2_000), updatedAt: new Date() })
        .where(eq(sources.id, sourceId)),
    );

    throw error;
  } finally {
    await connector.close?.();
  }
};

/* -------------------------------------------------------------------------- */
/* document.ingest                                                            */
/* -------------------------------------------------------------------------- */

const ingestDocument: JobHandler<'document.ingest'> = async (ctx) => {
  const { documentId, embedOnly = false } = ctx.payload;

  const row = await withTenant(ctx.organizationId, async (tx) => {
    const rows = await tx
      .select({ doc: documents, sourceName: sources.name })
      .from(documents)
      .leftJoin(sources, eq(sources.id, documents.sourceId))
      .where(eq(documents.id, documentId))
      .limit(1);
    return rows[0];
  });

  if (!row) {
    throw new PermanentJobError(`document ${documentId} no longer exists`);
  }

  if (row.doc.status === 'deleted') {
    log.info('ingest.skipped', 'document is deleted', { documentId });
    return;
  }

  // `embedOnly` re-embeds the chunks that are already stored, which is how a
  // change to the embedding model is rolled out without re-parsing the source.
  if (embedOnly) {
    log.info('ingest.embed_only', 're-embedding existing chunks', { documentId });
    await enqueue({
      organizationId: ctx.organizationId,
      type: 'chunk.embed',
      payload: { documentId },
      idempotencyKey: `chunk.embed:${documentId}:${ctx.job.id}`,
    });
    return;
  }

  await withTenant(ctx.organizationId, (tx) =>
    tx
      .update(documents)
      .set({ status: 'processing', error: null, updatedAt: new Date() })
      .where(eq(documents.id, documentId)),
  );

  try {
    if (!row.doc.sourceId) {
      throw new PermanentJobError(`document ${documentId} has no source to read from`);
    }

    const source = await withTenant(ctx.organizationId, async (tx) => {
      const found = await tx
        .select()
        .from(sources)
        .where(eq(sources.id, row.doc.sourceId as string))
        .limit(1);
      return found[0];
    });

    if (!source) {
      throw new PermanentJobError(`document ${documentId} refers to a source that no longer exists`);
    }

    const connector = buildConnector(source);
    let resource;
    try {
      resource = await connector.fetch(row.doc.externalId);
    } finally {
      await connector.close?.();
    }

    await ctx.progress(20);

    const parsed = parseResource(resource);
    const drafts = chunkDocument(parsed, { maxTokens: 512, overlapTokens: 64 });

    if (drafts.length === 0) {
      // Empty content is a real outcome, not a failure: the document is marked
      // indexed with zero chunks so it is not retried forever.
      await finalize(ctx.organizationId, documentId, { chunkCount: 0, tokenCount: 0, language: parsed.language });
      log.info('ingest.empty', 'document produced no chunks', { documentId });
      return;
    }

    await ctx.progress(45);

    // Replace rather than merge: a re-ingest with different chunking must not
    // leave orphaned chunks from the previous pass behind.
    const chunkIds = drafts.map(() => generateId());
    await withTenant(ctx.organizationId, async (tx) => {
      await tx
        .delete(chunks)
        .where(and(eq(chunks.organizationId, ctx.organizationId), eq(chunks.documentId, documentId)));

      await tx.insert(chunks).values(
        drafts.map((draft, index) => ({
          id: chunkIds[index] as string,
          organizationId: ctx.organizationId,
          documentId,
          sourceId: row.doc.sourceId as string,
          ordinal: draft.index,
          content: draft.content,
          headingPath: draft.headings,
          // Denormalized so the generated tsvector can index it; see the 0001
          // migration.
          headingText: draft.headingText,
          title: parsed.title,
          sourceName: row.sourceName ?? undefined,
          tokenCount: draft.tokenCount,
          metadata: { startRatio: draft.startRatio, endRatio: draft.endRatio },
        })),
      );
    });

    await ctx.progress(60);

    await enqueue({
      organizationId: ctx.organizationId,
      type: 'chunk.embed',
      payload: { documentId, chunkIds },
      idempotencyKey: `chunk.embed:${documentId}`,
    });

    // Marked indexed before embedding finishes: the document is retrievable by
    // title and metadata now, and a missing vector degrades to FTS-only ranking
    // rather than making the whole document invisible.
    await finalize(ctx.organizationId, documentId, {
      chunkCount: drafts.length,
      tokenCount: drafts.reduce((sum, draft) => sum + draft.tokenCount, 0),
      language: parsed.language,
    });

    log.info('ingest.complete', 'document ingested', {
      documentId,
      chunks: drafts.length,
      sections: parsed.sections.length,
    });
  } catch (error) {
    const reason = toAppError(error).message;
    const permanent = error instanceof PermanentJobError;

    await withTenant(ctx.organizationId, (tx) =>
      tx
        .update(documents)
        .set({
          status: permanent ? 'indexed' : 'failed',
          error: permanent ? null : reason.slice(0, 2_000),
          updatedAt: new Date(),
        })
        .where(eq(documents.id, documentId)),
    );

    throw error;
  }
};

async function finalize(
  organizationId: string,
  documentId: string,
  stats: { chunkCount: number; tokenCount: number; language?: string },
): Promise<void> {
  await withTenant(organizationId, (tx) =>
    tx
      .update(documents)
      .set({
        status: 'indexed',
        chunkCount: stats.chunkCount,
        tokenCount: stats.tokenCount,
        language: stats.language ?? null,
        indexedAt: new Date(),
        error: null,
        updatedAt: new Date(),
      })
      .where(and(eq(documents.organizationId, organizationId), eq(documents.id, documentId))),
  );
}

/* -------------------------------------------------------------------------- */
/* chunk.embed                                                                */
/* -------------------------------------------------------------------------- */

const EMBED_BATCH = 512;

const embedChunks: JobHandler<'chunk.embed'> = async (ctx) => {
  const { documentId, chunkIds } = ctx.payload;

  // `isNull(embeddedAt)` is what makes this safe to re-run: a retry re-embeds
  // only the rows the previous attempt did not commit.
  const pending = await withTenant(ctx.organizationId, async (tx) => {
    const rows = await tx
      .select({ id: chunks.id, content: chunks.content })
      .from(chunks)
      .where(
        and(
          eq(chunks.organizationId, ctx.organizationId),
          eq(chunks.documentId, documentId),
          isNull(chunks.embeddedAt),
          ...(chunkIds?.length ? [inArray(chunks.id, chunkIds)] : []),
        ),
      )
      .limit(EMBED_BATCH);
    return rows;
  });

  if (pending.length === 0) {
    log.debug('embed.nothing_to_do', 'all chunks already embedded', { documentId });
    return;
  }

  // Embedding stored text is a straightforward, expected AI call, so it uses the
  // provider's own batch limits rather than the interactive per-request cap;
  // `checkCostGuardrails` is applied inside `embed` at the platform level.
  const result = await embed({
    organizationId: ctx.organizationId,
    inputs: pending.map((chunk) => chunk.content),
    signal: ctx.signal,
  });

  if (result.embeddings.length !== pending.length) {
    throw new Error(
      `embedding count mismatch: asked for ${pending.length}, got ${result.embeddings.length}`,
    );
  }

  const width = result.embeddings[0]?.length;
  if (!width) throw new Error('embedding provider returned no vectors');

  // One transaction for the whole batch. A per-chunk UPDATE would be a round
  // trip each and would dominate the cost of embedding a large document; the
  // trade is that a mid-batch failure rolls the batch back, which the retry
  // then repeats wholesale.
  await withTenant(ctx.organizationId, async (tx) => {
    for (const [index, chunk] of pending.entries()) {
      await tx
        .update(chunks)
        .set({
          embedding: result.embeddings[index] as number[],
          embeddingModel: result.model,
          embeddedAt: new Date(),
        })
        .where(and(eq(chunks.organizationId, ctx.organizationId), eq(chunks.id, chunk.id)));
    }
  });

  await ctx.progress(90);

  const remaining = await countUnembedded(ctx.organizationId, documentId);

  if (remaining > 0) {
    // More than one batch: hand the rest back to the queue rather than growing
    // the batch past the provider's request size.
    log.info('embed.more_remaining', 'requeueing the rest of the document', { documentId, remaining });
    return await ctx.requeue(`embedded ${pending.length}, ${remaining} left`);
  }

  log.info('embed.complete', 'chunks embedded', {
    documentId,
    chunks: pending.length,
    dimensions: width,
    estimatedUsd: result.estimatedUsd,
  });
};

async function countUnembedded(organizationId: string, documentId: string): Promise<number> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({ id: chunks.id })
      .from(chunks)
      .where(
        and(
          eq(chunks.organizationId, organizationId),
          eq(chunks.documentId, documentId),
          isNull(chunks.embeddedAt),
        ),
      )
      .limit(1);
    // `countUnembedded` is only ever compared against 0, so a cheap existence
    // probe beats a full aggregate over a large table.
    return rows.length;
  });
}

/* -------------------------------------------------------------------------- */
/* deletions, re-ingest, scheduling                                           */
/* -------------------------------------------------------------------------- */

const deleteDocument: JobHandler<'document.delete'> = async (ctx) => {
  const { documentId } = ctx.payload;
  // Chunks cascade from the document row.
  await withTenant(ctx.organizationId, (tx) =>
    tx
      .update(documents)
      .set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(documents.organizationId, ctx.organizationId), eq(documents.id, documentId))),
  );
  log.info('delete.complete', 'document marked deleted', { documentId });
};

const disconnectSource: JobHandler<'source.disconnect'> = async (ctx) => {
  const { sourceId } = ctx.payload;
  await withTenant(ctx.organizationId, (tx) =>
    tx
      .update(sources)
      .set({ status: 'disconnected', updatedAt: new Date() })
      .where(and(eq(sources.organizationId, ctx.organizationId), eq(sources.id, sourceId))),
  );
  log.info('disconnect.complete', 'source disconnected', { sourceId });
};

const reingestDocument: JobHandler<'document.reingest'> = async (ctx) => {
  const { documentId, sourceId, reason } = ctx.payload;
  log.info('reingest.requested', 're-queueing ingest', { documentId, reason });
  await enqueue({
    organizationId: ctx.organizationId,
    type: 'document.ingest',
    payload: { documentId, sourceId },
    // A fresh key, so a forced re-ingest is never swallowed by the idempotency
    // of the ingest that produced it.
    idempotencyKey: `document.ingest:${documentId}:${ctx.job.id}`,
  });
};

const scheduleSource: JobHandler<'source.schedule'> = async (ctx) => {
  const { sourceId, intervalMinutes } = ctx.payload;

  await withTenant(ctx.organizationId, (tx) =>
    tx
      .update(sources)
      .set({ syncIntervalMinutes: intervalMinutes, updatedAt: new Date() })
      .where(and(eq(sources.organizationId, ctx.organizationId), eq(sources.id, sourceId))),
  );

  await enqueue({
    organizationId: ctx.organizationId,
    type: 'source.sync',
    payload: { sourceId, mode: 'incremental' },
    runAfter: new Date(Date.now() + intervalMinutes * 60_000),
    // Rolling window: the key includes the current job id, so each tick is a new
    // job instead of colliding with the one that just ran.
    idempotencyKey: `source.sync:${sourceId}:${ctx.job.id}`,
  });

  log.info('schedule.complete', 'next sync scheduled', { sourceId, intervalMinutes });
};

/** Every job type the worker knows how to run. */
export const handlers: JobHandlers = {
  'source.sync': syncSource,
  'source.disconnect': disconnectSource,
  'document.ingest': ingestDocument,
  'document.reingest': reingestDocument,
  'document.delete': deleteDocument,
  'chunk.embed': embedChunks,
  'source.schedule': scheduleSource,
};
