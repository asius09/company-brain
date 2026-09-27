/**
 * Application error taxonomy. Every error that can reach a client is one of
 * these, which keeps status codes and machine-readable codes consistent.
 */

import { ZodError } from 'zod';

export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthenticated'
  | 'invalid_credentials'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'gone'
  | 'payload_too_large'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'unsupported_media_type'
  | 'ai_provider_error'
  | 'ai_provider_unconfigured'
  | 'ai_budget_exceeded'
  | 'source_error'
  | 'source_credentials_missing'
  | 'crawl_blocked'
  | 'job_failed'
  | 'internal_error'
  | 'service_unavailable';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthenticated: 401,
  invalid_credentials: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  payload_too_large: 413,
  rate_limited: 429,
  quota_exceeded: 429,
  unsupported_media_type: 415,
  ai_provider_error: 502,
  ai_provider_unconfigured: 424,
  ai_budget_exceeded: 402,
  source_error: 502,
  source_credentials_missing: 424,
  crawl_blocked: 451,
  job_failed: 500,
  internal_error: 500,
  service_unavailable: 503,
};

export interface AppErrorOptions {
  /** Field-level detail for 422s, or arbitrary context otherwise. */
  details?: unknown;
  cause?: unknown;
  /** Seconds to wait, surfaced as `Retry-After` for rate limits. */
  retryAfter?: number;
  [key: string]: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryAfter?: number;
  readonly context: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details;
    this.retryAfter = options.retryAfter;
    this.context = Object.fromEntries(
      Object.entries(options).filter(
        ([key]) => !['details', 'cause', 'retryAfter'].includes(key),
      ),
    );
    Error.captureStackTrace?.(this, AppError);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
      ...(Object.keys(this.context).length ? { context: this.context } : {}),
    };
  }
}

export const badRequest = (message: string, options?: AppErrorOptions) =>
  new AppError('bad_request', message, options);

export const validationFailed = (message: string, details?: unknown) =>
  new AppError('validation_failed', message, { details });

export const unauthenticated = (message = 'Authentication required') =>
  new AppError('unauthenticated', message);

export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError('forbidden', message);

export const notFound = (resource = 'Resource') =>
  new AppError('not_found', `${resource} not found`);

export const conflict = (message: string, options?: AppErrorOptions) =>
  new AppError('conflict', message, options);

export const rateLimited = (message = 'Rate limit exceeded', retryAfter?: number) =>
  new AppError('rate_limited', message, { retryAfter });

export const aiProviderUnconfigured = (message: string, options?: AppErrorOptions) =>
  new AppError('ai_provider_unconfigured', message, options);

export const aiProviderError = (message: string, options?: AppErrorOptions) =>
  new AppError('ai_provider_error', message, options);

export const aiBudgetExceeded = (limitUsd: number) =>
  new AppError('ai_budget_exceeded', `Request would exceed the ${limitUsd} USD budget limit`, {
    details: { limitUsd },
  });

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Wraps an unknown throwable so callers always have a `status` to work with. */
export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;

  // A schema rejection is the caller's mistake, not a server fault. Without this
  // it falls through to `internal_error`, so every bad field name, malformed id,
  // or out-of-range number reports a 500 and lands in the 5xx dashboard.
  if (err instanceof ZodError) {
    return new AppError('validation_failed', 'Request validation failed', {
      cause: err,
      details: { issues: describeIssues(err) },
    });
  }

  return new AppError('internal_error', 'An unexpected error occurred', { cause: err });
}

/**
 * Reduces a `ZodError` to field paths and messages.
 *
 * Only the paths and messages are kept: Zod issues can embed the offending
 * value, and those values are request payloads that may carry secrets.
 */
function describeIssues(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.slice(0, 10).map((issue) => ({
    path: issue.path.map(String).join('.') || '(body)',
    message: issue.message,
  }));
}
