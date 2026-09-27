/**
 * Knowledge sources.
 *
 * Sources are the ingest entry point, so every mutation here is paired with a
 * queued job: the HTTP request only records intent and returns, and the worker
 * does the slow, retryable work.
 */
import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '@company-brain/core';
import { withTenant, sources, syncRuns } from '@company-brain/db';
import { enqueue } from '@company-brain/queue';
import { paginated, parsePagination } from '@company-brain/core';
import { parseJson } from '../middleware';
import { requirePermission, requireSession } from '../middleware/auth';

export const sourcesRoute = new Hono()
  .use('*', requireSession)
  .use('*', requirePermission('source', 'read'))
  .get('/', async (c) => {
    const actor = c.get('actor');
    const page = parsePagination({ page: c.req.query('page'), limit: c.req.query('limit') });

    const rows = await withTenant(actor.organizationId as string, async (tx) => {
      const [items, total] = await Promise.all([
        tx
          .select()
          .from(sources)
          .orderBy(desc(sources.createdAt))
          .limit(page.limit)
          .offset(page.offset),
        tx.select({ value: sql<number>`count(*)::int` }).from(sources),
      ]);
      return { items, total: total[0]?.value ?? 0 };
    });

    return c.json(paginated(rows.items, rows.total, page));
  })
  .get('/:id', async (c) => {
    const actor = c.get('actor');
    const id = z.string().min(1).parse(c.req.param('id'));

    const source = await withTenant(actor.organizationId as string, async (tx) => {
      const rows = await tx.select().from(sources).where(eq(sources.id, id)).limit(1);
      return rows[0];
    });

    if (!source) throw notFound('Source');
    return c.json({ success: true, data: source });
  })
  /** Recent sync attempts, so the UI can show why a source is stuck. */
  .get('/:id/sync-runs', async (c) => {
    const actor = c.get('actor');
    const id = z.string().min(1).parse(c.req.param('id'));
    const page = parsePagination({ page: c.req.query('page'), limit: c.req.query('limit') });

    const rows = await withTenant(actor.organizationId as string, async (tx) => {
      const [items, total] = await Promise.all([
        tx
          .select()
          .from(syncRuns)
          .where(eq(syncRuns.sourceId, id))
          .orderBy(desc(syncRuns.startedAt))
          .limit(page.limit)
          .offset(page.offset),
        tx
          .select({ value: sql<number>`count(*)::int` })
          .from(syncRuns)
          .where(eq(syncRuns.sourceId, id)),
      ]);
      return { items, total: total[0]?.value ?? 0 };
    });

    return c.json(paginated(rows.items, rows.total, page));
  })
  .post('/', requirePermission('source', 'create'), async (c) => {
    const actor = c.get('actor');
    const body = z
      .object({
        name: z.string().min(1).max(200),
        type: z.enum(['website', 'url', 'github', 'notion', 'confluence', 'slack', 'gdrive', 's3', 'text', 'file']),
        description: z.string().max(2_000).optional(),
        config: z.record(z.string(), z.unknown()).default({}),
        syncIntervalMinutes: z.number().int().min(5).max(43_200).optional(),
      })
      .parse(await parseJson(c));

    // A website source with no start URL would enqueue a job that fails
    // permanently on the first sync, so reject it at the edge instead.
    if ((body.type === 'website' || body.type === 'url')) {
      const startUrls = body.config.startUrls;
      if (!Array.isArray(startUrls) || startUrls.length === 0) {
        throw badRequest('A website source needs at least one startUrls entry');
      }
      for (const candidate of startUrls) {
        if (typeof candidate !== 'string') throw badRequest('startUrls entries must be strings');
        const url = new URL(candidate);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw badRequest(`startUrls entry ${candidate} is not an http(s) URL`);
        }
      }
    }

    const source = await withTenant(actor.organizationId as string, async (tx) => {
      const nameTaken = await tx
        .select({ id: sources.id })
        .from(sources)
        .where(and(eq(sources.organizationId, actor.organizationId as string), eq(sources.name, body.name)))
        .limit(1);
      if (nameTaken[0]) throw conflict(`A source named "${body.name}" already exists`);

      const [created] = await tx
        .insert(sources)
        .values({
          organizationId: actor.organizationId as string,
          name: body.name,
          type: body.type,
          description: body.description ?? null,
          config: body.config,
          syncIntervalMinutes: body.syncIntervalMinutes ?? null,
          status: 'pending',
          createdBy: actor.userId,
        })
        .returning();

      return created!;
    });

    // First sync immediately, so a newly connected source is useful without
    // waiting for a schedule tick.
    await enqueue({
      organizationId: actor.organizationId as string,
      type: 'source.sync',
      payload: { sourceId: source.id, mode: 'full' },
      idempotencyKey: `source.sync:initial:${source.id}`,
    });

    if (body.syncIntervalMinutes) {
      await enqueue({
        organizationId: actor.organizationId as string,
        type: 'source.schedule',
        payload: { sourceId: source.id, intervalMinutes: body.syncIntervalMinutes },
        idempotencyKey: `source.schedule:${source.id}:${body.syncIntervalMinutes}`,
      });
    }

    return c.json({ success: true, data: source, message: 'Source connected' }, 201);
  })
  .post('/:id/sync', requirePermission('source', 'sync'), async (c) => {
    const actor = c.get('actor');
    const id = z.string().min(1).parse(c.req.param('id'));
    const body = z.object({ mode: z.enum(['full', 'incremental']).default('incremental') }).parse(
      (await parseJson(c).catch(() => ({}))) as unknown,
    );

    const exists = await withTenant(actor.organizationId as string, async (tx) => {
      const rows = await tx.select({ id: sources.id }).from(sources).where(eq(sources.id, id)).limit(1);
      return rows[0];
    });
    if (!exists) throw notFound('Source');

    const job = await enqueue({
      organizationId: actor.organizationId as string,
      type: 'source.sync',
      payload: { sourceId: id, mode: body.mode },
      // A manual sync supersedes a pending one instead of stacking up behind it.
      idempotencyKey: `source.sync:manual:${id}`,
    });

    return c.json({ success: true, data: job, message: 'Sync queued' }, 202);
  })
  .delete('/:id', requirePermission('source', 'delete'), async (c) => {
    const actor = c.get('actor');
    const id = z.string().min(1).parse(c.req.param('id'));

    const removed = await withTenant(actor.organizationId as string, async (tx) => {
      const deleted = await tx
        .delete(sources)
        .where(and(eq(sources.organizationId, actor.organizationId as string), eq(sources.id, id)))
        .returning({ id: sources.id });
      return deleted.length > 0;
    });

    if (!removed) throw notFound('Source');
    // Documents and chunks cascade from the source row.
    return c.json({ success: true, message: 'Source disconnected' });
  });
