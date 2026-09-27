import pino from 'pino';
import { getEnv } from '../config/env';

export type LogMeta = Record<string, unknown>;

let root: pino.Logger | undefined;

function createRoot(): pino.Logger {
  const env = getEnv();
  const base: pino.LoggerOptions = {
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'apiKey',
        'api_key',
        'encryptedApiKey',
        'encrypted_api_key',
        'encryptedSecrets',
        'encrypted_secrets',
        'password',
        'passwordHash',
        'token',
        'accessToken',
        'refreshToken',
        '*.apiKey',
        '*.api_key',
        '*.token',
        '*.password',
      ],
      censor: '[redacted]',
    },
  };

  if (env.NODE_ENV !== 'production' && env.LOG_PRETTY) {
    try {
      return pino({
        ...base,
        transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
      });
    } catch (error) {
      // A transport target is resolved on a worker thread, so a missing
      // `pino-pretty` throws only here. Losing pretty output must never stop the
      // process from booting.
      // eslint-disable-next-line no-console
      console.warn('[logger] pino-pretty unavailable, falling back to JSON logs', error);
    }
  }

  return pino(base);
}

export function getLogger(): pino.Logger {
  root ??= createRoot();
  return root;
}

/**
 * Structured child logger. Always created through a named factory so every line
 * carries its subsystem, e.g. `createLogger('ingest:github')`.
 *
 * Conventions (match the house style): `event` is snake_case, `meta` is flat and
 * serialisable, and the `Error` — when present — is always the last argument.
 */
export function createLogger(subsystem: string, bindings: LogMeta = {}) {
  const logger = getLogger().child({ subsystem, ...bindings });

  return {
    child: (extra: LogMeta) => createLogger(subsystem, { ...bindings, ...extra }),

    trace: (event: string, message?: string, meta?: LogMeta) =>
      event ? logger.trace({ event, ...meta }, message ?? event) : logger.trace(message),
    debug: (event: string, message?: string, meta?: LogMeta) =>
      logger.debug({ event, ...meta }, message ?? event),
    info: (event: string, message?: string, meta?: LogMeta) =>
      logger.info({ event, ...meta }, message ?? event),
    warn: (event: string, message?: string, meta?: LogMeta, err?: unknown) =>
      err === undefined
        ? logger.warn({ event, ...meta }, message ?? event)
        : logger.warn({ event, ...meta, err: serializeError(err) }, message ?? event),
    error: (event: string, message?: string, meta?: LogMeta, err?: unknown) =>
      err === undefined
        ? logger.error({ event, ...meta }, message ?? event)
        : logger.error({ event, ...meta, err: serializeError(err) }, message ?? event),
    fatal: (event: string, message?: string, meta?: LogMeta, err?: unknown) =>
      err === undefined
        ? logger.fatal({ event, ...meta }, message ?? event)
        : logger.fatal({ event, ...meta, err: serializeError(err) }, message ?? event),
  };
}

export type Logger = ReturnType<typeof createLogger>;

/** Normalises thrown values so stack traces survive structured logging. */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(err.cause ? { cause: serializeError(err.cause) } : {}),
      ...(typeof err === 'object' && 'code' in err ? { code: (err as { code: unknown }).code } : {}),
    };
  }
  return { message: String(err) };
}
