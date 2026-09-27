/**
 * Verification for pricing, guardrails, context trimming and provider
 * resolution.
 *
 * The guardrail tests matter most: they decide whether a request is allowed to
 * spend money, and the failure mode being tested for is "silently allows
 * something unaffordable".
 */
import { createLogger } from '@company-brain/core';
import {
  MODEL_CATALOG,
  assertUsable,
  checkCostGuardrails,
  estimateCost,
  estimateMaxCost,
  formatUsd,
  isKnownModel,
  listModels,
  lookupModel,
  resolveProvider,
  resolveProviderConfig,
  settleCost,
  toLoggable,
  trimToContext,
  validateProvider,
  type ResolvedProvider,
} from '../src/index';

const log = createLogger('ai:verify');
let failures = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    log.info('verify.pass', label, {});
  } else {
    failures += 1;
    log.error('verify.fail', label, { detail });
  }
}

const provider = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({
  kind: 'openai',
  label: 'Test',
  apiKey: 'sk-test',
  extra: {},
  settings: {},
  chatModel: 'gpt-4o-mini',
  source: 'tenant',
  ...over,
});

/* -------------------------------------------------------------------------- */
/* catalogue                                                                  */
/* -------------------------------------------------------------------------- */

function testCatalog(): void {
  check('the catalogue is non-empty', Object.keys(MODEL_CATALOG).length > 10, Object.keys(MODEL_CATALOG).length);
  check('every entry has a non-negative price', listModels().every((m) => m.price.inputPerMillion >= 0 && m.price.outputPerMillion >= 0));
  check('every entry has a positive context window', listModels().every((m) => m.contextWindow > 0));
  check('embedding models declare dimensions', listModels({ modality: 'embedding' }).every((m) => (m.dimensions ?? 0) > 0));
  check('chat models declare no dimensions', listModels({ modality: 'chat' }).every((m) => m.dimensions === null));
  check('ids are namespaced by provider', listModels().every((m) => m.id.startsWith(`${m.provider}/`)));
  check('an unknown model is not known', isKnownModel('nope/nope') === false);
  check('lookup of an unknown model is null', lookupModel('nope/nope') === null);
  check('filtering by provider works', listModels({ provider: 'openai' }).every((m) => m.provider === 'openai'));
  check('a configured embedding model is catalogued', lookupModel('openai/text-embedding-3-small')?.modality === 'embedding');
}

/* -------------------------------------------------------------------------- */
/* cost                                                                       */
/* -------------------------------------------------------------------------- */

function testCost(): void {
  const gpt = estimateCost('openai/gpt-4o', { inputTokens: 1_000_000, outputTokens: 0 });
  check('one million input tokens costs the input rate', gpt?.usd === 2.5, gpt);

  const both = estimateCost('openai/gpt-4o', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  check('input and output are charged separately', both?.usd === 12.5, both);

  const cached = estimateCost('openai/gpt-4o', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 900_000 });
  check('cached input is discounted', cached?.usd !== undefined && cached.usd < 2.5, cached);
  check('cached input is never charged as negative', (cached?.usd ?? -1) > 0);

  const overCached = estimateCost('openai/gpt-4o', { inputTokens: 100, cachedInputTokens: 500 });
  check('cached beyond input does not go negative', (overCached?.usd ?? -1) >= 0, overCached);

  check('an unknown model yields null, not zero', estimateCost('who/knows', { inputTokens: 1000 }) === null);
  check('an unknown model is not treated as free', estimateCost('who/knows', { inputTokens: 1_000_000_000 }) === null);

  const override = estimateCost('who/knows', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, { inputPerMillion: 1, outputPerMillion: 1 });
  check('a price override prices an uncatalogued model', override?.usd === 2, override);

  const max = estimateMaxCost('openai/gpt-4o', 1_000);
  check('the pre-flight estimate uses max output tokens', (max?.usd ?? 0) > estimateCost('openai/gpt-4o', { inputTokens: 1_000 })!.usd, max);
  check('zero formats as plain zero', formatUsd(0) === '$0.00');
  check('a sub-cent cost is not rounded away to a bare 0', formatUsd(0.0000004) === '$0.000000', formatUsd(0.0000004));
  check('tiny costs show six decimals', formatUsd(0.000012) === '$0.000012', formatUsd(0.000012));
  check('sub-cent costs show four decimals', formatUsd(0.0012) === '$0.0012', formatUsd(0.0012));
  check('larger costs show two decimals', formatUsd(3.5) === '$3.50');
  check('negative amounts keep their sign', formatUsd(-1.5) === '-$1.50', formatUsd(-1.5));
  check('non-finite amounts do not print NaN', formatUsd(Number.NaN) === '$0.00' && formatUsd(Number.POSITIVE_INFINITY) === '$0.00');

  const settled = settleCost('openai/gpt-4o', { inputTokens: 1000, outputTokens: 500 });
  check('settleCost matches estimateCost', settled.exact && settled.usd === estimateCost('openai/gpt-4o', { inputTokens: 1000, outputTokens: 500 })!.usd, settled);
  check('settling an unknown model reports inexact', settleCost('who/knows', { inputTokens: 100 }).exact === false);
}

/* -------------------------------------------------------------------------- */
/* guardrails                                                                 */
/* -------------------------------------------------------------------------- */

function testGuardrails(): void {
  const ok = checkCostGuardrails({ model: 'openai/gpt-4o-mini', inputTokens: 1_000 });
  check('a cheap request is allowed', ok.allowed === true, ok);

  const unpriced = checkCostGuardrails({ model: 'who/knows', inputTokens: 1_000 });
  check('an unpriced model is refused', unpriced.allowed === false, unpriced);
  check('the refusal explains itself', (unpriced.reason ?? '').includes('pricing'), unpriced.reason);

  const overRequest = checkCostGuardrails({
    model: 'openai/gpt-4o',
    inputTokens: 500_000,
    maxCostUsdPerRequest: 0.01,
  });
  check('a request over the per-request cap is refused', overRequest.allowed === false, overRequest);
  check('the refusal names the cap', (overRequest.reason ?? '').includes('per-request'), overRequest.reason);

  const underRequest = checkCostGuardrails({
    model: 'openai/gpt-4o-mini',
    inputTokens: 1_000,
    maxCostUsdPerRequest: 1,
  });
  check('a request under the per-request cap is allowed', underRequest.allowed === true, underRequest);

  const exhausted = checkCostGuardrails({
    model: 'openai/gpt-4o-mini',
    inputTokens: 1_000,
    spentUsdInPeriod: 20,
    maxCostUsdPerPeriod: 20,
  });
  check('an exhausted period budget is refused', exhausted.allowed === false, exhausted);

  const wouldOverflow = checkCostGuardrails({
    model: 'openai/gpt-4o',
    inputTokens: 400_000,
    spentUsdInPeriod: 19,
    maxCostUsdPerPeriod: 20,
  });
  check('a request that would overflow the period budget is refused', wouldOverflow.allowed === false, wouldOverflow);

  const fits = checkCostGuardrails({
    model: 'openai/gpt-4o-mini',
    inputTokens: 1_000,
    spentUsdInPeriod: 1,
    maxCostUsdPerPeriod: 20,
  });
  check('a request that fits the period budget is allowed', fits.allowed === true, fits);

  // The critical case: a huge context on an expensive model with no cap set.
  const unbounded = checkCostGuardrails({ model: 'anthropic/claude-opus-4-5', inputTokens: 150_000 });
  check('an uncapped expensive request reports a high ceiling', (unbounded.estimatedMaxUsd ?? 0) > 1, unbounded);
}

/* -------------------------------------------------------------------------- */
/* context trimming                                                           */
/* -------------------------------------------------------------------------- */

function testTrimming(): void {
  const turn = (role: 'system' | 'user' | 'assistant', words: number) => ({
    role,
    content: Array.from({ length: words }, (_, i) => `w${i}`).join(' '),
  });

  const short = trimToContext([turn('system', 10), turn('user', 50), turn('assistant', 50)], 'openai/gpt-4o');
  check('a short conversation is untouched', short.droppedTurns === 0, short);

  const long = Array.from({ length: 400 }, () => turn('user', 400));
  const trimmed = trimToContext([turn('system', 20), ...long], 'openai/gpt-4o', 1_024);
  check('a long conversation drops turns', trimmed.droppedTurns > 0, trimmed.droppedTurns);
  check('the system prompt is always kept', trimmed.turns[0]?.role === 'system', trimmed.turns[0]?.role);
  check('the most recent turn is kept', trimmed.turns.at(-1) === long.at(-1));
  check(
    'the result fits the context window',
    trimmed.inputTokens <= lookupModel('openai/gpt-4o')!.contextWindow - 1_024 + 50,
    { inputTokens: trimmed.inputTokens },
  );

  const huge = trimToContext([turn('system', 10), turn('user', 400_000)], 'openai/gpt-4o', 1_024);
  check('a single oversized turn is truncated, not dropped', huge.turns.some((t) => t.role === 'user'), huge.turns.length);
  check('truncation still respects the budget', huge.inputTokens <= lookupModel('openai/gpt-4o')!.contextWindow - 1_024 + 500, huge.inputTokens);

  const small = trimToContext([turn('user', 10_000)], 'unknown/model', 1_024);
  check('an unknown model falls back to a default context', small.turns.length > 0);
}

/* -------------------------------------------------------------------------- */
/* provider resolution                                                        */
/* -------------------------------------------------------------------------- */

function testResolution(): void {
  check('a provider with a key is valid', validateProvider(provider()).valid === true);
  check('a provider without a key is invalid', validateProvider(provider({ apiKey: undefined })).valid === false);
  check('the no-key reason is actionable', (validateProvider(provider({ apiKey: undefined })) as { reason: string }).reason.includes('API key'));
  check('bedrock without a region is invalid', validateProvider(provider({ kind: 'bedrock', apiKey: 'x' })).valid === false);
  check('bedrock with a region is valid', validateProvider(provider({ kind: 'bedrock', apiKey: 'x', region: 'us-east-1' })).valid === true);
  check('ollama needs no key', validateProvider(provider({ kind: 'ollama', apiKey: undefined, baseUrl: 'http://localhost:11434/v1' })).valid === true);
  check('ollama without a base URL is invalid', validateProvider(provider({ kind: 'ollama', apiKey: undefined })).valid === false);
  check('a custom provider needs a base URL', validateProvider(provider({ kind: 'custom', apiKey: undefined })).valid === false);
  check('vertex needs a project', validateProvider(provider({ kind: 'vertex', apiKey: 'x' })).valid === false);
  check('vertex with a project is valid', validateProvider(provider({ kind: 'vertex', apiKey: 'x', settings: { projectId: 'p' } })).valid === true);
  check('azure needs a deployment', validateProvider(provider({ kind: 'azure-openai', apiKey: 'x' })).valid === false);
  check('azure with a deployment is valid', validateProvider(provider({ kind: 'azure-openai', apiKey: 'x', settings: { deploymentName: 'd' } })).valid === true);

  let threw = false;
  try {
    assertUsable(provider({ apiKey: undefined }));
  } catch {
    threw = true;
  }
  check('assertUsable throws for an unusable provider', threw);

  // Secrets must never appear in a loggable view.
  const redacted = toLoggable(provider({ apiKey: 'sk-super-secret' }));
  check('toLoggable reports key presence, not the key', redacted.hasApiKey === true, redacted);
  check('toLoggable does not include the key', !JSON.stringify(redacted).includes('sk-super-secret'));
  check('toLoggable does not leak extra secrets', !JSON.stringify(toLoggable(provider({ extra: { secret: 'shh' } }))).includes('shh'));
}

testCatalog();
testCost();
testGuardrails();
testTrimming();
testResolution();

log.info('verify.done', failures === 0 ? 'all checks passed' : `${failures} check(s) failed`, { failures });
process.exit(failures === 0 ? 0 : 1);
