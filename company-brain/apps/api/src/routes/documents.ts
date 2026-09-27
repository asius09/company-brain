/**
 * Documents.
 *
 * Read-only over the document list, plus the two operator actions that matter:
 * reindex and delete. Ingestion itself happens in the worker.
 */
import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { notFound, paginated, parsePagination } from '@company-brain/core';
import { chunks, documents, withTenant } from '@company-brain/db';
import { enqueue } from '@company-brain/queue';
import { documentVisibilityFilter } from '../acl';
import { parseJson } from '../middleware';
import { requirePermission, requireSession } from '../middleware/auth';

export const documentsRoute = new Hono()
  .use('*', requireSession)
  .use('*', requirePermission('document', 'read'))
  .get('/', async (c) => {
    const actor = c.get('actor');
    const organizationId = actor.organizationId as string;
    // A null org role matches no entry in allowed_roles, which is the safe
    // reading: no role means no role-based grant.
    const { userId, role } = { userId: actor.userId, role: actor.role ?? '' };
    const page = parsePagination({ page: c.req.query('page'), limit: c.req.query('limit') });

    const filters = z
      .object({
        sourceId: z.string().min(1).optional(),
        status: z.enum(['pending', 'processing', 'indexed', 'failed', 'deleted']).optional(),
        search: z.string().min(1).max(200).optional(),
      })
      .parse({
        sourceId: c.req.query('sourceId') ?? undefined,
        status: c.req.query('status') ?? undefined,
        search: c.req.query('search') ?? undefined,
      });

    const rows = await withTenant(organizationId, async (tx) => {
      const where = and(
        eq(documents.organizationId, organizationId),
        // A soft-deleted document is invisible to the list, but its row is kept
        // for audit and so a delete can be undone.
        sql`${documents.deletedAt} is null`,
        // The same rule search applies. Titles are not harmless: a list of
        // document names is often the most revealing part of a corpus.
        documentVisibilityFilter({ organizationId, userId, role }),
        filters.sourceId ? eq(documents.sourceId, filters.sourceId) : undefined,
        filters.status ? eq(documents.status, filters.status) : undefined,
        filters.search
          ? sql`to_tsvector('english', ${documents.title}) @@ plainto_tsquery('english', ${filters.search})`
          : undefined,
      );

      const [items, total] = await Promise.all([
        tx.select().from(documents).where(where).orderBy(desc(documents.updatedAt)).limit(page.limit).offset(page.offset),
        tx.select({ value: sql<number>`count(*)::int` }).from(documents).where(where),
      ]);

      return { items, total: total[0]?.value ?? 0 };
    });

    return c.json(paginated(rows.items, rows.total, page));
  })
  .get('/:id', async (c) => {
    const actor = c.get('actor');
    const organizationId = actor.organizationId as string;
    const id = z.string().min(1).parse(c.req.param('id'));

    const document = await withTenant(organizationId, async (tx) => {
      const rows = await tx.select().from(documents).where(eq(documents.id, id)).limit(1);
      return rows[0];
    });

    if (!document) throw notFound('Document');

    const chunkRows = await withTenant(organizationId, async (tx) =>
      tx
        .select({
          id: chunks.id,
          ordinal: chunks.ordinal,
          content: chunks.content,
          headingPath: chunks.headingPath,
          tokenCount: chunks.tokenCount,
          // A document with no vector yet still renders, flagged as unembedded.
          embedded: sql<boolean>`${chunks.embeddedAt} is not null`,
        })
        .from(chunks)
        .where(eq(chunks.documentId, id))
        .orderBy(chunks.ordinal),
    );

    return c.json({ success: true, data: { ...document, chunks: chunkRows } });
  })
  /** Re-embed without re-parsing: the cheap path after a model change. */
  .post('/:id/reindex', requirePermission('document', 'reindex'), async (c) => {
    const actor = c.get('actor');
    const organizationId = actor.organizationId as string;
    const id = z.string().min(1).parse(c.req.param('id'));
    const body = z.object({ reason: z.string().max(500).optional(), embedOnly: z.boolean().default(false) })
      .parse((await parseJson(c).catch(() => ({}))) as unknown);

    const document = await withTenant(organizationId, async (tx) => {
      const rows = await tx.select().from(documents).where(eq(documents.id, id)).limit(1);
      return rows[0];
    });

    if (!document?.sourceId) throw notFound('Document');

    const job = await enqueue({
      organizationId,
      type: 'document.reingest',
      payload: { documentId: id, sourceId: document.sourceId, reason: body.reason },
      // Keyed by job-unique id, because a forced reindex must never be swallowed
      // by the idempotency of an ingest that is already queued.
      idempotencyKey: `document.reingest:${id}:${Date.now()}`,
    });

    return c.json({ success: true, data: job, message: 'Reindex queued' }, 202);
  })
  .delete('/:id', requirePermission('document', 'delete'), async (c) => {
    const actor = c.get('actor');
    const organizationId = actor.organizationId as string;
    const id = z.string().min(1).parse(c.req.param('id'));

    // A soft delete, so the document leaves retrieval immediately but remains
    // recoverable and auditable.
    const deleted = await withTenant(organizationId, async (tx) => {
      const rows = await tx
        .update(documents)
        .set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(documents.organizationId, organizationId),
            eq(documents.id, id),
            sql`${documents.deletedAt} is null`,
          ),
        )
        .returning({ id: documents.id });
      return rows.length > 0;
    });

    if (!deleted) throw notFound('Document');
    return c.json({ success: true, message: 'Document deleted' });
  });
