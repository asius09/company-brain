import { sql } from 'drizzle-orm';
import { boolean, index, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { idColumn, jsonb } from './columns';
import { providerKindEnum } from './enums';
import { organization, user } from './auth';

export const providerKind = pgEnum('provider_kind', providerKindEnum);

/**
 * A tenant's own AI credentials (BYOK) plus the platform default that lives in
 * the environment. `encryptedApiKey` / `encryptedExtra` hold AES-256-GCM
 * ciphertext from `@company-brain/core/crypto` — never plaintext.
 *
 * A tenant may register several providers (e.g. Bedrock for chat and OpenAI for
 * embeddings); exactly one is flagged `isDefault` per tenant.
 */
export const aiProviderConfigs = pgTable(
  'ai_provider_configs',
  {
    id: idColumn(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    provider: providerKind('provider').notNull(),

    /** Provider-specific endpoint override (Ollama, vLLM, Azure resource, OpenRouter base). */
    baseUrl: text('base_url'),
    /** AWS region for Bedrock, location for Vertex. */
    region: text('region'),

    chatModel: text('chat_model'),
    embeddingModel: text('embedding_model'),
    /** How the provider authenticates: bearer | aws-sigv4 | api-key-header | none. */
    authStrategy: text('auth_strategy').notNull().default('bearer'),

    encryptedApiKey: text('encrypted_api_key'),
    /**
     * Ciphertext from `encryptJson()` — never plaintext. `text`, not `jsonb`,
     * because the value is a single AES-256-GCM blob, not a readable object.
     */
    encryptedExtra: text('encrypted_extra'),

    settings: jsonb<ProviderSettings>('settings').notNull().default(sql`'{}'::jsonb`),

    isDefault: boolean('is_default').notNull().default(false),
    isEnabled: boolean('is_enabled').notNull().default(true),

    lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
    lastError: text('last_error'),

    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ai_provider_configs_org_idx').on(table.organizationId),
    index('ai_provider_configs_default_idx').on(table.organizationId, table.isDefault),
  ],
);

export interface ProviderSettings {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  supportsSystemPrompt?: boolean;
  supportsStreaming?: boolean;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /** Vertex / Gemini. */
  projectId?: string;
  location?: string;
  /** Azure OpenAI. */
  deploymentName?: string;
  apiVersion?: string;
  /** Cost guardrails, per-request. */
  maxCostUsd?: number;
}

export type AiProviderConfig = typeof aiProviderConfigs.$inferSelect;
export type NewAiProviderConfig = typeof aiProviderConfigs.$inferInsert;
