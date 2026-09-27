import { createLogger, decrypt, getEnv, tryDecryptJson } from '@company-brain/core';
import { aiProviderConfigs, withTenant, type AiProviderConfig } from '@company-brain/db';
import { and, desc, eq } from 'drizzle-orm';
import { assertUsable, type ResolvedProvider } from './resolve';

const log = createLogger('ai.credentials');

export interface ResolveOptions {
  /** Preferred capability, used to pick a config that actually offers it. */
  capability?: 'chat' | 'embedding';
  /** Return every usable config, most-preferred first. */
  all?: boolean;
}

/**
 * Loads the provider configuration a tenant should use.
 *
 * Order of preference:
 *  1. the tenant's enabled `isDefault` config;
 *  2. any other enabled tenant config that fits the capability;
 *  3. the platform default from the environment.
 *
 * Reads run under `withTenant`, so RLS means a caller physically cannot load
 * another tenant's credentials even if the organization id is attacker-supplied.
 */
export async function resolveProviderConfig(
  organizationId: string,
  options: ResolveOptions = {},
): Promise<ResolvedProvider[]> {
  const { capability = 'chat' } = options;

  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(aiProviderConfigs)
      .where(
        and(
          eq(aiProviderConfigs.organizationId, organizationId),
          eq(aiProviderConfigs.isEnabled, true),
        ),
      )
      .orderBy(desc(aiProviderConfigs.isDefault), desc(aiProviderConfigs.updatedAt)),
  );

  const usable = rows
    .map((row) => toResolved(row))
    // A config without a key for the requested capability is not an error, it is
    // just not a candidate for this call.
    .filter((provider) => fits(provider, capability));

  if (usable.length > 0) {
    if (options.all) return usable;
    return [usable[0] as ResolvedProvider];
  }

  const platform = platformDefault(capability);
  if (options.all) return platform ? [platform] : [];
  if (!platform) {
    throw new Error(
      `no AI provider configured for organization ${organizationId} and no platform default is set`,
    );
  }
  return [platform];
}

/** Convenience wrapper returning exactly one provider. */
export async function resolveProvider(
  organizationId: string,
  options: ResolveOptions = {},
): Promise<ResolvedProvider> {
  const providers = await resolveProviderConfig(organizationId, options);
  const provider = providers[0];
  if (!provider) {
    throw new Error(`no usable AI provider for organization ${organizationId}`);
  }
  return provider;
}

function fits(provider: ResolvedProvider, capability: 'chat' | 'embedding'): boolean {
  const isUsable = (() => {
    try {
      assertUsable(provider);
      return true;
    } catch {
      return false;
    }
  })();
  if (!isUsable) return false;
  return capability === 'chat' ? Boolean(provider.chatModel) : Boolean(provider.embeddingModel);
}

function toResolved(row: AiProviderConfig): ResolvedProvider {
  const extra = tryDecryptJson<Record<string, string>>(row.encryptedExtra) ?? {};

  return {
    kind: row.provider,
    label: row.label,
    baseUrl: row.baseUrl ?? undefined,
    region: row.region ?? undefined,
    // Decryption is the whole point of storing it encrypted; a row that fails to
    // decrypt is surfaced as "no key" rather than crashing the whole request.
    apiKey: row.encryptedApiKey ? safeDecrypt(row.encryptedApiKey) : undefined,
    extra,
    settings: row.settings,
    chatModel: row.chatModel ?? undefined,
    embeddingModel: row.embeddingModel ?? undefined,
    source: 'tenant',
    configId: row.id,
  };
}

function safeDecrypt(payload: string): string | undefined {
  try {
    return decrypt(payload);
  } catch (error) {
    log.error('credentials.decrypt_failed', 'stored credentials could not be decrypted', {
      // The payload is deliberately not logged: it is ciphertext that would
      // otherwise sit in logs forever after a key rotation.
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * The platform's own credentials, used when a tenant has not configured any.
 *
 * Kept last so a tenant's BYOK always wins: a tenant that pays for their own
 * tokens should never silently be billed to the platform account, and one that
 * has configured a provider should not fall back if it is temporarily broken.
 */
export function platformDefault(capability: 'chat' | 'embedding' = 'chat'): ResolvedProvider | null {
  const env = getEnv();
  if (!env.PLATFORM_AI_API_KEY && env.PLATFORM_AI_PROVIDER !== 'ollama') return null;

  return {
    kind: env.PLATFORM_AI_PROVIDER,
    label: `Platform default (${env.PLATFORM_AI_PROVIDER})`,
    apiKey: env.PLATFORM_AI_API_KEY,
    baseUrl: env.PLATFORM_AI_BASE_URL,
    region: env.PLATFORM_AI_REGION,
    extra: {},
    settings: {},
    source: 'platform',
  };
}
