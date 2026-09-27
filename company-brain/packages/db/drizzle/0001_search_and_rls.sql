-- Full-text + vector search indexes, and tenant isolation via RLS.
--
-- These are hand-written because Drizzle's schema DSL cannot express generated
-- columns, HNSW operator classes, or RLS policies.

-- ------------------------------------------------------------------ search --
-- Weighted tsvector. Titles dominate, heading breadcrumbs are next, body last.
-- STORED + GENERATED ALWAYS means it can never drift from the text it indexes.
--
-- Two Postgres constraints shape this expression:
--   * `to_tsvector(regconfig, text)` is IMMUTABLE but the untyped-literal form
--     binds to `to_tsvector(text)`, which is STABLE. Hence the `::regconfig`.
--   * `array_to_string` is STABLE, so the heading path is denormalised into the
--     immutable `chunks.heading_text` column rather than flattened here.
ALTER TABLE "chunks"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
      setweight(to_tsvector('english'::regconfig, coalesce("title", '')), 'A') ||
      setweight(to_tsvector('english'::regconfig, coalesce("heading_text", '')), 'B') ||
      setweight(to_tsvector('english'::regconfig, coalesce("content", '')), 'C')
  ) STORED;

-- Keyword arm of hybrid search.
CREATE INDEX "chunks_search_vector_idx"
  ON "chunks" USING GIN ("search_vector");

-- Vector arm of hybrid search. HNSW (pgvector >= 0.5) beats IVFFlat here: no
-- post-hoc training step, and it can be created on a live table.
-- m=16 / ef_construction=64 is pgvector's recommended starting point.
CREATE INDEX "chunks_embedding_hnsw_idx"
  ON "chunks" USING HNSW ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Retrieval always filters by tenant first, then reads a document's chunks in
-- order when assembling context.
CREATE INDEX "chunks_org_ordinal_idx"
  ON "chunks" ("organization_id", "document_id", "ordinal");

-- -------------------------------------------------------------------- RLS ---
-- Defence in depth. Every tenant-scoped table additionally filters on
-- organization_id in application code; RLS makes a forgotten filter a
-- zero-row result rather than a cross-tenant leak.
--
-- The connection sets `app.organization_id` per transaction (see
-- `withTenant` in @company-brain/db). Genuinely cross-tenant code paths
-- (the queue claiming loop, nightly rollups, the seeder) set `app.bypass_rls`.
--
-- FORCE is required: the application role owns these tables and owners are
-- otherwise exempt from RLS.
--
-- Better Auth's eight tables (user, session, account, verification,
-- organization, member, invitation, two_factor) are deliberately absent. It has
-- to read them across tenants to resolve a session and to list the workspaces a
-- user belongs to, and it applies its own access control to every mutation.
-- Policing them would break sign-in. Everything the application queries is
-- listed below.

CREATE OR REPLACE FUNCTION app_current_organization_id() RETURNS text
  LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.organization_id', true), '')
  $$;

CREATE OR REPLACE FUNCTION app_bypass_rls() RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT coalesce(current_setting('app.bypass_rls', true), 'off') = 'on'
  $$;

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'sources', 'source_credentials', 'sync_runs',
    'documents', 'chunks',
    'conversations', 'messages',
    'ai_provider_configs', 'api_keys', 'usage_events', 'audit_logs',
    'jobs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);

    EXECUTE format($pol$
      CREATE POLICY %1$s_tenant_isolation ON %1$I
        USING (
          app_bypass_rls()
          OR "organization_id" IS NULL
          OR "organization_id" = app_current_organization_id()
        )
        WITH CHECK (
          app_bypass_rls()
          OR "organization_id" = app_current_organization_id()
        )
    $pol$, target);
  END LOOP;
END
$$;

-- --------------------------------------------------------------- retention --
-- Cheap periodic cleanup, wired to pg_cron when available. Safe to skip: the
-- same statements can be run by hand from `ops/maintenance.sql`.
CREATE OR REPLACE FUNCTION app_prune_dead_jobs() RETURNS integer
  LANGUAGE plpgsql AS $$
DECLARE
  jobs_removed integer;
  sessions_removed integer;
  verifications_removed integer;
BEGIN
  DELETE FROM "jobs"
   WHERE "status" IN ('completed', 'cancelled')
     AND "updated_at" < now() - interval '7 days';
  GET DIAGNOSTICS jobs_removed = ROW_COUNT;

  DELETE FROM "jobs"
   WHERE "status" = 'failed'
     AND "updated_at" < now() - interval '30 days';
  GET DIAGNOSTICS sessions_removed = ROW_COUNT;

  DELETE FROM "session" WHERE "expires_at" < now() - interval '30 days';
  GET DIAGNOSTICS verifications_removed = ROW_COUNT;

  DELETE FROM "verification" WHERE "expires_at" < now() - interval '30 days';

  -- GET DIAGNOSTICS targets must be bare variables, so the last count is
  -- accumulated in SQL rather than in a PL/pgSQL expression.
  RETURN jobs_removed + sessions_removed + verifications_removed;
END
$$;

COMMENT ON FUNCTION app_prune_dead_jobs() IS
  'Prunes finished queue jobs, expired sessions and stale verification rows.';
