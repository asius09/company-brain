/**
 * Worker-local type aliases.
 *
 * Kept in one module so processors and connectors can share them without
 * importing each other, and so the (long) inferred Drizzle row types appear once.
 */
import type { Source, SourceConfig, SyncRun } from '@company-brain/db';

export type { Source, SourceConfig, SyncRun };

/** A `sources` row as stored, including its connector config. */
export type SourcesRow = Source;
