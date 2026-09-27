/**
 * Embedding entry point.
 *
 * Kept as a thin, typed wrapper over the AI SDK so callers never assemble
 * provider models by hand and every embedding request passes the same
 * dimension check.
 */
import { createLogger } from '@company-brain/core';
import { resolveModel } from './registry';
import { resolveProvider } from './credentials';
import { settleCost } from './guardrails';
import type { ResolvedProvider } from './resolve';

const log = createLogger('ai.embeddings');

export interface EmbeddingRequest {
  organizationId: string;
  /** Texts to embed, in order. The returned vectors match this order. */
  inputs: string[];
  modelId?: string;
  provider?: ResolvedProvider;
  signal?: AbortSignal;
}

export interface EmbeddingResult {
  embeddings: number[][];
  model: string;
  usage: { inputTokens: number };
  estimatedUsd: number;
  /** False when the model is not in the catalogue, so the cost is a guess. */
  costIsExact: boolean;
}

/**
 * Catalog key for a resolved model.
 *
 * `MODEL_CATALOG` is keyed `provider/model`. A provider whose `kind` differs
 * from the catalog's provider segment (a Bedrock-hosted Anthropic model, a
 * Vertex-hosted Gemini) still costs what the catalog says, so the kind is what
 * qualifies the lookup, and a miss is reported rather than silently priced at
 * zero.
 */
export function catalogId(providerKind: string, modelId: string): string {
  return `${providerKind}/${modelId}`;
}

/** Provider batches cap how many inputs go in one request. */
const BATCH_SIZE = 96;

export async function embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
  const provider = request.provider ?? (await resolveProvider(request.organizationId, { capability: 'embedding' }));
  const resolved = await resolveModel({
    provider,
    modelId: request.modelId,
    capability: 'embedding',
  });
  // The SDK types vary per provider, and the adapter erases them; the shape we
  // actually call is stable across all of them.
  const callable = resolved.model as unknown as {
    embed: (input: string[], options: { abortSignal?: AbortSignal }) => Promise<{
      embeddings: number[][];
      usage?: { inputTokens?: number; promptTokens?: number };
    }>;
    doEmbed?: (options: {
      values: string[];
      abortSignal?: AbortSignal;
    }) => Promise<{ embeddings: number[][]; usage?: { inputTokens?: number; promptTokens?: number } }>;
  };

  const inputs = request.inputs.filter((input) => input.trim().length > 0);
  if (inputs.length === 0) {
    return {
      embeddings: [],
      model: request.modelId ?? 'none',
      usage: { inputTokens: 0 },
      estimatedUsd: 0,
      costIsExact: false,
    };
  }

  const embeddings: number[][] = [];
  let inputTokens = 0;

  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const batch = inputs.slice(i, i + BATCH_SIZE);

    const response = callable.embed
      ? await callable.embed(batch, { abortSignal: request.signal })
      : await callable.doEmbed?.({ values: batch, abortSignal: request.signal });

    if (!response) {
      throw new Error('embedding provider exposed neither embed nor doEmbed');
    }

    embeddings.push(...response.embeddings);
    inputTokens += response.usage?.inputTokens ?? response.usage?.promptTokens ?? 0;
  }

  const widths = new Set(embeddings.map((vector) => vector.length));
  if (widths.size > 1) {
    // Mixing widths in one index would corrupt cosine similarity.
    throw new Error(`embedding provider returned mixed dimensions: ${[...widths].join(', ')}`);
  }

  const cost = settleCost(catalogId(provider.kind, resolved.id), { inputTokens });

  log.debug('embeddings.completed', 'embedded a batch', {
    count: embeddings.length,
    dimensions: [...widths][0],
    inputTokens,
  });

  return {
    embeddings,
    // The id the model was built with, so a later audit can name it.
    model: resolved.id,
    usage: { inputTokens },
    estimatedUsd: cost.usd,
    costIsExact: cost.exact,
  };
}
