/**
 * Domain enums live in `@company-brain/core` so the runtime values, the
 * `pgEnum` definitions below and the API contracts can never drift.
 * Re-exported here because `schema/index.ts` is the single import site.
 */
export * from '@company-brain/core/types/enums';
