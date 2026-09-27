/**
 * Model catalogue and cost arithmetic.
 *
 * Prices are USD per **1M tokens** and are stored here rather than read from a
 * provider API because they are needed *before* a request is made: the
 * pre-flight guardrail has to decide whether to allow a call using the
 * requested size, and only afterwards learn the actual `usage`.
 *
 * A model missing from the catalogue is not an error. It costs `null`, which
 * every consumer treats as "unknown, so refuse to auto-approve" rather than
 * "free" — the safe direction for a budget guardrail.
 */

/** A price pair, both per 1M tokens. */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface CatalogEntry {
  /** Canonical id, `provider/model`. */
  id: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsStreaming: boolean;
  supportsSystemPrompt: boolean;
  price: ModelPrice;
  /** Embedding models have no output tokens. */
  modality: 'chat' | 'embedding';
  /** Embedding output width; `null` for chat models. */
  dimensions?: number | null;
}

const usd = (input: number, output: number): ModelPrice => ({ inputPerMillion: input, outputPerMillion: output });

/**
 * Catalogue entries.
 *
 * Deliberately a curated subset rather than an exhaustive mirror of every model
 * a provider offers: it covers the models this platform defaults to, and unknown
 * ids degrade to "price unknown" instead of a wrong number. Prices drift, so
 * treat these as guardrail inputs, not billing truth — actual cost comes from
 * the `usage` a provider reports.
 */
export const MODEL_CATALOG: Record<string, CatalogEntry> = Object.fromEntries(
  (
    [
      // --- Anthropic ---------------------------------------------------------
      ['anthropic/claude-opus-4-5', { contextWindow: 200_000, maxOutputTokens: 64_000, price: usd(5, 25) }],
      ['anthropic/claude-sonnet-4-5', { contextWindow: 200_000, maxOutputTokens: 64_000, price: usd(3, 15) }],
      ['anthropic/claude-haiku-4-5', { contextWindow: 200_000, maxOutputTokens: 64_000, price: usd(1, 5) }],

      // --- OpenAI ------------------------------------------------------------
      ['openai/gpt-4o', { contextWindow: 128_000, maxOutputTokens: 16_384, price: usd(2.5, 10) }],
      ['openai/gpt-4o-mini', { contextWindow: 128_000, maxOutputTokens: 16_384, price: usd(0.15, 0.6) }],
      ['openai/text-embedding-3-small', { contextWindow: 8_191, maxOutputTokens: 0, price: usd(0.02, 0), modality: 'embedding', dimensions: 1536 }],
      ['openai/text-embedding-3-large', { contextWindow: 8_191, maxOutputTokens: 0, price: usd(0.13, 0), modality: 'embedding', dimensions: 3072 }],

      // --- OpenRouter --------------------------------------------------------
      ['openrouter/anthropic/claude-sonnet-4.5', { contextWindow: 200_000, maxOutputTokens: 64_000, price: usd(3, 15) }],
      ['openrouter/openai/gpt-4o-mini', { contextWindow: 128_000, maxOutputTokens: 16_384, price: usd(0.15, 0.6) }],

      // --- Bedrock -----------------------------------------------------------
      ['bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0', { contextWindow: 200_000, maxOutputTokens: 64_000, price: usd(3, 15) }],
      ['bedrock/amazon.titan-embed-text-v2:0', { contextWindow: 8_192, maxOutputTokens: 0, price: usd(0.02, 0), modality: 'embedding', dimensions: 1024 }],

      // --- Google ------------------------------------------------------------
      ['google/gemini-2.5-flash', { contextWindow: 1_048_576, maxOutputTokens: 65_536, price: usd(0.3, 2.5) }],
      ['google/text-embedding-004', { contextWindow: 2_048, maxOutputTokens: 0, price: usd(0, 0), modality: 'embedding', dimensions: 768 }],
      ['vertex/gemini-2.5-flash', { contextWindow: 1_048_576, maxOutputTokens: 65_536, price: usd(0.3, 2.5) }],

      // --- Others ------------------------------------------------------------
      ['mistral/mistral-large-latest', { contextWindow: 131_072, maxOutputTokens: 8_192, price: usd(2, 6) }],
      ['groq/llama-3.3-70b-versatile', { contextWindow: 131_072, maxOutputTokens: 32_768, price: usd(0.59, 0.79) }],
      ['cohere/command-r-plus', { contextWindow: 128_000, maxOutputTokens: 4_096, price: usd(2.5, 10) }],
      ['azure/gpt-4o', { contextWindow: 128_000, maxOutputTokens: 16_384, price: usd(2.5, 10) }],
    ] as const
  ).map(([id, rest]) => {
    const entry = {
      id,
      provider: id.split('/')[0] as string,
      supportsStreaming: true,
      supportsSystemPrompt: true,
      modality: 'chat',
      dimensions: null,
      ...rest,
    } as CatalogEntry;
    return [id, entry];
  }),
);

export function lookupModel(id: string): CatalogEntry | null {
  return MODEL_CATALOG[id] ?? null;
}

export function listModels(filter: { modality?: CatalogEntry['modality']; provider?: string } = {}): CatalogEntry[] {
  return Object.values(MODEL_CATALOG).filter(
    (entry) =>
      (filter.modality === undefined || entry.modality === filter.modality) &&
      (filter.provider === undefined || entry.provider === filter.provider),
  );
}

/** True when the id is in the catalogue, i.e. we can reason about its cost. */
export function isKnownModel(id: string): boolean {
  return lookupModel(id) !== null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens?: number;
  /** Providers that bill cached context separately report it here. */
  cachedInputTokens?: number;
}

export interface CostEstimate {
  usd: number;
  /** `false` when the model is not in the catalogue and the number is a guess. */
  exact: boolean;
}

/**
 * Estimates the USD cost of a call.
 *
 * Returns `null` rather than `0` for an unknown model, so a caller cannot
 * confuse "this is free" with "we do not know what this costs".
 */
export function estimateCost(
  model: string,
  usage: TokenUsage,
  /** Overrides the catalogue price, e.g. a tenant's negotiated rate. */
  priceOverride?: ModelPrice | null,
): CostEstimate | null {
  const price = priceOverride ?? lookupModel(model)?.price ?? null;
  if (!price) return null;

  const cached = usage.cachedInputTokens ?? 0;
  // Cached input is billed at a fraction of the input rate by every provider
  // that supports it; 10% is the common published figure.
  const billableInput = Math.max(0, usage.inputTokens - cached);

  const usd =
    (billableInput / 1_000_000) * price.inputPerMillion +
    (cached / 1_000_000) * price.inputPerMillion * 0.1 +
    ((usage.outputTokens ?? 0) / 1_000_000) * price.outputPerMillion;

  return { usd: roundUsd(usd), exact: true };
}

/**
 * Pre-flight cost ceiling for a request that has not run yet.
 *
 * Uses the model's `maxOutputTokens` as the output assumption, which is
 * deliberately pessimistic: the point is an upper bound the guardrail can trust,
 * not a prediction.
 */
export function estimateMaxCost(
  model: string,
  inputTokens: number,
  priceOverride?: ModelPrice | null,
): CostEstimate | null {
  const entry = lookupModel(model);
  const price = priceOverride ?? entry?.price ?? null;
  if (!price) return null;

  const outputTokens = entry?.maxOutputTokens ?? 4_096;
  return estimateCost(model, { inputTokens, outputTokens }, price);
}

/** Rounds to 6 decimal places — a microdollar, well below any real charge. */
export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Formats a cost for a UI.
 *
 * Precision follows magnitude, because a fixed 2 or 4 decimals renders a real
 * charge as a bare `$0.0000`, which reads as a bug to a user and as "free" to a
 * billing report. Six decimals is a microdollar, comfortably below any amount a
 * provider would actually charge.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '$0.00';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 0.01) return `${sign}$${abs.toFixed(2)}`;
  if (abs >= 0.0001) return `${sign}$${abs.toFixed(4)}`;
  return `${sign}$${abs.toFixed(6)}`;
}
