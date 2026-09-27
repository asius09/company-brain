import { aiBudgetExceeded, countTokens } from '@company-brain/core';
import { estimateCost, estimateMaxCost, lookupModel, type ModelPrice } from './pricing';

/**
 * Cost guardrails.
 *
 * Two limits are enforced, and they answer different questions:
 *
 *  - `maxCostUsdPerRequest` — "is this one call too expensive to make?" Checked
 *    *before* the call using a pessimistic estimate, because after the call the
 *    money is already spent.
 *  - `maxCostUsdPerPeriod` — "has this tenant spent its budget this month?"
 *    Checked against recorded usage, and necessarily *after* previous calls.
 *
 * The per-request check is the important one. An agent loop with a large context
 * and a large `max_tokens` can cost more in a single call than a month of normal
 * chat, so it is refused before it is issued.
 */

export interface GuardrailInput {
  model: string;
  inputTokens: number;
  /** Requested output cap, when the caller set one. */
  requestedOutputTokens?: number;
  /** Tenant's per-request ceiling in USD. */
  maxCostUsdPerRequest?: number;
  priceOverride?: ModelPrice | null;
  /** Tenant's budget already consumed in the current period, in USD. */
  spentUsdInPeriod?: number;
  maxCostUsdPerPeriod?: number;
}

export interface GuardrailResult {
  allowed: boolean;
  reason?: string;
  /** Upper bound on this call's cost. */
  estimatedMaxUsd: number | null;
  /** True when the model is uncatalogued, so the estimate is a guess. */
  estimateIsExact: boolean;
}

export function checkCostGuardrails(input: GuardrailInput): GuardrailResult {
  const { model, inputTokens } = input;
  const estimate = estimateMaxCost(model, inputTokens, input.priceOverride);
  const estimatedMaxUsd = estimate?.usd ?? null;
  const estimateIsExact = estimate?.exact ?? false;

  // An unknown model cannot be costed. The platform's own curated catalogue
  // covers every default, so reaching this means someone selected an
  // uncatalogued model — refuse rather than guess.
  if (!estimate) {
    return {
      allowed: false,
      reason: `no pricing information for model "${model}"; refusing to run an unpriced request`,
      estimatedMaxUsd: null,
      estimateIsExact: false,
    };
  }

  if (input.maxCostUsdPerRequest !== undefined && estimate.usd > input.maxCostUsdPerRequest) {
    return {
      allowed: false,
      reason: `estimated cost $${estimate.usd.toFixed(4)} exceeds the per-request limit of $${input.maxCostUsdPerRequest}`,
      estimatedMaxUsd: estimate.usd,
      estimateIsExact: estimate.exact,
    };
  }

  if (
    input.maxCostUsdPerPeriod !== undefined &&
    input.spentUsdInPeriod !== undefined
  ) {
    if (input.spentUsdInPeriod >= input.maxCostUsdPerPeriod) {
      return {
        allowed: false,
        reason: `monthly AI budget exhausted ($${input.spentUsdInPeriod.toFixed(2)} of $${input.maxCostUsdPerPeriod})`,
        estimatedMaxUsd: estimate.usd,
        estimateIsExact: estimate.exact,
      };
    }

    if (input.spentUsdInPeriod + estimate.usd > input.maxCostUsdPerPeriod) {
      return {
        allowed: false,
        reason: `this request would exceed the monthly budget ($${input.spentUsdInPeriod.toFixed(2)} spent, $${estimate.usd.toFixed(4)} needed, $${input.maxCostUsdPerPeriod} limit)`,
        estimatedMaxUsd: estimate.usd,
        estimateIsExact: estimate.exact,
      };
    }
  }

  return { allowed: true, estimatedMaxUsd: estimate.usd, estimateIsExact: estimate.exact };
}

/** `checkCostGuardrails` that throws a typed `aiBudgetExceeded` on refusal. */
export function assertWithinBudget(input: GuardrailInput): GuardrailResult {
  const result = checkCostGuardrails(input);
  if (!result.allowed) {
    throw aiBudgetExceeded(input.maxCostUsdPerRequest ?? input.maxCostUsdPerPeriod ?? 0);
  }
  return result;
}

/**
 * Fits a conversation into a model's context window.
 *
 * Drops the oldest turns first and always keeps the system prompt and the most
 * recent exchange, because those are what determine whether the answer is
 * correct and current. Returns the input token count it settled on so the caller
 * can cost the request before sending it.
 */
export interface ConversationTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TrimResult {
  turns: ConversationTurn[];
  inputTokens: number;
  droppedTurns: number;
}

export function trimToContext(
  turns: ConversationTurn[],
  model: string,
  reserveOutputTokens = 1_024,
): TrimResult {
  const entry = lookupModel(model);
  const contextWindow = entry?.contextWindow ?? 128_000;
  // Leave room for the answer; without this a full conversation would fit the
  // context and then fail at the provider.
  const budget = Math.max(1_024, contextWindow - reserveOutputTokens);

  const system = turns.filter((turn) => turn.role === 'system');
  const rest = turns.filter((turn) => turn.role !== 'system');

  const countAll = (list: ConversationTurn[]): number =>
    list.reduce((sum, turn) => sum + countTokens(`${turn.role}\n${turn.content}`), 0);

  let kept = [...rest];
  let inputTokens = countAll([...system, ...kept]);

  while (inputTokens > budget && kept.length > 1) {
    kept = kept.slice(1);
    inputTokens = countAll([...system, ...kept]);
  }

  // Even a single turn can exceed a small context; truncate its content rather
  // than failing outright.
  if (inputTokens > budget && kept.length === 1) {
    const last = kept[0] as ConversationTurn;
    const systemTokens = countAll(system);
    const room = Math.max(0, budget - systemTokens);
    const textBudget = Math.max(256, room);
    let content = last.content;
    while (countTokens(content) > textBudget && content.length > 256) {
      content = content.slice(0, Math.floor(content.length * 0.8));
    }
    kept = [{ ...last, content }];
    inputTokens = countAll([...system, ...kept]);
  }

  return {
    turns: [...system, ...kept],
    inputTokens,
    droppedTurns: rest.length - kept.length,
  };
}

/** Post-hoc cost of a completed call, for `usage_events`. */
export function settleCost(
  model: string,
  usage: { inputTokens: number; outputTokens?: number; cachedInputTokens?: number },
  priceOverride?: ModelPrice | null,
): { usd: number; exact: boolean } {
  const estimate = estimateCost(model, usage, priceOverride);
  return estimate ? { usd: estimate.usd, exact: estimate.exact } : { usd: 0, exact: false };
}
