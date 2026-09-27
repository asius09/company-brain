/**
 * Every JSON response from the API uses one envelope so clients can branch on
 * `success` instead of sniffing status codes.
 *
 *   { success: true,  data: T,    message?: string, meta?: {...} }
 *   { success: false, error: { code, message, details? }, meta?: {...} }
 */

export interface ResponseMeta {
  requestId?: string;
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}

export interface SuccessResponse<T> {
  success: true;
  data: T;
  message?: string;
  meta?: ResponseMeta;
}

export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
  context?: Record<string, unknown>;
}

export interface ErrorResponse {
  success: false;
  error: ErrorBody;
  meta?: ResponseMeta;
}

export function ok<T>(data: T, options: { message?: string; meta?: ResponseMeta } = {}): SuccessResponse<T> {
  return {
    success: true,
    data,
    ...(options.message ? { message: options.message } : {}),
    ...(options.meta ? { meta: options.meta } : {}),
  };
}

export function created<T>(data: T, message?: string): SuccessResponse<T> {
  return ok(data, message ? { message } : {});
}

export function fail(
  code: string,
  message: string,
  options: { details?: unknown; context?: Record<string, unknown>; meta?: ResponseMeta } = {},
): ErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      ...(options.details !== undefined ? { details: options.details } : {}),
      ...(options.context ? { context: options.context } : {}),
    },
    ...(options.meta ? { meta: options.meta } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                 */
/* -------------------------------------------------------------------------- */

export interface PageRequest {
  page: number;
  limit: number;
  offset: number;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** Normalises `?page=&limit=` into a `PageRequest`, clamping to sane bounds. */
export function parsePagination(input: {
  page?: number | string | null;
  limit?: number | string | null;
}): PageRequest {
  const rawPage = Number(input.page ?? 1);
  const rawLimit = Number(input.limit ?? DEFAULT_LIMIT);

  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT;

  return { page, limit, offset: (page - 1) * limit };
}

export function paginated<T>(
  items: T[],
  total: number,
  page: PageRequest,
  extra: ResponseMeta = {},
): SuccessResponse<T[]> {
  const totalPages = Math.max(1, Math.ceil(total / page.limit));
  return ok(items, {
    meta: {
      page: page.page,
      limit: page.limit,
      total,
      totalPages,
      hasMore: page.page < totalPages,
      ...extra,
    },
  });
}
