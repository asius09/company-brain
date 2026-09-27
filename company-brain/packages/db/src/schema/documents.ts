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
import { idColumn, jsonb, vector, tsvector } from './columns';
import { documentStatusEnum, visibilityEnum } from './enums';
import { organization, user } from './auth';
import { sources } from './sources';

export const documentStatus = pgEnum('document_status', documentStatusEnum);
export const visibilityLevel = pgEnum('visibility', visibilityEnum);

/**
 * One logical document. `externalId` is the connector's own identifier (GitHub
 * blob sha + path, Notion page id, Slack ts, drive file id, URL, ...) and is
 * unique per (organization, source) so re-syncing is idempotent.
 *
 * ACLs live on the row as arrays rather than a join table: retrieval is a
 * single indexed scan, and a GIN index on `allowed_user_ids` keeps the
 * visibility filter cheap. A `documentAccess` table is the right move once
 * per-document grants exceed a few thousand rows.
 */
export const documents = pgTable(
  'documents',
  {
    id: idColumn(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').references(() => sources.id, { onDelete: 'cascade' }),

    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    uri: text('uri'),
    mimeType: text('mime_type'),
    contentHash: text('content_hash'),

    status: documentStatus('status').notNull().default('pending'),
    visibility: visibilityLevel('visibility').notNull().default('tenant'),

    /**
     * Who the document belongs to, inherited from the source that produced it.
     *
     * This is what makes `visibility = 'private'` mean private. Without an owner
     * the only honest reading of "private" is "nobody", so the filter would
     * otherwise have to fall back to org-wide access and the level would be
     * indistinguishable from `tenant`.
     *
     * Nullable on purpose: a source can outlive the user who added it, and a
     * document with no owner must fall back to the org-wide level rather than
     * becoming invisible to everyone, including the people who need it.
     */
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),

    /** Users explicitly granted read access (used when visibility = restricted). */
    allowedUserIds: text('allowed_user_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Roles granted read access (used when visibility = restricted). */
    allowedRoles: text('allowed_roles').array().notNull().default(sql`'{}'::text[]`),

    metadata: jsonb<DocumentMetadata>('metadata').notNull().default(sql`'{}'::jsonb`),

    byteSize: integer('byte_size'),
    tokenCount: integer('token_count'),
    chunkCount: integer('chunk_count').notNull().default(0),
    language: text('language'),

    error: text('error'),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Connector identity — makes re-syncs idempotent (upsert on conflict).
    uniqueIndex('documents_org_source_external_idx').on(
      table.organizationId,
      table.sourceId,
      table.externalId,
    ),
    index('documents_org_status_idx').on(table.organizationId, table.status),
    index('documents_org_source_idx').on(table.organizationId, table.sourceId),
    index('documents_hash_idx').on(table.organizationId, table.contentHash),
    index('documents_visibility_idx').on(table.organizationId, table.visibility),
    index('documents_allowed_users_idx').using('gin', table.allowedUserIds),
    // Every private-document read filters on owner, so the pair is indexed
    // together rather than letting the visibility index do the work alone.
    index('documents_owner_visibility_idx').on(table.organizationId, table.createdBy, table.visibility),
    index('documents_title_trgm_idx')
      .using('gin', sql`${table.title} gin_trgm_ops`),
  ],
);

export interface DocumentMetadata {
  author?: string;
  authorId?: string;
  createdAt?: string;
  updatedAt?: string;
  labels?: string[];
  pageCount?: number;
  slideCount?: number;
  language?: string;
  /** Connector-specific extras (Slack thread_ts, Drive mimeType, Git branch, ...). */
  [key: string]: unknown;
}

/**
 * An embedding-ready slice of a document.
 *
 * `searchVector` is a *generated* tsvector weighting the title highest, then the
 * heading path, then the body. It is declared in the migration (not here) as:
 *
 *   setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
 *   setweight(to_tsvector('english', coalesce(heading_path::text,'')), 'B') ||
 *   setweight(to_tsvector('english', content), 'C')
 *
 * so it can never drift out of sync with the stored text.
 */
export const chunks = pgTable(
  'chunks',
  {
    id: idColumn(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').references(() => sources.id, { onDelete: 'cascade' }),

    ordinal: integer('ordinal').notNull(),
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull(),

    /**
     * Denormalised from the parent document so the generated `search_vector`
     * can weight titles highest (weight A) without a join. Kept in sync by the
     * ingestion pipeline, never written independently.
     */
    title: text('title').notNull().default(''),
    /** Denormalised source name, used to build citation labels without a join. */
    sourceName: text('source_name'),
    /** Character offsets within the normalised document text, for highlighting. */
    charStart: integer('char_start'),
    charEnd: integer('char_end'),

    /** Breadcrumb, e.g. ["Engineering", "Onboarding", "Environments"]. */
    headingPath: text('heading_path').array().notNull().default(sql`'{}'::text[]`),
    /**
     * `headingPath` flattened to a string. `array_to_string` is only STABLE in
     * Postgres 17, so it cannot appear in a generated column — and keeping the
     * flattened form on the row also saves a conversion on every citation read.
     */
    headingText: text('heading_text').notNull().default(''),
    language: text('language'),

    embedding: vector('embedding'),
    /** Model that produced `embedding` — needed to detect a model change and re-embed. */
    embeddingModel: text('embedding_model'),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }),

    metadata: jsonb<Record<string, unknown>>('metadata').notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('chunks_document_ordinal_idx').on(table.documentId, table.ordinal),
    index('chunks_org_document_idx').on(table.organizationId, table.documentId),
    index('chunks_org_source_idx').on(table.organizationId, table.sourceId),
    index('chunks_embedding_model_idx').on(table.organizationId, table.embeddingModel),
    index('chunks_unembedded_idx')
      .on(table.organizationId)
      .where(sql`${table.embedding} IS NULL`),
  ],
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;

export { tsvector };
