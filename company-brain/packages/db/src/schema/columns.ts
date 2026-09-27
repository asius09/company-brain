import { sql } from 'drizzle-orm';
import { customType, jsonb as jsonbColumn, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Better Auth issues `text` primary keys for every one of its models (user,
 * organization, session, ...). Everything that references those models must
 * therefore also be `text`, so the app uses text ids throughout for consistency.
 */
export const idColumn = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID())
    .notNull();

/**
 * Width of `chunks.embedding`. Baked into the generated migration, so changing
 * it requires a new migration plus a full re-embed of the corpus.
 */
export const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 1536);

export const vector = customType<{ data: number[]; driverData: number[] }>({
  dataType() {
    return `vector(${EMBEDDING_DIMENSIONS})`;
  },
});

export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * `jsonb` with a TypeScript payload type. Thin wrapper over Drizzle's built-in
 * so call sites read `jsonb<Settings>('settings')`.
 */
export const jsonb = <T = unknown>(name: string) => jsonbColumn(name).$type<T>();

export const createdAtColumn = () =>
  timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const updatedAtColumn = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** `text` FK to a Better Auth model. */
export const authRef = (name: string) => text(name);

export { sql };
