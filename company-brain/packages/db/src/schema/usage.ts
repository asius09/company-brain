import { sql } from 'drizzle-orm';
import { index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { idColumn, jsonb } from './columns';
import { apiKeyScopeEnum, usageKindEnum } from './enums';
import { organization, user } from './auth';

export const usageKind = pgEnum('usage_kind', usageKindEnum);
export const apiKeyScope = pgEnum('api_key_scope', apiKeyScopeEnum);

/**
 * Append-only ledger of every billable provider call, per tenant.
 *
 * Cost is stored in **integer micro-USD** (`cost_usd_micros`) rather than float
 * or `numeric`: it is a lossless integer, it sorts and aggregates exactly, and it
 * avoids float drift accumulating across millions of rows. `usageMicros()` is
 * the only place that converts back to a float.
 */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: idColumn(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),

    kind: usageKind('kind').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),

    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsdMicros: integer('cost_usd_micros').notNull().default(0),

    requestId: text('request_id'),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    conversationId: text('conversation_id'),
    metadata: jsonb<Record<string, unknown>>('metadata').notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('usage_events_org_created_idx').on(table.organizationId, table.createdAt),
    index('usage_events_org_kind_idx').on(table.organizationId, table.kind, table.createdAt),
  ],
);

/**
 * Long-lived machine credentials for programmatic access.
 *
 * Only a SHA-256 digest of the key is stored, so a database leak cannot be
 * replayed. `prefix` (first 8 chars) exists purely so a human can tell keys
 * apart in the UI.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: idColumn(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),

    scopes: jsonb<Array<(typeof apiKeyScopeEnum)[number]>>('scopes')
      .notNull()
      .default(sql`'["read"]'::jsonb`),
    rateLimitPerMinute: integer('rate_limit_per_minute'),

    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('api_keys_hash_idx').on(table.keyHash),
    index('api_keys_org_idx').on(table.organizationId),
  ],
);

/** Security-relevant actions, kept forever (or until the org is deleted). */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: idColumn(),
    organizationId: text('organization_id').references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),

    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    metadata: jsonb<Record<string, unknown>>('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_logs_org_created_idx').on(table.organizationId, table.createdAt),
    index('audit_logs_action_idx').on(table.action),
  ],
);

/** Integer micro-USD helpers — the only place USD floats are produced. */
export const usdToMicros = (usd: number): number => Math.round(usd * 1_000_000);
export const microsToUsd = (micros: number): number => micros / 1_000_000;

export type UsageEvent = typeof usageEvents.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
