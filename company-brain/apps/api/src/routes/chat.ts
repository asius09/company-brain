/**
 * Grounded chat.
 *
 * The flow is retrieve -> guard -> stream -> settle:
 *
 *   1. Embed the question and run hybrid retrieval, so the answer is grounded in
 *      the tenant's own documents.
 *   2. Trim the conversation to the model's context window and check the cost
 *      guardrail *before* calling the provider, so a long thread fails cheaply.
 *   3. Stream tokens over SSE, sending citations first so the UI can render them
 *      while the answer is still arriving.
 *   4. Settle cost and usage in the same transaction that records the message.
 *
 * Cost accounting is deliberately in microdollars: `numeric` money in Postgres
 * is exact but awkward in JS, and an integer avoids float drift on the value a
 * customer is actually billed.
 */
import { Hono } from 'hono';
import type { LanguageModel, ModelMessage } from 'ai';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createLogger, generateId, notFound, toAppError } from '@company-brain/core';
import { assertWithinBudget, catalogId, settleCost, trimToContext } from '@company-brain/ai';
import { conversations, messages, usageEvents, withTenant, type StoredCitation } from '@company-brain/db';
import { parseJson } from '../middleware';
import { requirePermission, requireSession } from '../middleware/auth';
import { search, searchQuerySchema, type SearchHit } from '../search';

const log = createLogger('api.chat');

const askSchema = z.object({
  conversationId: z.string().min(1).optional(),
  message: z.string().min(1).max(20_000),
  sourceIds: z.array(z.string().min(1)).max(20).optional(),
  /** Output cap. Also feeds the pre-flight cost estimate. */
  maxOutputTokens: z.number().int().min(64).max(8_192).optional(),
  /** Per-request spend ceiling, in dollars. */
  maxCostUsd: z.number().positive().max(5).optional(),
  retrieval: z.object({ limit: z.number().int().min(1).max(20).default(8) }).default({ limit: 8 }),
});

/**
 * Maps a retrieval hit onto the stored citation shape.
 *
 * `startOffset`/`endOffset` mark the whole chunk: the prompt asks the model for
 * a source number rather than a verbatim quote, so there is no span to point at
 * yet. They exist so a later "highlight the evidence" pass has somewhere to
 * write without another migration.
 */
function toCitation(hit: SearchHit): StoredCitation {
  return {
    chunkId: hit.chunkId,
    documentId: hit.documentId,
    title: hit.title ?? 'Untitled',
    sourceType: 'chunk',
    sourceName: hit.sourceName ?? hit.title ?? 'Unknown source',
    headingPath: hit.headingPath,
    startOffset: 0,
    endOffset: hit.content.length,
    score: hit.score,
    snippet: hit.content.slice(0, 280),
  };
}

/** Builds the grounded prompt from retrieved chunks. */
function buildSystemPrompt(hits: Array<{ chunkId: string; title: string | null; headingPath: string[]; content: string }>): string {
  if (hits.length === 0) {
    return [
      'You are the company brain. No relevant documents were retrieved for this question,',
      'so say that you do not have the information rather than guessing.',
    ].join(' ');
  }

  const sources = hits
    .map((hit, index) => {
      const where = [hit.title, ...hit.headingPath].filter(Boolean).join(' > ') || 'Untitled';
      return `<source id="${index + 1}" title="${where}">\n${hit.content}\n</source>`;
    })
    .join('\n\n');

  return [
    'You are the company brain: answer strictly from the sources below.',
    '',
    'Rules:',
    '- If the sources do not contain the answer, say so plainly. Never invent facts.',
    '- Cite the source number after each claim, like [1] or [2][3].',
    '- Prefer the shortest answer that fully addresses the question.',
    '- If sources conflict, say so and name both.',
    '',
    '<sources>',
    sources,
    '</sources>',
  ].join('\n');
}

export const chatRoute = new Hono()
  .use('*', requireSession)
  .use('*', requirePermission('chat', 'read'))
  .get('/conversations', async (c) => {
    const actor = c.get('actor');
    const organizationId = actor.organizationId as string;
    const rows = await withTenant(organizationId, (tx) =>
      tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.organizationId, organizationId),
            eq(conversations.userId, actor.userId),
            sql`${conversations.archivedAt} is null`,
          ),
        )
        .orderBy(desc(conversations.updatedAt))
        .limit(50),
    );
    return c.json({ success: true, data: rows });
  })
  .get('/conversations/:id', async (c) => {
    const actor = c.get('actor');
    const organizationId = actor.organizationId as string;
    const id = z.string().min(1).parse(c.req.param('id'));

    const thread = await withTenant(organizationId, async (tx) => {
      const conversation = await tx
        .select()
        .from(conversations)
        .where(and(eq(conversations.organizationId, organizationId), eq(conversations.id, id)))
        .limit(1);
      if (!conversation[0]) return null;

      // Scoped to the asking user: a conversation is private to its author even
      // though the rows share the tenant.
      if (conversation[0].userId !== actor.userId) return null;

      const thread = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.organizationId, organizationId),
            eq(messages.conversationId, id),
          ),
        )
        .orderBy(messages.createdAt);

      return { conversation: conversation[0], messages: thread };
    });

    if (!thread) throw notFound('Conversation');
    return c.json({ success: true, data: thread });
  })
  .delete('/conversations/:id', requirePermission('chat', 'delete'), async (c) => {
    const actor = c.get('actor');
    const organizationId = actor.organizationId as string;
    const id = z.string().min(1).parse(c.req.param('id'));

    const archived = await withTenant(organizationId, (tx) =>
      tx
        .update(conversations)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(conversations.organizationId, organizationId),
            eq(conversations.id, id),
            eq(conversations.userId, actor.userId),
          ),
        )
        .returning({ id: conversations.id }),
    );

    if (archived.length === 0) throw notFound('Conversation');
    return c.json({ success: true, message: 'Conversation archived' });
  })
  /**
   * Asks the brain, streaming the answer as server-sent events.
   *
   * SSE rather than a WebSocket because the request/response is one-directional
   * and SSE reconnects on its own; the only state a client needs back is the
   * message id, which is sent in the `start` event.
   */
  .post('/ask', requirePermission('chat', 'create'), async (c) => {
    const actor = c.get('actor');
    const organizationId = actor.organizationId as string;
    const body = askSchema.parse(await parseJson(c));

    // Hoisted so the closure below keeps the narrowing; TypeScript does not carry
    // a `?.` check into an async callback.
    const existingConversationId = body.conversationId;

    const history = existingConversationId
      ? await withTenant(organizationId, (tx) =>
          tx
            .select({ role: messages.role, content: messages.content })
            .from(messages)
            .where(
              and(
                eq(messages.organizationId, organizationId),
                eq(messages.conversationId, existingConversationId),
              ),
            )
            .orderBy(desc(messages.createdAt))
            .limit(20),
        )
      : [];

    if (existingConversationId && history.length === 0) {
      throw notFound('Conversation');
    }

    // Imported lazily: the provider registry pulls in every AI SDK, which the
    // rest of the API has no reason to load.
    const { resolveProvider, resolveModel } = await import('@company-brain/ai');
    const { streamText } = await import('ai');

    const provider = await resolveProvider(organizationId, { capability: 'chat' });
    const resolved = await resolveModel({ provider, capability: 'chat' });
    const model = resolved.model;
    // Priced under the id the model was built with, so the estimate and the
    // settlement cannot disagree.
    const priceModelId = catalogId(provider.kind, resolved.id);

    const conversationId = existingConversationId ?? generateId();
    // Minted here so the `start` event can name the row before any text
    // arrives; the insert below lets the column default generate it instead.
    const assistantMessageId = generateId();

    // The user turn is recorded before the provider is called, so an aborted
    // stream still leaves the question in the thread.
    await withTenant(organizationId, async (tx) => {
      if (!existingConversationId) {
        await tx.insert(conversations).values({
          id: conversationId,
          organizationId,
          userId: actor.userId,
          title: body.message.slice(0, 120),
        });
      }
      // `messages` has no `user_id`: authorship comes from the conversation,
      // so a message cannot disagree with its thread about who asked.
      await tx.insert(messages).values({
        organizationId,
        conversationId,
        role: 'user',
        content: body.message,
      });
    });

    // Retrieval and the cost check both have to happen before the stream opens.
    const retrieval = await retrieveGrounding(organizationId, actor, body);

    // The output cap is part of the cost ceiling, so it is fixed before the
    // guardrail runs rather than left to the provider default.
    const maxOutputTokens = Math.min(body.maxOutputTokens ?? 2_048, 8_192);

    const trimmed = trimToContext(
      [
        { role: 'system', content: buildSystemPrompt(retrieval.hits) },
        ...history.reverse().map((message) => ({ role: message.role, content: message.content })),
        { role: 'user', content: body.message },
      ],
      priceModelId,
      maxOutputTokens,
    );

    assertWithinBudget({
      model: priceModelId,
      inputTokens: trimmed.inputTokens,
      requestedOutputTokens: maxOutputTokens,
      maxCostUsdPerRequest: body.maxCostUsd,
    });

    if (trimmed.droppedTurns > 0) {
      log.info('chat.trimmed', 'older turns dropped to fit the context window', {
        conversationId,
        dropped: trimmed.droppedTurns,
        inputTokens: trimmed.inputTokens,
      });
    }

    log.info('chat.ask', 'streaming an answer', {
      organizationId,
      conversationId,
      provider: provider.kind,
      model: priceModelId,
      sources: retrieval.hits.length,
      inputTokens: trimmed.inputTokens,
      maxOutputTokens,
    });

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        try {
          send('start', { conversationId, assistantMessageId });
          // Citations first: the UI can render sources while tokens stream in.
          send('sources', retrieval.hits);

          const [systemTurn, ...dialogue] = trimmed.turns;

          const result = streamText({
            model: model as LanguageModel,
            system: systemTurn?.role === 'system' ? systemTurn.content : undefined,
            messages: dialogue.map((turn) => ({
              role: turn.role as 'user' | 'assistant',
              content: turn.content,
            })) as ModelMessage[],
            maxOutputTokens,
            abortSignal: c.req.raw.signal,
          });

          let answer = '';
          for await (const part of result.textStream) {
            answer += part;
            send('token', { text: part });
          }

          const usage = await result.usage;
          const inputTokens = usage.inputTokens ?? trimmed.inputTokens;
          const outputTokens = usage.outputTokens ?? 0;
          // Cached prompt tokens are billed at a fraction of the input rate, so
          // they have to be passed through or every cached call is overcharged.
          const cachedInputTokens = usage.inputTokenDetails?.cacheReadTokens ?? undefined;
          const settled = settleCost(priceModelId, { inputTokens, outputTokens, cachedInputTokens });

          // One transaction: the answer, its cost, and the usage event either all
          // land or none do, so a billing total never drifts from the transcript.
          await withTenant(organizationId, async (tx) => {
            await tx.insert(messages).values({
              organizationId,
              conversationId,
              role: 'assistant',
              content: answer,
              citations: retrieval.hits.map(toCitation),
              provider: provider.kind,
              model: priceModelId,
              inputTokens,
              outputTokens,
              // Integer microdollars: exact, and immune to float drift.
              costUsdMicros: Math.round(settled.usd * 1_000_000),
              wasGrounded: retrieval.hits.length > 0 ? 1 : 0,
            });

            await tx.insert(usageEvents).values({
              organizationId,
              userId: actor.userId,
              provider: provider.kind,
              model: priceModelId,
              kind: 'chat',
              inputTokens,
              outputTokens,
              costUsdMicros: Math.round(settled.usd * 1_000_000),
              conversationId,
              // The message id lives in metadata rather than its own column: it
              // is only ever read by joining on the conversation, and adding a
              // nullable column plus an index for one lookup is not worth it.
              metadata: { messageId: assistantMessageId, grounded: retrieval.hits.length > 0 },
              requestId: c.get('requestId'),
            });

            await tx
              .update(conversations)
              .set({
                messageCount: sql`${conversations.messageCount} + 2`,
                lastModel: priceModelId,
                lastProvider: provider.kind,
                updatedAt: new Date(),
              })
              .where(eq(conversations.id, conversationId));
          });

          send('done', {
            messageId: assistantMessageId,
            costUsd: settled.usd,
            exact: settled.exact,
          });
        } catch (error) {
          const appError = toAppError(error);
          log.error('chat.failed', appError.message, { conversationId }, appError.cause);
          send('error', { code: appError.code, message: appError.message });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Nginx buffers SSE by default, which delays every token until the
        // response ends.
        'x-accel-buffering': 'no',
      },
    });
  });

/** Embeds the question and retrieves the grounding chunks. */
async function retrieveGrounding(
  organizationId: string,
  actor: { userId: string; role: string | null },
  body: z.infer<typeof askSchema>,
) {
  const { embed } = await import('@company-brain/ai');

  let embedding: number[] | undefined;
  try {
    const result = await embed({ organizationId, inputs: [body.message] });
    embedding = result.embeddings[0];
  } catch (error) {
    // Embeddings are an optimisation, not a prerequisite. Losing them narrows
    // the search to keywords instead of failing the question outright.
    const appError = toAppError(error);
    log.warn('chat.embedding_unavailable', 'falling back to keyword-only retrieval', {
      organizationId,
      code: appError.code,
      reason: appError.message,
    });
  }

  const query = searchQuerySchema.parse({
    query: body.message,
    limit: body.retrieval.limit,
    sourceIds: body.sourceIds,
    mode: embedding ? 'hybrid' : 'keyword',
  });

  return search(
    { organizationId, userId: actor.userId, role: actor.role ?? 'member' },
    query,
    embedding,
  );
}
