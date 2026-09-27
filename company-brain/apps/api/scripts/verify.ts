/**
 * API verification.
 *
 * Exercises the real Hono app over HTTP against the real database and a real
 * Better Auth session, so the things most likely to be wrong — RLS scoping,
 * permission middleware, the error envelope, pagination shape — are checked in
 * the way a browser would hit them.
 *
 * Auth runs in-process: `app.request('/api/auth/...')` goes through the same
 * mounted handler the server uses, so no second process is needed.
 */
import { generateId, getEnv } from '@company-brain/core';
import {
  chunks as chunksTable,
  closePool,
  documents as documentsTable,
  jobs,
  member,
  organization,
  sources as sourcesTable,
  user,
  withSystemAccess,
} from '@company-brain/db';
import { eq, inArray } from 'drizzle-orm';
import { createApi } from '../src/app';

const RUN = process.env.RUN ?? generateId();
const PASSWORD = 'Correct-Horse-Battery-9';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}`, detail === undefined ? '' : ` ${JSON.stringify(detail)}`);
  }
}

interface Json {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  meta?: Record<string, unknown>;
}

interface Tenant {
  cookie: string;
  organizationId: string;
  email: string;
}

/** Everything the teardown has to remove, since ids are assigned by the auth server. */
const cleanup: { organizations: string[]; emails: string[]; sources: string[] } = {
  organizations: [],
  emails: [],
  sources: [],
};

async function main(): Promise<void> {
  const env = getEnv();
  const app = createApi();

  // Better Auth rejects state-changing calls without a trusted `Origin`, so the
  // test speaks as the web app would rather than as a bare HTTP client.
  const origin = env.CORS_ORIGINS[0];
  if (!origin) throw new Error('CORS_ORIGINS is empty');

  /* ---------------------------------------------------------------- helpers */

  const call = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: Json }> => {
    const response = await app.request(`http://localhost${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await response.text();
    let body: Json;
    try {
      body = JSON.parse(text) as Json;
    } catch {
      body = { success: false, error: { code: 'NON_JSON', message: text.slice(0, 200) } };
    }
    return { status: response.status, body };
  };

  const authCall = async (
    path: string,
    payload: unknown,
    cookie?: string,
  ): Promise<Response> =>
    app.request(`http://localhost/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(payload),
    });

  /**
   * Pulls just the session-token cookie off a Better Auth response.
   *
   * The `session_data` cookie is deliberately excluded: it caches the session
   * for five minutes, and a cached copy would keep reporting the organization
   * the session had when the cookie was minted. Dropping it forces the session
   * to be read from the database, which is the path worth verifying.
   */
  const sessionCookie = (response: Response): string => {
    const token = response.headers
      .getSetCookie()
      .find((c) => /(^|[._-])session_token=/.test(c) && !c.startsWith('better-auth.'));
    if (!token) throw new Error('no session token cookie returned');
    return token.split(';')[0];
  };

  /**
   * Creates a user and an organization the way the product does.
   *
   * Every step goes through Better Auth's own endpoints rather than writing rows
   * directly. Two reasons: ids are assigned by the auth server, and the cookie
   * cache means a row written behind Better Auth's back is never seen — which is
   * itself worth not depending on in a test of tenant scoping.
   */
  const createTenant = async (label: string): Promise<Tenant> => {
    const email = `${label}-${RUN}@example.test`;
    cleanup.emails.push(email);

    const signUp = await authCall('/sign-up/email', { email, password: PASSWORD, name: 'Verify' });
    if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status} ${await signUp.clone().text()}`);

    const signIn = await authCall('/sign-in/email', { email, password: PASSWORD });
    if (!signIn.ok) throw new Error(`sign-in failed: ${signIn.status} ${await signIn.clone().text()}`);
    const cookie = sessionCookie(signIn);

    const withCookie = async (path: string, payload: unknown): Promise<Json & { id?: string }> => {
      const response = await authCall(path, payload, cookie);
      const parsed = (await response.clone().json().catch(() => ({}))) as Json & {
        id?: string;
        organizationId?: string;
      };
      if (!response.ok) {
        throw new Error(`${path} failed: ${response.status} ${JSON.stringify(parsed)}`);
      }
      return parsed;
    };

    // `organization/create` is what makes this user an owner, which `set-active`
    // then requires.
    const created = await withCookie('/organization/create', { name: label, slug: label });
    const organizationId = created.id;
    if (!organizationId) throw new Error('organization/create returned no id');
    cleanup.organizations.push(organizationId);

    // `set-active` only reports success, so the activation is confirmed by
    // reading the session back: this is the value every API query scopes by, so
    // a stale cache here would invalidate every scoping assertion below.
    await withCookie('/organization/set-active', { organizationId });

    const sessionResponse = await app.request('http://localhost/api/auth/get-session', {
      headers: { cookie, origin },
    });
    const current = (await sessionResponse.json().catch(() => ({}))) as {
      session?: { activeOrganizationId?: string | null };
      user?: { id?: string };
    };
    if (current.session?.activeOrganizationId !== organizationId) {
      throw new Error(
        `session org is ${String(current.session?.activeOrganizationId)}, wanted ${organizationId}`,
      );
    }
    if (!current.user?.id) throw new Error('get-session returned no user');

    return { cookie, organizationId, email };
  };

  /* ------------------------------------------------------------------ setup */

  const a = await createTenant('api-verify-a');
  check('a user can sign up, create an org, and make it active', a.cookie.length > 0);

  const b = await createTenant('api-verify-b');
  check('a second tenant can be created', b.organizationId !== a.organizationId);

  const auth = { cookie: a.cookie };
  const authB = { cookie: b.cookie };

  /* -------------------------------------------------------- unauthenticated */

  const health = await call('/health');
  check('health is public', health.status === 200 && health.body.success, health.body);

  const anon = await call('/api/sources');
  check('sources rejects an anonymous request', anon.status === 401, { status: anon.status, body: anon.body });
  check(
    'the rejection uses the error envelope',
    anon.body.success === false && typeof anon.body.error?.code === 'string',
    anon.body,
  );

  // Authorization is applied per router rather than to all of /api, so routing
  // resolves first and a path that matches no router is a plain 404. That is the
  // honest answer: the app genuinely has no handler there.
  const anonBadRoute = await call('/api/nope');
  check('an unknown /api path is a 404 with or without a session', anonBadRoute.status === 404, {
    status: anonBadRoute.status,
  });

  /* ---------------------------------------------------------- authenticated */

  const list = await call('/api/sources', { headers: auth });
  check('sources lists for an authenticated caller', list.status === 200, list.body);
  check(
    'pagination meta is present',
    typeof list.body.meta?.total === 'number' && typeof list.body.meta?.limit === 'number',
    list.body.meta,
  );

  // A website source with no start URL must be refused at the edge, not queued
  // into a job that fails permanently.
  const noUrl = await call('/api/sources', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'broken', type: 'website', config: {} }),
  });
  check('a website source without startUrls is rejected', noUrl.status === 400, {
    status: noUrl.status,
    body: noUrl.body,
  });

  const badUrl = await call('/api/sources', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'bad scheme',
      type: 'website',
      config: { startUrls: ['file:///etc/passwd'] },
    }),
  });
  check('a non-http start URL is rejected', badUrl.status === 400, { status: badUrl.status, body: badUrl.body });

  const createdSource = await call('/api/sources', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: `site ${RUN}`,
      type: 'website',
      config: { startUrls: ['https://example.test/'] },
    }),
  });
  check('a valid source is created', createdSource.status === 201, {
    status: createdSource.status,
    body: createdSource.body,
  });

  const sourceId = (createdSource.body.data as { id?: string } | undefined)?.id;
  check('the created source has an id', typeof sourceId === 'string', sourceId);

  const duplicate = await call('/api/sources', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: `site ${RUN}`,
      type: 'website',
      config: { startUrls: ['https://example.test/'] },
    }),
  });
  check('a duplicate source name is a 409', duplicate.status === 409, {
    status: duplicate.status,
    body: duplicate.body,
  });

  const synced = await call(`/api/sources/${sourceId}/sync`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ mode: 'full' }),
  });
  check('a manual sync is accepted with 202', synced.status === 202, { status: synced.status, body: synced.body });

  const syncRuns = await call(`/api/sources/${sourceId}/sync-runs`, { headers: auth });
  check('sync runs are listable', syncRuns.status === 200, syncRuns.body);

  const missing = await call('/api/sources/does-not-exist', { headers: auth });
  check('an unknown source is a 404', missing.status === 404, { status: missing.status, body: missing.body });

  const documentList = await call('/api/documents', { headers: auth });
  check('documents lists for an authenticated caller', documentList.status === 200, documentList.body);

  const conversations = await call('/api/chat/conversations', { headers: auth });
  check('conversations list', conversations.status === 200, conversations.body);

  const search = await call('/api/search', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ query: 'anything' }),
  });
  check('search responds 200', search.status === 200, { status: search.status, body: search.body });
  check(
    'search reports the mode it actually used, so degraded search is visible',
    typeof search.body.meta?.mode === 'string',
    search.body.meta,
  );

  const badRoute = await call('/api/nope', { headers: auth });
  check('an unknown /api path is a 404 for an authenticated caller', badRoute.status === 404, {
    status: badRoute.status,
    body: badRoute.body,
  });

  /* ------------------------------------------------------------------- RLS */

  // The second organization must not see the first org's data, even though both
  // are querying the same tables through the same app.
  const otherList = await call('/api/sources', { headers: authB });
  const otherSources = (otherList.body.data ?? []) as unknown[];
  check("a second org sees none of the first org's sources", otherSources.length === 0, otherSources);

  const crossRead = await call(`/api/sources/${sourceId}`, { headers: authB });
  check('a cross-tenant source id is a 404, not a 403', crossRead.status === 404, {
    status: crossRead.status,
    body: crossRead.body,
  });

  const crossDelete = await call(`/api/sources/${sourceId}`, { method: 'DELETE', headers: authB });
  check('a cross-tenant delete is refused', crossDelete.status === 404, { status: crossDelete.status });

  const survivor = await call(`/api/sources/${sourceId}`, { headers: auth });
  check('the original source survived the cross-tenant delete attempt', survivor.status === 200, {
    status: survivor.status,
  });

  const crossSync = await call(`/api/sources/${sourceId}/sync`, {
    method: 'POST',
    headers: authB,
    body: JSON.stringify({ mode: 'full' }),
  });
  check('a cross-tenant sync is refused', crossSync.status === 404, { status: crossSync.status });

  // The queued jobs have to carry the right tenant, or the worker will run them
  // with the wrong RLS scope even though the API was correct.
  const queued = await withSystemAccess(async (tx) =>
    tx
      .select({ type: jobs.type, organizationId: jobs.organizationId })
      .from(jobs)
      .where(inArray(jobs.organizationId, [a.organizationId, b.organizationId]))
      .orderBy(jobs.type),
  );
  const queuedTypes = queued.map((job) => job.type);
  check('creating a source enqueued a sync job', queuedTypes.includes('source.sync'), queuedTypes);
  check(
    'manually syncing enqueued a second sync job',
    queuedTypes.filter((type) => type === 'source.sync').length === 2,
    queuedTypes,
  );
  check(
    'every job is scoped to the org that created it',
    queued.every((job) => job.organizationId === a.organizationId),
    queued,
  );

  const memberships = await withSystemAccess(async (tx) =>
    tx
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(inArray(member.organizationId, [a.organizationId, b.organizationId])),
  );
  check('each user is a member of exactly one org', memberships.length === 2, memberships);

  /* ------------------------------------------------------------------- ACL */

  // Search-level document visibility, which is separate from the tenant scope
  // that RLS already enforces: a private document must be invisible to a
  // colleague in the same organization.
  const owner = await withSystemAccess(async (tx) => {
    const rows = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, a.email))
      .limit(1);
    return rows[0]!.id;
  });

  const seeded = await withSystemAccess(async (tx) => {
    const [source] = await tx
      .insert(sourcesTable)
      .values({
        organizationId: a.organizationId,
        type: 'website',
        name: `acl-source-${RUN}`,
        createdBy: owner,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: sourcesTable.id });

    const rows = await tx
      .insert(documentsTable)
      .values([
        {
          organizationId: a.organizationId,
          sourceId: source.id,
          externalId: `acl-private-${RUN}`,
          title: 'Password rotation runbook',
          status: 'indexed' as const,
          visibility: 'private' as const,
          createdBy: owner,
          contentHash: `acl-private-hash-${RUN}`,
        },
        {
          organizationId: a.organizationId,
          sourceId: source.id,
          externalId: `acl-tenant-${RUN}`,
          title: 'Password rotation runbook',
          status: 'indexed' as const,
          visibility: 'tenant' as const,
          createdBy: owner,
          contentHash: `acl-tenant-hash-${RUN}`,
        },
      ])
      .returning({ id: documentsTable.id });

    const chunkRows = await tx
      .insert(chunksTable)
      .values([
        {
          organizationId: a.organizationId,
          documentId: rows[0].id,
          sourceId: source.id,
          ordinal: 0,
          content: 'The password rotation runbook says rotate credentials quarterly.',
          tokenCount: 9,
        },
        {
          organizationId: a.organizationId,
          documentId: rows[1].id,
          sourceId: source.id,
          ordinal: 0,
          content: 'The password rotation runbook says rotate credentials quarterly.',
          tokenCount: 9,
        },
      ])
      .returning({ documentId: chunksTable.documentId });

    return { sourceId: source.id, documentIds: rows.map((r) => r.id), chunkCount: chunkRows.length };
  });
  cleanup.sources.push(seeded.sourceId);
  check('ACL fixtures were seeded', seeded.chunkCount === 2, seeded);

  const ownerSearch = await call('/api/search', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ query: 'password rotation runbook', mode: 'keyword' }),
  });
  const ownerHits = (ownerSearch.body.data ?? []) as Array<{ documentId: string; chunkId: string }>;
  check('the owner sees both their private and tenant documents', ownerHits.length === 2, {
    status: ownerSearch.status,
    body: ownerSearch.body,
  });
  // Regression guard: a mis-cased row key silently produced the literal string
  // "undefined" for every id, which renders as a dead citation link rather than
  // as an error.
  check(
    'every hit carries real ids, not the string "undefined"',
    ownerHits.length > 0 && ownerHits.every((hit) => /^\w{8}-\w{4}/.test(hit.chunkId ?? '')),
    ownerHits,
  );

  // A second member of the same organization: same tenant, so RLS cannot help
  // and the only thing standing between them and a private document is the
  // visibility filter. The membership row is written directly because the
  // invitation round-trip is not what is under test here.
  const colleague = await createTenant('api-verify-colleague');
  const colleagueId = await withSystemAccess(async (tx) => {
    const rows = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, colleague.email))
      .limit(1);
    return rows[0]!.id;
  });
  await withSystemAccess((tx) =>
    tx
      .insert(member)
      .values({ organizationId: a.organizationId, userId: colleagueId, role: 'member' }),
  );
  // Switching the active org goes through the endpoint, which also refreshes
  // Better Auth's in-process session cache. Writing the column behind its back
  // would leave the cached session still pointing at the colleague's own org.
  const rescoped = await authCall('/organization/set-active', { organizationId: a.organizationId }, colleague.cookie);
  if (!rescoped.ok) {
    throw new Error(`set-active failed: ${rescoped.status} ${await rescoped.clone().text()}`);
  }
  const colleagueCookie = sessionCookie(rescoped);
  const colleagueSearch = await call('/api/search', {
    method: 'POST',
    headers: { cookie: colleagueCookie },
    body: JSON.stringify({ query: 'password rotation runbook', mode: 'keyword' }),
  });
  const colleagueHits = (colleagueSearch.body.data ?? []) as Array<{ documentId: string }>;
  const privateDocId = seeded.documentIds[0];
  const tenantDocId = seeded.documentIds[1];

  check(
    'a colleague cannot see a private document in the same org',
    colleagueHits.every((hit) => hit.documentId !== privateDocId),
    { hits: colleagueHits, privateDocId },
  );
  check(
    'a colleague still sees the tenant-visible document',
    colleagueHits.some((hit) => hit.documentId === tenantDocId),
    { hits: colleagueHits, tenantDocId },
  );

  // The list is a second, independent query over the same documents. It had no
  // visibility filter at all, so it leaked private titles; reading `data`
  // correctly matters here, because an empty result would make `.every()` pass
  // for the wrong reason.
  const colleagueList = await call('/api/documents', { headers: { cookie: colleagueCookie } });
  const listed = (colleagueList.body.data ?? []) as Array<{ id: string; visibility: string }>;
  check('the document list is not empty for a colleague', listed.length > 0, {
    status: colleagueList.status,
    body: colleagueList.body,
  });
  check(
    'the document list hides a private document from a colleague',
    listed.every((doc) => doc.id !== privateDocId),
    { listed, privateDocId },
  );
  check(
    'the document list still shows the tenant document',
    listed.some((doc) => doc.id === tenantDocId),
    { listed, tenantDocId },
  );

  const ownerList = await call('/api/documents', { headers: auth });
  const ownerListed = (ownerList.body.data ?? []) as Array<{ id: string }>;
  check(
    'the owner still sees their private document in the list',
    ownerListed.some((doc) => doc.id === privateDocId),
    { ownerListed, privateDocId },
  );

  /* ------------------------------------------------------------- validation */

  // Two distinct failures that are easy to conflate: unparseable JSON is a
  // malformed request, while a well-formed body that breaks a schema is
  // unprocessable. Both are the caller's fault, and neither is a 500.
  const badBody = await call('/api/sources', { method: 'POST', headers: auth, body: '{' });
  check('a malformed body is a 400, not a 500', badBody.status === 400, {
    status: badBody.status,
    body: badBody.body,
  });

  const badQuery = await call('/api/search', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ query: '' }),
  });
  check('a schema violation is a 422 with the field named', badQuery.status === 422, {
    status: badQuery.status,
    body: badQuery.body,
  });
  check(
    'a 422 points at the offending field',
    JSON.stringify(badQuery.body).includes('query'),
    badQuery.body,
  );
  check(
    'a validation failure does not echo the request body',
    !JSON.stringify(badQuery.body).includes(PASSWORD),
    badQuery.body,
  );

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('verify crashed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await withSystemAccess(async (tx) => {
        if (cleanup.organizations.length > 0) {
          await tx.delete(organization).where(inArray(organization.id, cleanup.organizations));
        }
        if (cleanup.sources.length > 0) {
          await tx.delete(sourcesTable).where(inArray(sourcesTable.id, cleanup.sources));
        }
        if (cleanup.emails.length > 0) {
          await tx.delete(user).where(inArray(user.email, cleanup.emails));
        }
      });
    } catch (error) {
      console.error('teardown failed:', error);
    }
    await closePool();
  });
