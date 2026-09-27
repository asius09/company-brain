import type { JobType, Visibility } from '@company-brain/core';

/**
 * Every queue payload is declared here so `enqueue` is checked at compile time:
 * enqueueing `source.sync` with a `chunk.embed` payload is a build error rather
 * than a runtime surprise three hours into an ingest.
 */
export interface JobPayloads {
  /** Pull new/changed content out of a connector and upsert documents. */
  'source.sync': {
    sourceId: string;
    /** `full` re-reads everything; `incremental` uses the source's etag/cursor. */
    mode?: 'full' | 'incremental';
    syncRunId?: string;
  };
  /** Tear down a connector: revoke its token, drop its local credentials. */
  'source.disconnect': { sourceId: string };
  /** Fetch, parse, chunk, embed and index one document. */
  'document.ingest': {
    documentId: string;
    sourceId: string;
    /** Re-embed existing chunks instead of re-parsing the original. */
    embedOnly?: boolean;
  };
  'document.reingest': { documentId: string; sourceId: string; reason?: string };
  'document.delete': { documentId: string; sourceId?: string };
  /** Embed chunks whose source content has not changed. */
  'chunk.embed': { documentId: string; chunkIds?: string[] };
  /** Periodic incremental re-sync of a still-connected source. */
  'source.schedule': { sourceId: string; intervalMinutes: number };
}

export type QueueJobType = keyof JobPayloads;
export type QueuePayload<T extends QueueJobType> = JobPayloads[T];

/** Default ACL stamped on newly created documents. */
export const DEFAULT_VISIBILITY: Visibility = 'tenant';

/** Anything a job handler may throw to control retry behaviour. */
export class PermanentJobError extends Error {
  override readonly name = 'PermanentJobError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Raised by handlers to ask for a specific delay instead of the default
 * exponential backoff, e.g. honouring a provider's `retry-after` header.
 */
export class DelayedJobError extends Error {
  override readonly name = 'DelayedJobError';

  constructor(
    message: string,
    readonly delayMs: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface HandlerContext<T extends QueueJobType = QueueJobType> {
  job: ClaimedJob;
  payload: JobPayloads[T];
  organizationId: string;
  signal: AbortSignal;
  /** Report 0-100 and push the lease out; call periodically during long work. */
  progress: (percent: number) => Promise<void>;
  /** Give up a slot early so a waiting job can start. */
  requeue: (reason: string) => Promise<never>;
}

export type JobHandler<T extends QueueJobType = QueueJobType> = (
  ctx: HandlerContext<T>,
) => Promise<void>;

/** The shape `claimBatch` returns, decoupled from the Drizzle row type. */
export interface ClaimedJob {
  id: string;
  organizationId: string;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  priority: number;
  lockedBy: string | null;
  startedAt: Date | null;
  runAfter: Date;
  enqueuedAt: Date;
}
