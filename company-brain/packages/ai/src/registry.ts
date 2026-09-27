import { createLogger } from '@company-brain/core';
import { assertUsable, type ResolvedProvider } from './resolve';

/**
 * Provider registry.
 *
 * Builds a ready-to-call Vercel AI SDK model from a `ResolvedProvider`. The SDK
 * is used rather than hand-written HTTP clients because twelve providers with
 * streaming, tool calls, retries and usage accounting is not a problem worth
 * re-solving, and because a provider the platform has not heard of yet can be
 * added as `openai-compatible` without touching this file.
 */
/**
 * A model plus the id it was actually constructed with.
 *
 * Returning both is deliberate: the caller needs the SDK object to stream with
 * and a stable string to price and log against, and deriving that string
 * separately (from the provider config, say) lets the two drift apart, which
 * silently mis-bills every request.
 */
export interface ProviderModel<M = unknown> {
  /** The SDK model, ready for `streamText`/`generateText` or `embed`. */
  model: M;
  /** Canonical id, e.g. `claude-sonnet-4-5`. */
  id: string;
}

export interface ProviderAdapter {
  /** Stable id, for metrics and error messages. */
  readonly id: string;
  /** Builds a language model for chat/completion. */
  chat(provider: ResolvedProvider, modelId?: string): ProviderModel;
  /** Builds an embedding model, when the provider offers one. */
  embedding?(provider: ResolvedProvider, modelId?: string): ProviderModel;
}

const log = createLogger('ai.registry');

/** Providers that speak the OpenAI wire protocol, just at different hosts. */
const OPENAI_COMPATIBLE: Record<string, { baseUrl: string; label: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', label: 'OpenAI' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', label: 'OpenRouter' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', label: 'Groq' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', label: 'Mistral' },
  ollama: { baseUrl: 'http://localhost:11434/v1', label: 'Ollama' },
  custom: { baseUrl: '', label: 'Custom (OpenAI-compatible)' },
};

let adapters: Map<string, ProviderAdapter> | null = null;

async function loadAdapters(): Promise<Map<string, ProviderAdapter>> {
  if (adapters) return adapters;

  // Imported lazily so a process that only embeds does not pay to load every
  // provider client, and so an optional native dependency in one of them can
  // never stop the others from loading.
  const [anthropic, openai, azure, bedrock, google, vertex, cohere, openaiCompatible] =
    await Promise.all([
      import('@ai-sdk/anthropic'),
      import('@ai-sdk/openai'),
      import('@ai-sdk/azure'),
      import('@ai-sdk/amazon-bedrock'),
      import('@ai-sdk/google'),
      import('@ai-sdk/google-vertex'),
      import('@ai-sdk/cohere'),
      import('@ai-sdk/openai-compatible'),
    ]);

  const map = new Map<string, ProviderAdapter>();

  // --- Native SDKs ----------------------------------------------------------
  map.set('anthropic', {
    id: 'anthropic',
    chat: (provider, modelId) => {
      const instance = anthropic.createAnthropic({
        apiKey: provider.apiKey,
        baseURL: provider.baseUrl,
      });
      const id = modelId ?? provider.chatModel ?? 'claude-sonnet-4-5';
      return { model: instance(id), id };
    },
  });

  map.set('cohere', {
    id: 'cohere',
    chat: (provider, modelId) => {
      const instance = cohere.createCohere({ apiKey: provider.apiKey });
      const id = modelId ?? provider.chatModel ?? 'command-r-plus';
      return { model: instance(id), id };
    },
  });

  map.set('bedrock', {
    id: 'bedrock',
    chat: (provider, modelId) => {
      const instance = bedrock.createAmazonBedrock({
        region: provider.region,
        // Explicit credentials only; otherwise the SDK uses the ambient AWS
        // credential chain (IAM role, SSO, env), which is the right default on
        // ECS/Lambda and keeps long-lived keys out of the database.
        ...(provider.apiKey
          ? {
              accessKeyId: provider.extra.accessKeyId,
              secretAccessKey: provider.extra.secretAccessKey,
              sessionToken: provider.extra.sessionToken,
            }
          : {}),
      });
      const id = modelId ?? provider.chatModel ?? 'anthropic.claude-sonnet-4-5-20250929-v1:0';
      return { model: instance(id), id };
    },
    embedding: (provider, modelId) => {
      const instance = bedrock.createAmazonBedrock({ region: provider.region });
      const id = modelId ?? provider.embeddingModel ?? 'amazon.titan-embed-text-v2:0';
      return { model: instance.embeddingModel(id), id };
    },
  });

  for (const kind of ['google', 'vertex'] as const) {
    map.set(kind, {
      id: kind,
      chat: (provider, modelId) => {
        // `vertex` is the GCP-hosted surface; it needs a project and location.
        // `vertex` is the GCP-hosted surface and needs a project and location;
        // `google` is the public Generative Language API and needs a key.
        const instance =
          kind === 'vertex'
            ? vertex.createVertex({
                project: provider.settings.projectId,
                location: provider.settings.location ?? provider.region ?? 'us-central1',
                baseURL: provider.baseUrl,
              })
            : google.createGoogleGenerativeAI({
                apiKey: provider.apiKey,
                baseURL: provider.baseUrl,
              });
        const id = modelId ?? provider.chatModel ?? 'gemini-2.5-flash';
        return { model: instance(id), id };
      },
      embedding: (provider, modelId) => {
        const instance = google.createGoogleGenerativeAI({ apiKey: provider.apiKey });
        const id = modelId ?? provider.embeddingModel ?? 'text-embedding-004';
        return { model: instance.embeddingModel(id), id };
      },
    });
  }

  map.set('azure-openai', {
    id: 'azure-openai',
    chat: (provider, modelId) => {
      const instance = azure.createAzure({
        apiKey: provider.apiKey,
        resourceName: provider.extra.resourceName,
        baseURL: provider.baseUrl,
        apiVersion: provider.settings.apiVersion ?? '2024-10-21',
      });
      const id = modelId ?? provider.settings.deploymentName ?? 'gpt-4o';
      return { model: instance(id), id };
    },
    embedding: (provider, modelId) => {
      const instance = azure.createAzure({
        apiKey: provider.apiKey,
        resourceName: provider.extra.resourceName,
        baseURL: provider.baseUrl,
        apiVersion: provider.settings.apiVersion ?? '2024-10-21',
      });
      const id = modelId ?? provider.embeddingModel ?? 'text-embedding-3-small';
      return { model: instance.embeddingModel(id), id };
    },
  });

  // --- OpenAI-compatible ----------------------------------------------------
  for (const [kind, preset] of Object.entries(OPENAI_COMPATIBLE)) {
    map.set(kind, {
      id: kind,
      chat: (provider, modelId) => {
        const baseURL = provider.baseUrl || preset.baseUrl;
        // OpenRouter rejects requests without these; harmless elsewhere.
        const headers = {
          ...(kind === 'openrouter'
            ? { 'HTTP-Referer': 'https://companybrain.dev', 'X-Title': 'CompanyBrain' }
            : {}),
          ...(provider.settings.extraHeaders ?? {}),
        };
        const instance = openaiCompatible.createOpenAICompatible({
          name: preset.label,
          apiKey: provider.apiKey || 'not-needed',
          baseURL,
          headers,
        });
        const id = modelId ?? provider.chatModel ?? 'gpt-4o-mini';
        return { model: instance(id), id };
      },
      embedding: (provider, modelId) => {
        const baseURL = provider.baseUrl || preset.baseUrl;
        const instance = openaiCompatible.createOpenAICompatible({
          name: preset.label,
          apiKey: provider.apiKey || 'not-needed',
          baseURL,
        });
        const id = modelId ?? provider.embeddingModel ?? 'text-embedding-3-small';
      return { model: instance.embeddingModel(id), id };
      },
    });
  }

  adapters = map;
  return map;
}

export async function getAdapter(kind: string): Promise<ProviderAdapter | null> {
  const map = await loadAdapters();
  return map.get(kind) ?? null;
}

/** Every provider kind this build can talk to. */
export async function listAdapters(): Promise<string[]> {
  const map = await loadAdapters();
  return [...map.keys()].sort();
}

export interface ModelRequest {
  provider: ResolvedProvider;
  modelId?: string;
  capability: 'chat' | 'embedding';
}

/**
 * Returns a ready-to-call model, validating configuration first.
 *
 * Throws `aiProviderUnconfigured` when the provider is unknown, misconfigured,
 * or does not offer the requested capability — all of which are tenant
 * configuration problems the UI can explain, not bugs.
 */
export function resolveModel(request: ModelRequest & { capability: 'chat' }): Promise<ProviderModel>;
export function resolveModel(request: ModelRequest & { capability: 'embedding' }): Promise<ProviderModel>;
export async function resolveModel(request: ModelRequest): Promise<ProviderModel> {
  const { provider, modelId, capability } = request;
  assertUsable(provider);

  const adapter = await getAdapter(provider.kind);
  if (!adapter) {
    log.error('adapter.unknown_provider', 'no adapter for provider kind', { kind: provider.kind });
    throw new Error(`unsupported provider "${provider.kind}"`);
  }

  if (capability === 'embedding') {
    if (!adapter.embedding) {
      throw new Error(`provider "${provider.kind}" does not offer embeddings`);
    }
    return adapter.embedding(provider, modelId);
  }

  return adapter.chat(provider, modelId);
}
