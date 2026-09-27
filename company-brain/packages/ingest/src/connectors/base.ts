import { createLogger, getEnv } from '@company-brain/core';
import type { FetchedResource } from '../types';

const log = createLogger('ingest.http');

/**
 * Connector framework.
 *
 * A connector answers one question: given a source row, what documents exist and
 * what are their bytes? Everything downstream — parsing, chunking, embedding,
 * indexing — is connector-agnostic, so adding a source means implementing
 * `list` and `fetch` and nothing else.
 */
export interface Connector {
  readonly sourceType: string;
  /**
   * Enumerates the documents currently present in the source.
   *
   * Implementations must be incremental-friendly: when `cursor` is supplied,
   * return only what changed since then.
   */
  list(options?: { cursor?: string; limit?: number }): Promise<ListResult>;
  /** Fetches one document's bytes and metadata. */
  fetch(externalId: string): Promise<FetchedResource>;
  /** Opaque token to pass to the next `list` call. */
  cursor?(): Promise<string | undefined>;
  /** Releases connectors (revoke tokens, close pools). */
  close?(): Promise<void>;
}

export interface ListResult {
  items: FetchedResource[];
  nextCursor?: string;
}

export class ConnectorError extends Error {
  override readonly name = 'ConnectorError';

  constructor(
    message: string,
    readonly sourceType: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface HttpOptions {
  /** Aborts the request; the worker passes its shutdown signal through. */
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string | Uint8Array;
}

/**
 * `fetch` with a timeout, a default User-Agent, and retries on transient
 * failures.
 *
 * Retries 429/408 and 5xx with backoff, and honours `Retry-After`. It does
 * *not* retry 4xx other than those: a 404 means the document is genuinely gone
 * and retrying wastes the job's attempt budget.
 */
export async function httpFetch(url: string, options: HttpOptions = {}): Promise<Response> {
  const env = getEnv();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRetries = 3;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': env.CRAWL_USER_AGENT,
          accept: '*/*',
          ...options.headers,
        },
      });

      if (response.ok) return response;

      const retryable = response.status === 429 || response.status === 408 || response.status >= 500;
      if (!retryable || attempt === maxRetries) {
        throw new ConnectorError(
          `${response.status} ${response.statusText} for ${url}`,
          'http',
        );
      }

      const retryAfter = Number(response.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2 ** attempt * 500;
      log.debug('http.retry', 'retrying after a transient status', {
        url,
        status: response.status,
        attempt,
        waitMs: wait,
      });
      await sleep(wait, options.signal);
    } catch (error) {
      // A caller-initiated abort must not be retried.
      if (options.signal?.aborted) throw error;
      lastError = error;
      if (attempt === maxRetries) break;
      await sleep(2 ** attempt * 500, options.signal);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  throw new ConnectorError(
    `failed to fetch ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    'http',
    lastError,
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });
}
