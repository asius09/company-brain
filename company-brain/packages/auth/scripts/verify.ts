/**
 * End-to-end smoke test for the Better Auth wiring.
 *
 *   pnpm --filter @company-brain/auth verify
 *
 * Everything goes through `auth.handler` — the real fetch handler the API mounts
 * — rather than calling `auth.api.*` directly. That matters: server-side calls
 * skip cookie handling entirely, so a direct call would happily pass while the
 * browser flow was broken.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { createLogger, getEnv } from '@company-brain/core';
import { closePool, db, member, organization, sources, user, withSystemAccess, withTenant } from '@company-brain/db';

import { can, getAuth } from '../src/index';

const log = createLogger('auth:verify');
const RUN = randomUUID().slice(0, 8);
const EMAIL = `verify-${RUN}@example.test`;
const PASSWORD = 'correct-horse-battery-staple-42';
// Better Auth serves everything under `basePath`, which defaults to
// `/api/auth`; the API mounts `auth.handler` at exactly this prefix.
const BASE_PATH = '/api/auth';
const ORIGIN = new URL(getEnv().BETTER_AUTH_URL).origin;

let failures = 0;
const jar = new Map<string, string>();

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    log.info('pass', label);
    return;
  }
  failures += 1;
  log.error('fail', label, detail === undefined ? {} : { detail: String(JSON.stringify(detail) ?? '') });
}

function cookieHeader(): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Cookie jar, so each step behaves like a browser that kept its session. */
function absorbCookies(response: Response): void {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    if (!pair) continue;
    const index = pair.indexOf('=');
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value === '' || /expires=thu, 01 jan 1970/i.test(raw)) jar.delete(name);
    else jar.set(name, value);
  }
}

interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  path: string,
  init: RequestInit & { json?: unknown; auth?: boolean } = {},
): Promise<ApiResult<T>> {
  const headers = new Headers(init.headers);
  headers.set('origin', ORIGIN);

  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
  }

  // Better Auth's mutating endpoints are all POST. Derive it from the presence
  // of a body so a call can never end up a bodied GET.
  const hasBody = init.json !== undefined || typeof init.body === 'string';
  const method = init.method ?? (hasBody ? 'POST' : 'GET');
  const body = init.json !== undefined ? JSON.stringify(init.json) : (init.body as string | undefined);

  if (init.auth !== false) {
    const cookie = cookieHeader();
    if (cookie) headers.set('cookie', cookie);
  }

  const response = await auth.handler(
    new Request(`${ORIGIN}${BASE_PATH}${path}`, { method, body: hasBody ? body : undefined, headers }),
  );
  absorbCookies(response);

  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    /* keep the raw text */
  }
  return { status: response.status, body: parsed as T };
}

const auth = getAuth();

async function main() {
  log.info('verify.start', 'verifying auth wiring', { run: RUN });

  // Booting already triggered Better Auth's Drizzle schema check.

  // --- sign up -------------------------------------------------------------
  const signUp = await call<{ token: string; user: { id: string; email: string } }>('/sign-up/email', {
    json: { email: EMAIL, password: PASSWORD, name: 'Verify Bot' },
  });
  check('sign-up succeeds', signUp.status === 200, signUp);
  check('sign-up returns a user', Boolean(signUp.body?.user?.id), signUp.body);
  check('sign-up sets a session cookie', jar.size > 0, [...jar.keys()]);
  const userId = signUp.body?.user?.id ?? '';

  // --- session resolves from the cookie -----------------------------------
  const session = await call<{ user: { email: string }; session: { id: string } }>('/get-session', {
    method: 'GET',
  });
  check('get-session resolves from cookie', session.body?.user?.email === EMAIL, session.body);
  check('session has an id', Boolean(session.body?.session?.id), session.body?.session);

  // --- bearer transport ----------------------------------------------------
  const token = signUp.body?.token;
  const bearer = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
  check('bearer token resolves a session', bearer?.user?.email === EMAIL, bearer?.user?.email);

  // --- organisations are the tenant boundary ------------------------------
  const created = await call<{ id: string; name: string; slug: string }>('/organization/create', {
    json: { name: `Verify Org ${RUN}`, slug: `verify-${RUN}` },
  });
  check('organization/create succeeds', created.status === 200 && Boolean(created.body?.id), created);
  const organizationId = created.body?.id ?? '';
  check('organization slug echoes back', created.body?.slug === `verify-${RUN}`, created.body);

  // --- access control ------------------------------------------------------
  const membership = await db()
    .select({ role: member.role })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);
  check('creator membership role is owner', membership[0]?.role === 'owner', membership);

  check('owner may create sources', can('owner', 'source', 'create'));
  check('owner may manage billing', can('owner', 'billing', 'manage'));
  check('owner may delete the org', can('owner', 'organization', 'delete'));
  check('admin may not manage billing', !can('admin', 'billing', 'manage'));
  check('admin may not delete the org', !can('admin', 'organization', 'delete'));
  check('member may create sources', can('member', 'source', 'create'));
  check('member may not delete sources', !can('member', 'source', 'delete'));
  check('member may read usage', can('member', 'usage', 'read'));
  check('viewer may not create sources', !can('viewer', 'source', 'create'));
  check('viewer may search', can('viewer', 'search', 'execute'));
  check('viewer may not chat', !can('viewer', 'chat', 'create'));
  check('unknown role grants nothing', !can('ghost', 'source', 'create'));
  check('undefined role grants nothing', !can(undefined, 'source', 'create'));

  // --- active organization switcher ---------------------------------------
  const setActive = await call<{ id: string }>('/organization/set-active', {
    json: { organizationId },
  });
  check('organization/set-active succeeds', setActive.status === 200, setActive);

  const afterSwitch = await call<{ session: { activeOrganizationId: string | null } }>('/get-session', {
    method: 'GET',
  });
  check(
    'session now carries activeOrganizationId',
    afterSwitch.body?.session?.activeOrganizationId === organizationId,
    afterSwitch.body?.session,
  );

  // --- additional fields are persisted, not dropped ------------------------
  const orgRow = await db()
    .select({ name: organization.name, plan: organization.plan, settings: organization.settings })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  check('organization row exists', orgRow.length === 1, orgRow);
  check('organization plan defaults to free', orgRow[0]?.plan === 'free', orgRow[0]?.plan);
  check(
    'organization settings default to {}',
    JSON.stringify(orgRow[0]?.settings ?? {}) === '{}',
    orgRow[0]?.settings,
  );

  // --- invitations ---------------------------------------------------------
  const invite = await call<{ id: string; email: string; role: string }>('/organization/invite-member', {
    json: { email: `invitee-${RUN}@example.test`, role: 'member' },
  });
  check('owner can invite a member', invite.status === 200 && Boolean(invite.body?.id), invite);
  check('invitation carries the role', invite.body?.role === 'member', invite.body);

  // --- tenant RLS ----------------------------------------------------------
  // Checked on `sources`, which is RLS-protected. Better Auth's own eight tables
  // (user/session/account/verification/organization/member/invitation/two_factor)
  // deliberately have RLS *disabled*: Better Auth must read them across tenants
  // to resolve a session and list a user's workspaces, and it applies its own
  // access control instead. The app's 12 tables are the ones the database
  // polices.
  await withSystemAccess(async (tx) => {
    await tx.insert(sources).values({
      id: `src-${RUN}`,
      organizationId,
      type: 'file',
      name: 'verify probe',
    });
  });

  const ownRows = await withTenant(organizationId, (tx) =>
    tx.select({ id: sources.id }).from(sources),
  );
  check('withTenant sees the tenant own rows', ownRows.length === 1, ownRows);

  const foreignRows = await withTenant('org-does-not-exist', (tx) =>
    tx.select({ id: sources.id }).from(sources),
  );
  check('withTenant hides other tenants', foreignRows.length === 0, foreignRows);

  // Fails closed: reading through the global client inside withTenant lands on a
  // different pooled connection that has no tenant stamp, so RLS must return
  // nothing rather than leaking every tenant's rows.
  const unscopedInside = await withTenant(organizationId, () =>
    db().select({ id: sources.id }).from(sources),
  );
  check('global client inside withTenant cannot read (fails closed)', unscopedInside.length === 0, unscopedInside);

  const noContextAtAll = await db().select({ id: sources.id }).from(sources);
  check('no tenant context reads nothing', noContextAtAll.length === 0, noContextAtAll);

  // --- sign out ------------------------------------------------------------
  const signOut = await call('/sign-out', { method: 'POST' });
  check('sign-out succeeds', signOut.status === 200, signOut);

  const afterSignOut = await call('/get-session', { method: 'GET' });
  check('session is gone after sign-out', afterSignOut.body?.user === null || afterSignOut.body?.user === undefined, afterSignOut.body);
}

main()
  .catch((error) => {
    failures += 1;
    log.error(
      'verify.crashed',
      'verify crashed',
      {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        status: (error as { status?: number }).status,
        body: (error as { body?: unknown }).body,
      },
    );
  })
  .finally(async () => {
    // Cascades from organization -> member/invitation and from user -> session,
    // so these two deletes fully undo the run even if a check failed midway.
    try {
      await withSystemAccess(async (tx) => {
        await tx.delete(organization).where(eq(organization.slug, `verify-${RUN}`));
        await tx.delete(user).where(eq(user.email, EMAIL));
        await tx.delete(user).where(eq(user.email, `invitee-${RUN}@example.test`));
      });
    } catch (error) {
      log.error('verify.cleanup_failed', 'could not remove verify rows', {}, error);
      failures += 1;
    }

    await closePool();
    log.info('verify.done', failures === 0 ? 'all checks passed' : `${failures} check(s) failed`, {
      failures,
    });
    process.exit(failures === 0 ? 0 : 1);
  });
