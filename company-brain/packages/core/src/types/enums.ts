/**
 * Canonical domain enums. `packages/db` re-exports these so the Drizzle
 * `pgEnum` definitions and the runtime values can never drift.
 */

export const tenantPlanEnum = ['free', 'starter', 'pro', 'enterprise'] as const;
export type TenantPlan = (typeof tenantPlanEnum)[number];

export const providerKindEnum = [
  'openrouter',
  'bedrock',
  'anthropic',
  'openai',
  'azure-openai',
  'vertex',
  'google',
  'mistral',
  'groq',
  'cohere',
  'ollama',
  'custom',
] as const;
export type ProviderKind = (typeof providerKindEnum)[number];

export const sourceTypeEnum = [
  'file',
  'website',
  'github',
  'notion',
  'confluence',
  'slack',
  'gdrive',
  's3',
  'url',
  'text',
  'email',
] as const;
export type SourceType = (typeof sourceTypeEnum)[number];

export const sourceStatusEnum = [
  'pending',
  'connected',
  'syncing',
  'paused',
  'error',
  'disconnected',
] as const;
export type SourceStatus = (typeof sourceStatusEnum)[number];

export const documentStatusEnum = [
  'pending',
  'processing',
  'indexed',
  'failed',
  'stale',
  'deleted',
] as const;
export type DocumentStatus = (typeof documentStatusEnum)[number];

export const visibilityEnum = ['tenant', 'restricted', 'private'] as const;
export type Visibility = (typeof visibilityEnum)[number];

export const jobStatusEnum = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof jobStatusEnum)[number];

export const jobTypeEnum = [
  'source.sync',
  'source.disconnect',
  'document.ingest',
  'document.reingest',
  'document.delete',
  'chunk.embed',
  'source.schedule',
] as const;
export type JobType = (typeof jobTypeEnum)[number];

export const messageRoleEnum = ['user', 'assistant', 'system'] as const;
export type MessageRole = (typeof messageRoleEnum)[number];

export const usageKindEnum = ['chat', 'embedding', 'rerank', 'vision'] as const;
export type UsageKind = (typeof usageKindEnum)[number];

export const syncRunStatusEnum = ['running', 'succeeded', 'partial', 'failed'] as const;
export type SyncRunStatus = (typeof syncRunStatusEnum)[number];

export const apiKeyScopeEnum = ['read', 'write', 'chat', 'ingest', 'admin'] as const;
export type ApiKeyScope = (typeof apiKeyScopeEnum)[number];

export const feedbackEnum = ['up', 'down', null] as const;
export type Feedback = (typeof feedbackEnum)[number];

/** Roles a member can hold inside one organization (= one tenant). */
export const roleEnum = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof roleEnum)[number];

export const ROLE_RANK: Record<Role, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}
