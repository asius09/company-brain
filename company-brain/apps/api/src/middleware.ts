/**
 * Cross-cutting HTTP concerns: request id, structured logging, the error
 * envelope, and the panic guard.
 *
 * Every route returns through here, which is what makes the API's error shape
 * uniform: clients can rely on `{ success: false, error: { code, message } }`
 * without special-casing routes.
 */
import type { Context, Next } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { badRequest, generateId, isAppError, toAppError } from '@company-brain/core';
import { createLogger, type Logger } from '@company-brain/core';

const log: Logger = createLogger('api.http');

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    log: Logger;
  }
}

/**
 * Reads and parses a JSON request body, reporting a malformed one as a 400.
 *
 * `Request.json()` throws a bare `SyntaxError`, which `toAppError` would treat as
 * an unexpected fault and answer with a 500. A truncated body from a flaky proxy
 * is a client problem, and reporting it as a server fault both misleads the
 * caller and fills the 5xx dashboard with noise.
 */
export async function parseJson<T = unknown>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw badRequest('Request body is not valid JSON', { cause: error });
    }
    throw error;
  }
}

/** Tags the request with an id and logs its outcome. */
export async function requestContext(c: Context, next: Next): Promise<void> {
  const requestId = c.req.header('x-request-id') ?? generateId();
  c.set('requestId', requestId);
  c.set('log', log.child({ requestId }));
  c.header('x-request-id', requestId);

  const startedAt = performance.now();
  try {
    await next();
  } finally {
    // The status is only meaningful once the handler chain has settled.
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const level = c.res.status >= 500 ? 'error' : c.res.status >= 400 ? 'warn' : 'info';
    (log[level] as (event: string, message: string, meta?: Record<string, unknown>) => void)('http.request', `${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status}`, {
      requestId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs,
    });
  }
}

/**
 * Maps any thrown value onto the error envelope.
 *
 * `AppError.status` is the single source of truth for the code-to-status
 * mapping, so a new error code in `@company-brain/core` needs no change here.
 */
export async function errorHandler(error: unknown, c: Context): Promise<Response> {
  // Hono's own errors already carry a status and a client-safe message.
  if (typeof error === 'object' && error !== null && 'getResponse' in error) {
    const candidate = error as { getResponse: () => Response; status?: number };
    if (typeof candidate.getResponse === 'function') return candidate.getResponse();
  }

  const appError = toAppError(error);
  const status = appError.status;
  const logForRequest = c.get('log') ?? log;

  if (status >= 500) {
    // Server faults are ours, so log the cause. A stack for a 403 only buries
    // the real fault.
    logForRequest.error('http.error', appError.message, { code: appError.code }, appError.cause);
  } else {
    logForRequest.warn('http.rejected', appError.message, { code: appError.code });
  }

  // A 500 from something that was not an AppError must not leak internals: the
  // cause is in the log, findable by the request id echoed below.
  const message = status >= 500 && !isAppError(error) ? 'An unexpected error occurred' : appError.message;

  if (appError.retryAfter !== undefined) {
    c.header('retry-after', String(appError.retryAfter));
  }

  return c.json(
    {
      success: false,
      error: {
        code: appError.code,
        message,
        ...(appError.details !== undefined ? { details: appError.details } : {}),
      },
      meta: { requestId: c.get('requestId') },
    },
    status as ContentfulStatusCode,
  );
}
