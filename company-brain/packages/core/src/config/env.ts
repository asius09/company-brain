import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from 'dotenv';
import { z } from 'zod';

/**
 * Platform-wide configuration. Every process (api, worker, scripts) reads the
 * same validated object, so a misconfigured deployment fails loudly at boot
 * rather than at the first request.
 *
 * `PLATFORM_AI_*` are fallbacks. A tenant can override any of them with its own
 * BYOK credential — see `@company-brain/ai/resolve`.
 */

/**
 * `.env` is loaded here, inside the module that owns `getEnv()`, rather than in
 * a consumer. Otherwise load order decides whether env is available: importing
 * anything that touches `getLogger()` before the db package would read an empty
 * `process.env` and fail validation.
 *
 * Paths are resolved from this file's location, not `process.cwd()`, so the api,
 * the worker, and `pnpm --filter ... exec` all find the same file.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../../..');

config({
  path: [join(repoRoot, '.env'), join(repoRoot, '.env.local'), join(here, '../.env')],
  quiet: true,
});

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const csv = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .default([]);

const csvOrEmpty = z
  .string()
  .optional()
  .transform((v) =>
    v === undefined || v.trim() === ''
      ? []
      : v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
  );

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  LOG_PRETTY: boolish.default(false),

  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_HOST: z.string().default('0.0.0.0'),
  /** Public origin of the API. Used for OAuth callbacks and cookie/CORS origin checks. */
  API_URL: z.string().url().default('http://localhost:3001'),
  /** Public origin of the Vite app. */
  WEB_URL: z.string().url().default('http://localhost:5173'),

  /** Origins allowed to call the API with credentials. */
  CORS_ORIGINS: csvOrEmpty,

  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(240),
  BODY_LIMIT_BYTES: z.coerce.string().default('25mb'),
});

const dbSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** Optional direct (non-pooled) connection used by migrations. */
  DIRECT_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
  DATABASE_SSL: boolish.default(false),
});

const authSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3001'),

  /** AES-256-GCM key (64 hex chars) protecting tenant API keys + OAuth tokens at rest. */
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'ENCRYPTION_KEY must be 64 hex characters'),

  SESSION_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  /** Inactivity window that forces re-auth on sensitive actions. */
  SESSION_FRESH_DAYS: z.coerce.number().int().min(0).default(7),

  EMAIL_FROM: z.string().default('Company Brain <no-reply@companybrain.dev>'),
  /** When true, emails are logged instead of sent. Required for local dev. */
  EMAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
  SMTP_URL: z.string().optional(),

  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),

  /** Caps sign-up when unset (open registration, tenant created on first login). */
  ALLOWED_SIGNUP_EMAIL_DOMAINS: csvOrEmpty,
});

/**
 * Platform-default AI provider. Tenants may override; when a tenant has no
 * configured credential these are used.
 */
const platformAiSchema = z.object({
  /** openrouter | bedrock | anthropic | openai | azure-openai | vertex | google | mistral | groq | cohere | ollama | custom */
  PLATFORM_AI_PROVIDER: z
    .enum([
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
    ])
    .default('openrouter'),

  PLATFORM_AI_API_KEY: z.string().optional(),
  PLATFORM_AI_BASE_URL: z.string().optional(),
  PLATFORM_AI_REGION: z.string().default('us-east-1'),

  PLATFORM_CHAT_MODEL: z.string().default('anthropic/claude-sonnet-4.5'),
  PLATFORM_EMBEDDING_MODEL: z.string().default('openai/text-embedding-3-small'),

  /** Width of the `chunks.embedding` vector column. Baked into migrations. */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(4096).default(1536),

  MAX_EMBEDDING_BATCH: z.coerce.number().int().min(1).default(96),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),

  /** Cost ceiling guardrail per chat request, in USD. */
  MAX_REQUEST_COST_USD: z.coerce.number().min(0).default(0.25),
});

const retrievalSchema = z.object({
  CHUNK_TARGET_TOKENS: z.coerce.number().int().min(128).max(2048).default(480),
  CHUNK_OVERLAP_TOKENS: z.coerce.number().int().min(0).max(512).default(80),
  CHUNK_MIN_TOKENS: z.coerce.number().int().min(16).default(48),
  RETRIEVAL_TOP_K: z.coerce.number().int().min(1).max(100).default(12),
  RETRIEVAL_CANDIDATES: z.coerce.number().int().min(10).max(400).default(60),
  RETRIEVAL_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.12),
  /** Weight of the vector arm in Reciprocal Rank Fusion. */
  RRF_K: z.coerce.number().int().min(1).default(60),
  RRF_VECTOR_WEIGHT: z.coerce.number().min(0).max(1).default(1),
  RRF_KEYWORD_WEIGHT: z.coerce.number().min(0).max(1).default(0.6),
  RERANK_ENABLED: boolish.default(true),
  RERANK_MODEL: z.string().optional(),
  RERANK_TOP_N: z.coerce.number().int().min(1).default(12),
});

const workerSchema = z.object({
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1500),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).default(8),
  WORKER_STALE_LOCK_MS: z.coerce.number().int().min(10_000).default(300_000),
  /** HTTP timeout + max pages for the website crawler. */
  CRAWL_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  CRAWL_MAX_PAGES: z.coerce.number().int().min(1).default(500),
  CRAWL_MAX_DEPTH: z.coerce.number().int().min(0).default(3),
  CRAWL_MAX_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  CRAWL_USER_AGENT: z.string().default('CompanyBrainBot/1.0 (+https://companybrain.dev/bot)'),
  /** Where uploaded files and generated artifacts are written in local dev. */
  STORAGE_DIR: z.string().default('.data/files'),
});

const integrationSchema = z.object({
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  NOTION_CLIENT_ID: z.string().optional(),
  NOTION_CLIENT_SECRET: z.string().optional(),
  CONFLUENCE_CLIENT_ID: z.string().optional(),
  CONFLUENCE_CLIENT_SECRET: z.string().optional(),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID_DRIVE: z.string().optional(),
  GOOGLE_CLIENT_SECRET_DRIVE: z.string().optional(),
  GOOGLE_REDIRECT_URI_DRIVE: z.string().optional(),
});

const envSchema = serverSchema
  .merge(dbSchema)
  .merge(authSchema)
  .merge(platformAiSchema)
  .merge(retrievalSchema)
  .merge(workerSchema)
  .merge(integrationSchema)
  .superRefine((env, ctx) => {
    // Fatal cross-field checks only. Non-fatal findings live in
    // `collectEnvWarnings` because Zod 4 reports warnings through the error
    // channel, which discards the parsed data.
    if (env.EMAIL_TRANSPORT === 'smtp' && !env.SMTP_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_URL'],
        message: 'SMTP_URL is required when EMAIL_TRANSPORT=smtp',
      });
    }
    if (env.CHUNK_OVERLAP_TOKENS >= env.CHUNK_TARGET_TOKENS) {
      ctx.addIssue({
        code: 'custom',
        path: ['CHUNK_OVERLAP_TOKENS'],
        message: 'CHUNK_OVERLAP_TOKENS must be smaller than CHUNK_TARGET_TOKENS',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Applied after parsing: `CORS_ORIGINS` falls back to `WEB_URL`, and findings
 * that should be loud but must not stop the process are reported separately.
 */
function normalizeEnv(env: Env): Env {
  if (!env.CORS_ORIGINS.length) env.CORS_ORIGINS = [env.WEB_URL];
  return env;
}

function collectEnvWarnings(env: Env): string[] {
  const warnings: string[] = [];
  if (env.PLATFORM_AI_PROVIDER !== 'ollama' && !env.PLATFORM_AI_API_KEY) {
    // Not fatal: a tenant may supply its own BYOK credential, but the platform
    // default is what a brand-new workspace falls back to.
    warnings.push(
      'PLATFORM_AI_API_KEY: unset — tenants must configure their own AI provider before chat/embedding works.',
    );
  }
  if (env.EMAIL_TRANSPORT === 'log' && env.NODE_ENV === 'production') {
    warnings.push(
      'EMAIL_TRANSPORT: "log" in production — verification, magic-link and invite emails are only written to the log.',
    );
  }
  return warnings;
}

let cached: Env | undefined;
let cachedWarnings: string[] = [];

export function getEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  cached = normalizeEnv(parsed.data);
  cachedWarnings = collectEnvWarnings(cached);
  return cached;
}

/** Non-fatal findings from the last `getEnv()` call. */
export function getEnvWarnings(): string[] {
  getEnv();
  return cachedWarnings;
}

/** Test helper: forces the next `getEnv()` to re-read `process.env`. */
export function resetEnvCache(): void {
  cached = undefined;
  cachedWarnings = [];
}
