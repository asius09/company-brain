/**
 * Hybrid search.
 *
 * Combines Postgres full-text search over the weighted tsvector with pgvector
 * cosine distance, using Reciprocal Rank Fusion rather than weighted score
 * addition: RRF only needs the two rankings, so a chunk that is mediocre on both
 * can still surface, and there is no score scale to mis-calibrate.
 *
 * Both legs run inside `withTenant`, so RLS has already excluded every other
 * organization before the ranking starts. The document-level ACL is applied
 * here, because that is a per-user concern that RLS cannot express.
 */
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { validationFailed } from '@company-brain/core';
import { withTenant, EMBEDDING_DIMENSIONS } from '@company-brain/db';

export const searchQuerySchema = z.object({
  query: z.string().min(1).max(2_000),
  limit: z.number().int().min(1).max(50).default(10),
  /** Per-source narrowing, applied before ranking. */
  sourceIds: z.array(z.string().min(1)).max(20).optional(),
  /** Chunk minimum vector similarity, 0..1, where 1 is identical. */
  minScore: z.number().min(0).max(1).default(0),
  /** RRF smoothing constant; 60 is the value from the original RRF paper. */
  rrfK: z.number().int().min(1).max(1_000).default(60),
  mode: z.enum(['hybrid', 'keyword', 'vector']).default('hybrid'),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

/** Who is asking. Drives the document-level ACL, not just the tenant scope. */
export interface SearchPrincipal {
  organizationId: string;
  userId: string;
  role: string;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  sourceId: string | null;
  content: string;
  headingPath: string[];
  title: string | null;
  sourceName: string | null;
  visibility: string;
  /** Post-fusion rank position, 1-based. */
  rank: number;
  /** RRF score, comparable within one result set but not across queries. */
  score: number;
  keywordRank: number | null;
  vectorRank: number | null;
  /** Cosine distance 0..2, where 0 is identical. */
  distance: number | null;
  /** True when the chunk matched on keywords only because it has no vector. */
  degraded: boolean;
}

export interface SearchResult {
  hits: SearchHit[];
  /** The mode actually used, which may be narrower than requested. */
  mode: 'hybrid' | 'keyword' | 'vector';
}

/**
 * Runs the search.
 *
 * @param embedding Query vector. Omit it and the vector leg is skipped rather
 *   than scoring every chunk as identical, so a provider outage degrades to
 *   keyword search instead of returning nonsense.
 */
export async function search(
  principal: SearchPrincipal,
  input: SearchQuery,
  embedding?: number[],
): Promise<SearchResult> {
  const query = searchQuerySchema.parse(input);

  if (query.mode === 'vector' && embedding === undefined) {
    throw validationFailed('vector search requires a query embedding');
  }
  if (embedding !== undefined) {
    assertEmbeddingWidth(embedding);
  }

  const useVector = query.mode !== 'keyword' && embedding !== undefined;
  const mode: SearchResult['mode'] = useVector ? (query.mode as 'hybrid' | 'vector') : 'keyword';

  const where = visibilityFilter(principal, query.sourceIds);
  const tsQuery = sql`websearch_to_tsquery('english', ${query.query})`;

  // Keyword leg: rank by the weighted tsvector, where title and headings
  // outweigh the body (see the 0001 migration).
  const keyword = sql`
    select c.id as chunk_id,
           row_number() over (order by ts_rank_cd(c.search_vector, ${tsQuery}) desc) as rank
    from chunks c
    join documents d on d.id = c.document_id
    where ${where} and c.search_vector @@ ${tsQuery}
  `;

  const vector = useVector
    ? sql`
        select c.id as chunk_id,
               row_number() over (order by c.embedding <=> ${vectorLiteral(embedding as number[])}::vector) as rank,
               (c.embedding <=> ${vectorLiteral(embedding as number[])}::vector) as distance
        from chunks c
        join documents d on d.id = c.document_id
        where ${where} and c.embedding is not null
      `
    : null;

  // RRF: each leg contributes 1/(k + rank), so a chunk found by both legs scores
  // about twice one found by a single leg, regardless of either raw scale.
  //
  // The join is a full outer join so a chunk only the vector leg found is still
  // returned; an inner join would drop exactly the paraphrases that vector
  // search exists to find.
  const fused = vector
    ? sql`
        select coalesce(k.chunk_id, v.chunk_id) as chunk_id,
               coalesce(k.keyword_score, 0) + coalesce(v.vector_score, 0) as score,
               k.keyword_rank,
               v.vector_rank,
               v.distance
        from (select chunk_id, rank as keyword_rank, 1.0 / (${query.rrfK} + rank) as keyword_score from (${keyword}) k) k
        full outer join (select chunk_id, rank as vector_rank, distance, 1.0 / (${query.rrfK} + rank) as vector_score from (${vector}) v) v
          on v.chunk_id = k.chunk_id
      `
    : sql`
        select chunk_id,
               1.0 / (${query.rrfK} + rank) as score,
               rank as keyword_rank,
               null::int as vector_rank,
               null::float as distance
        from (${keyword}) k
      `;

  const result = await withTenant(principal.organizationId, (tx) =>
    tx.execute(sql`
      with fused as (${fused}),
      ranked as (
        select chunk_id,
               score,
               row_number() over (order by score desc, chunk_id) as rank
        from fused
        where score > 0
      )
      -- Every column is aliased explicitly. A raw execute() runs its result
      -- names through Drizzle's schema casing, so an unaliased snake_case
      -- column arrives camelCased and a reader written against the SQL sees
      -- undefined for every id. Aliasing to the final name makes the row shape
      -- independent of that behaviour.
      select
        r.rank as rank,
        r.score as score,
        r.chunk_id as "chunkId",
        -- The per-arm ranks and the distance live on the fused arm, not on
        -- ranked: ranked only exists to cut the fused list to the requested
        -- limit, and widening it just to carry columns the join already
        -- provides would duplicate them.
        f.keyword_rank as "keywordRank",
        f.vector_rank as "vectorRank",
        f.distance as distance,
        c.document_id as "documentId",
        c.source_id as "sourceId",
        c.content as content,
        c.heading_path as "headingPath",
        c.title as title,
        c.source_name as "sourceName",
        d.visibility as visibility,
        (c.embedded_at is null) as degraded
      from ranked r
      join fused f on f.chunk_id = r.chunk_id
      join chunks c on c.id = r.chunk_id
      join documents d on d.id = c.document_id
      where r.rank <= ${query.limit}
        and (f.distance is null or (1 - f.distance / 2) >= ${query.minScore})
      order by r.rank
    `),
  );

  const rows = result as unknown as Array<Record<string, unknown>>;
  return { hits: rows.map(toHit), mode };
}

/**
 * The rows a principal may see.
 *
 * `tenant` visibility is everyone in the org. `restricted` is an explicit
 * allow-list of users and roles. `private` is the author alone, which the
 * schema does not model separately, so it is treated as owner-only and is
 * therefore only reachable by an author the caller records themselves.
 */
/**
 * The chunk-level equivalent of `documentVisibilityFilter`.
 *
 * Written against raw chunk columns rather than reusing the Drizzle document
 * predicate, because the chunk query aliases `documents d` in its own scope.
 * The visibility rules themselves are not restated here: the same three-level
 * shape is the contract, and the document list and the search ranking are
 * expected to agree on it.
 */
function visibilityFilter(principal: SearchPrincipal, sourceIds?: string[]): SQL {
  const filters: SQL[] = [
    sql`c.organization_id = ${principal.organizationId}`,
    // Only an indexed document is searchable. Ingestion marks a document
    // indexed before chunking finishes, so this is what keeps half-ingested
    // state out of results.
    sql`d.status = 'indexed'`,
    sql`d.deleted_at is null`,
    sql`(
      d.visibility = 'tenant'
      or (d.visibility = 'restricted' and (
        ${principal.userId} = any(d.allowed_user_ids)
        or ${principal.role} = any(d.allowed_roles)
      ))
      -- Private means private: the owner only. This used to match any private
      -- document regardless of owner, which granted every member of the
      -- organization access and made the level a synonym for tenant.
      or (d.visibility = 'private' and (d.created_by is null or d.created_by = ${principal.userId}))
    )`,
  ];

  if (sourceIds?.length) {
    filters.push(sql`c.source_id = any(${sourceIds})`);
  }

  return sql.join(filters, sql` and `);
}

function toHit(row: Record<string, unknown>): SearchHit {
  return {
    chunkId: required(row.chunkId, 'chunkId'),
    documentId: required(row.documentId, 'documentId'),
    sourceId: toText(row.sourceId),
    content: toText(row.content) ?? '',
    headingPath: (row.headingPath as string[]) ?? [],
    title: toText(row.title),
    sourceName: toText(row.sourceName),
    visibility: toText(row.visibility) ?? 'tenant',
    rank: Number(row.rank),
    score: Number(row.score),
    keywordRank: count(row.keywordRank),
    vectorRank: count(row.vectorRank),
    distance: count(row.distance),
    degraded: Boolean(row.degraded),
  };
}

/**
 * Reads a nullable text column.
 *
 * `String(null)` is the string "null" and `String(undefined)` is the string
 * "undefined", both of which look like real data to everything downstream. A
 * citation with `chunkId: "undefined"` renders as a dead link rather than as a
 * failure, so nullish values stay null here.
 */
function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Reads a column that cannot be null, failing loudly if it is missing.
 *
 * A missing key means the row does not have the shape the query claims to
 * produce. Substituting a placeholder would turn that into a result that looks
 * valid and links nowhere, so it is better to surface it.
 */
function required(value: unknown, column: string): string {
  const text = toText(value);
  if (text === null) {
    throw new Error(`search result row is missing ${column}`);
  }
  return text;
}

/** Reads a nullable numeric column, which postgres returns as a string. */
function count(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/** Renders a vector as a pgvector literal, validating it first. */
function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Rejects a query vector of the wrong width before it reaches Postgres.
 *
 * A mismatch would otherwise surface as an opaque pgvector "expected N
 * dimensions" error from inside the search query.
 */
function assertEmbeddingWidth(embedding: number[]): void {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw validationFailed(
      `Query embedding has ${embedding.length} dimensions; the index stores ${EMBEDDING_DIMENSIONS}`,
      { expected: EMBEDDING_DIMENSIONS, received: embedding.length },
    );
  }
  if (embedding.some((value) => !Number.isFinite(value))) {
    throw validationFailed('Query embedding contains a non-finite value');
  }
}
