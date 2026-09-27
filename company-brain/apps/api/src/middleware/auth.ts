/**
 * Session authentication.
 *
 * Better Auth owns sessions; this middleware only turns a request into an
 * `Actor` and pins the tenant. Every database call made downstream runs inside
 * `withTenant(actor.organizationId)`, so RLS is a second line of defence rather
 * than the only one.
 */
import type { Context, Next } from 'hono';
import { createLogger, unauthenticated, type Resource } from '@company-brain/core';
import { createAuth, requireActor, requirePermission as checkPermission, type Actor } from '@company-brain/auth';

declare module 'hono' {
  interface ContextVariableMap {
    actor: Actor;
  }
}

const log = createLogger('api.auth');

/** Lazily built so importing this module does not open a pool during tests. */
let authInstance: ReturnType<typeof createAuth> | undefined;
export function auth(): ReturnType<typeof createAuth> {
  authInstance ??= createAuth();
  return authInstance;
}

/** Rejects anything without a valid session, before any handler runs. */
export async function requireSession(c: Context, next: Next): Promise<void> {
  const actor = await requireActor(auth(), c.req.raw);
  c.set('actor', actor);
  await next();
}

/**
 * Requires an active organization.
 *
 * Separate from `requireSession` because a user can legitimately be signed in
 * with no organization selected (for example immediately after signup), and
 * only tenant-scoped routes care.
 */
export async function requireTenant(c: Context, next: Next): Promise<void> {
  const actor = c.get('actor');
  if (!actor?.organizationId) {
    throw unauthenticated('Select an organization first');
  }
  await next();
}

/**
 * Coarse permission gate.
 *
 * Applied as middleware so a missing grant fails before the handler runs and
 * before any row is read. Handlers still check per-record ownership, because a
 * member may have `document:read` and must not then read another tenant's
 * document.
 */
export function requirePermission(resource: Resource, action: string) {
  return async (c: Context, next: Next): Promise<void> => {
    const actor = c.get('actor');
    if (!actor?.organizationId) {
      throw unauthenticated('Select an organization first');
    }

    const organizationId = checkPermission(actor, resource, action);
    c.set('log', (c.get('log') ?? log).child({ organizationId }));
    await next();
  };
}
