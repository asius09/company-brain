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
import { sourceStatusEnum, sourceTypeEnum, syncRunStatusEnum } from './enums';
import { organization, user } from './auth';

export const sourceType = pgEnum('source_type', sourceTypeEnum);
export const sourceStatus = pgEnum('source_status', sourceStatusEnum);
export const syncRunStatus = pgEnum('sync_run_status', syncRunStatusEnum);

/**
 * A place knowledge comes from. `config` holds only non-secret settings; OAuth
 * tokens and API keys live in `sourceCredentials` so they can be rotated,
 * redacted and revoked independently of the source itself.
 */
export const sources = pgTable(
  'sources',
  {
    id: idColumn(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    type: sourceType('type').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: sourceStatus('status').notNull().default('pending'),

    config: jsonb<SourceConfig>('config').notNull().default(sql`'{}'::jsonb`),

    /** Connector-owned cursors: last page crawled, git ref, Notion cursor, etags, ... */
    syncState: jsonb<Record<string, unknown>>('sync_state').notNull().default(sql`'{}'::jsonb`),

    syncIntervalMinutes: integer('sync_interval_minutes'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    errorCount: integer('error_count').notNull().default(0),

    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('sources_org_idx').on(table.organizationId),
    index('sources_org_type_idx').on(table.organizationId, table.type),
    index('sources_org_status_idx').on(table.organizationId, table.status),
  ],
);

export interface SourceConfig {
  // website / url
  startUrls?: string[];
  includePaths?: string[];
  excludePaths?: string[];
  allowSubdomains?: boolean;
  maxPages?: number;
  maxDepth?: number;
  crawlExternalLinks?: boolean;
  respectRobotsTxt?: boolean;
  includePatterns?: string[];
  excludePatterns?: string[];
  // github
  owner?: string;
  repo?: string;
  branch?: string;
  includeDirectories?: string[];
  fileExtensions?: string[];
  // notion / confluence
  spaceId?: string;
  spaceKey?: string;
  parentPageId?: string;
  databaseId?: string;
  // slack
  channels?: string[];
  includeThreads?: boolean;
  includePrivateChannels?: boolean;
  // gdrive / s3
  folderIds?: string[];
  driveId?: string;
  bucket?: string;
  prefix?: string;
  region?: string;
  // file
  defaultVisibility?: 'tenant' | 'restricted' | 'private';
  allowedMimeTypes?: string[];
}

export const sourceCredentials = pgTable(
  'source_credentials',
  {
    id: idColumn(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),

    /** AES-256-GCM ciphertext of `{ accessToken, refreshToken, apiKey, ... }`. */
    encryptedSecrets: text('encrypted_secrets').notNull(),
    /** Non-sensitive OAuth metadata (account id, workspace name) kept in clear for the UI. */
    publicInfo: jsonb<Record<string, unknown>>('public_info').notNull().default(sql`'{}'::jsonb`),

    scopes: jsonb<string[]>('scopes').notNull().default(sql`'[]'::jsonb`),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastRotatedAt: timestamp('last_rotated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One credential blob per source.
    uniqueIndex('source_credentials_source_idx').on(table.sourceId),
    index('source_credentials_org_idx').on(table.organizationId),
  ],
);

/** One row per sync attempt; powers the ingest-progress UI. */
export const syncRuns = pgTable(
  'sync_runs',
  {
    id: idColumn(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),

    status: syncRunStatus('status').notNull().default('running'),
    trigger: text('trigger').notNull().default('manual'),
    stats: jsonb<SyncStats>('stats')
      .notNull()
      .default(
        sql`'{"discovered":0,"created":0,"updated":0,"skipped":0,"failed":0,"deleted":0}'::jsonb`,
      ),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    index('sync_runs_source_started_idx').on(table.sourceId, table.startedAt),
    index('sync_runs_org_idx').on(table.organizationId),
  ],
);

export interface SyncStats {
  discovered: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  deleted: number;
}

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type SyncRun = typeof syncRuns.$inferSelect;
