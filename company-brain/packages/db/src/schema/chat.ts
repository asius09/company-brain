import { sql } from 'drizzle-orm';
import { index, integer, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { idColumn, jsonb } from './columns';
import { messageRoleEnum } from './enums';
import { organization, user } from './auth';

export const messageRole = pgEnum('message_role', messageRoleEnum);

export const conversations = pgTable(
  'conversations',
  {
    id: idColumn(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),

    title: text('title'),
    /** Model that answered the last turn, so the UI can badge the thread. */
    lastModel: text('last_model'),
    lastProvider: text('last_provider'),
    messageCount: integer('message_count').notNull().default(0),

    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('conversations_org_user_idx').on(table.organizationId, table.userId, table.updatedAt),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: idColumn(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    role: messageRole('role').notNull(),
    content: text('content').notNull(),

    /** Source chunks the answer was grounded in, with offsets for highlighting. */
    citations: jsonb<StoredCitation[]>('citations').notNull().default(sql`'[]'::jsonb`),

    provider: text('provider'),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsdMicros: integer('cost_usd_micros'),

    /** Set when the answer came back with no supporting chunk. */
    wasGrounded: integer('was_grounded'),
    feedback: text('feedback'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('messages_conversation_idx').on(table.conversationId, table.createdAt),
    index('messages_org_created_idx').on(table.organizationId, table.createdAt),
  ],
);

export interface StoredCitation {
  chunkId: string;
  documentId: string;
  title: string;
  uri?: string | null;
  sourceType: string;
  sourceName: string;
  headingPath: string[];
  /** Offsets *within the chunk's content*, used to highlight the quoted span. */
  startOffset: number;
  endOffset: number;
  score: number;
  snippet: string;
}

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
