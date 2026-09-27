import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { getEnv } from '@company-brain/core/config/env';
import { createLogger } from '@company-brain/core/logger';
import * as schema from './schema';

const logger = createLogger('db');

export type Database = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

let client: ReturnType<typeof postgres> | undefined;
let database: Database | undefined;

function createPool() {
  const env = getEnv();

  return postgres(env.DATABASE_URL, {
    max: env.DATABASE_POOL_MAX,
    // Serverless drivers hand back TLS-terminated sockets; the pooler handles it.
    ssl: env.DATABASE_SSL ? 'require' : undefined,
    prepare: false, // Required for pgbouncer / Supabase transaction mode.
    onnotice: () => {},
    transform: postgres.camel,
    // No per-connection "clear the tenant" hook is needed. `app.bypass_rls`
    // defaults to unset (i.e. false) on a fresh connection, and every
    // `withTenant` / `withSystemAccess` stamp uses `set_config(..., true)`,
    // which is transaction-local and therefore unwinds on commit or rollback.
    // A pooled connection can never carry a previous transaction's tenant.
  });
}

export function getPool(): ReturnType<typeof postgres> {
  client ??= createPool();
  return client;
}

export function db(): Database {
  database ??= drizzle(getPool(), { schema, casing: 'snake_case' });
  return database;
}

/**
 * Runs `fn` inside a transaction that has already stamped the tenant onto the
 * connection, so Postgres row-level-security policies can enforce isolation
 * even if a query forgets its `organizationId` filter.
 *
 * The stamp must go through Drizzle's `sql` template rather than a plain string:
 * a raw template would inline the id into the statement instead of sending it as
 * a bind parameter, which both breaks the prepared-statement cache and leaves no
 * parameter to escape.
 */
export async function withTenant<T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
    return fn(tx);
  });
}

/**
 * Escape hatch for genuinely cross-tenant work (claiming jobs, nightly stats
 * rollups, the seeder). Sets `app.bypass_rls` for the transaction only.
 */
export async function withSystemAccess<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}

export async function healthcheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = performance.now();
  try {
    await getPool()`select 1`;
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    logger.error('db_healthcheck_failed', 'Database healthcheck failed', {}, error);
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function closePool(): Promise<void> {
  if (!client) return;
  await client.end({ timeout: 5 });
  client = undefined;
  database = undefined;
}

export { schema };
