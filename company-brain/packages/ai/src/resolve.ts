import { aiProviderUnconfigured, type ProviderKind } from '@company-brain/core';
import type { ProviderSettings } from '@company-brain/db';

/**
 * Everything needed to talk to one provider as one tenant.
 *
 * `apiKey` is already decrypted by the time it reaches here; nothing in this
 * module logs it, and `toLoggable` exists so an accidental `JSON.stringify` of a
 * config cannot leak it.
 */
export interface ResolvedProvider {
  kind: ProviderKind;
  baseUrl?: string;
  region?: string;
  apiKey?: string;
  /** Extra provider-specific secrets, already decrypted. */
  extra: Record<string, string>;
  settings: ProviderSettings;
  chatModel?: string;
  embeddingModel?: string;
  /** Where the credentials came from, for the UI and for audit logs. */
  source: 'tenant' | 'platform';
  configId?: string;
  label: string;
}

/** A redacted view safe to log or return from an API. */
export function toLoggable(provider: ResolvedProvider): Record<string, unknown> {
  return {
    kind: provider.kind,
    label: provider.label,
    source: provider.source,
    baseUrl: provider.baseUrl,
    region: provider.region,
    chatModel: provider.chatModel,
    embeddingModel: provider.embeddingModel,
    hasApiKey: Boolean(provider.apiKey),
    extraKeys: Object.keys(provider.extra),
  };
}

export type ProviderValidation = { valid: true } | { valid: false; reason: string };

/**
 * Per-provider requirements.
 *
 * Checked before any network call so a misconfigured tenant gets an actionable
 * message instead of a 401 from a provider three seconds later.
 */
export function validateProvider(provider: ResolvedProvider): ProviderValidation {
  const { kind, apiKey, region, settings } = provider;

  // Ollama and a local vLLM legitimately need no credentials.
  if (kind === 'ollama' || kind === 'custom') {
    if (!provider.baseUrl) {
      return { valid: false, reason: 'a base URL is required for this provider' };
    }
    return { valid: true };
  }

  if (kind === 'bedrock' && !region) {
    return { valid: false, reason: 'an AWS region is required for Bedrock (e.g. us-east-1)' };
  }

  if ((kind === 'vertex' || kind === 'google') && !settings.projectId) {
    return { valid: false, reason: 'a Google Cloud project id is required' };
  }

  if (kind === 'azure-openai' && !settings.deploymentName) {
    return { valid: false, reason: 'an Azure deployment name is required' };
  }

  if (!apiKey) {
    return { valid: false, reason: `no API key configured for ${kind}` };
  }

  return { valid: true };
}

/** Throws a typed, user-facing error when the provider is not usable. */
export function assertUsable(provider: ResolvedProvider): void {
  const result = validateProvider(provider);
  if (!result.valid) {
    throw aiProviderUnconfigured(`${provider.label}: ${result.reason}`, {
      provider: provider.kind,
      reason: result.reason,
    });
  }
}
