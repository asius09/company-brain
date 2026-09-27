/**
 * Search endpoint.
 *
 * Kept separate from `/api/chat` because retrieval is useful on its own: the UI's
 * "browse sources" pane calls it without generating an answer, and that costs
 * nothing.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { embed } from '@company-brain/ai';
import { toAppError, createLogger } from '@company-brain/core';
import { parseJson } from '../middleware';
import { requirePermission, requireSession } from '../middleware/auth';
import { search, searchQuerySchema } from '../search';

const log = createLogger('api.search');

export const searchRoute = new Hono()
  .use('*', requireSession)
  .use('*', requirePermission('search', 'execute'))
  .post('/', async (c) => {
    const actor = c.get('actor');
    const organizationId = actor.organizationId as string;

    // The request body is the search query itself. Reusing `searchQuerySchema`
    // rather than restating it here means the endpoint and `search()` can never
    // disagree about what a valid query is.
    const query = searchQuerySchema.parse(await parseJson(c));

    let embedding: number[] | undefined;
    if (query.mode !== 'keyword') {
      try {
        embedding = (await embed({ organizationId, inputs: [query.query] })).embeddings[0];
      } catch (error) {
        const appError = toAppError(error);
        // A provider outage must not make search unavailable; keyword search
        // still works, so say so in the response rather than failing the request.
        log.warn('search.embedding_unavailable', 'falling back to keyword-only search', {
          organizationId,
          code: appError.code,
          reason: appError.message,
        });
      }
    }

    const result = await search(
      { organizationId, userId: actor.userId, role: actor.role ?? 'member' },
      query,
      embedding,
    );

    return c.json({
      success: true,
      data: result.hits,
      // Tells the client whether the results are semantically ranked, so the UI
      // can be honest about a degraded search.
      meta: { mode: result.mode, degraded: result.mode !== query.mode, count: result.hits.length },
    });
  });
