-- Scope idempotency keys per tenant.
--
-- The previous index was unique on `idempotency_key` alone, which made a
-- caller-supplied key a global namespace. If two tenants ever derived the same
-- natural key -- `source.sync:<sourceId>` from two different connectors, or a key
-- seeded from a shared upstream id -- the second enqueue would fail with a unique
-- violation. That is both a correctness bug and a cross-tenant denial of service
-- on ingestion. The key only ever means "this tenant already asked for this work",
-- which is what the application code already assumed: it looks the existing job up
-- by (organization_id, idempotency_key).
DROP INDEX "jobs_idempotency_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_idx" ON "jobs" USING btree ("organization_id","idempotency_key") WHERE "jobs"."idempotency_key" IS NOT NULL;
