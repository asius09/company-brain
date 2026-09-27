import { desc, eq } from 'drizzle-orm';

import { badRequest, forbidden, notFound, unauthenticated } from '@company-brain/core';
import type { Resource } from '@company-brain/core/permissions';
import { db, member, organization as organizationTable, type OrganizationSettings } from '@company-brain/db';

import { can, grantsFor, type Grants } from './access';
import type { Auth } from './server';

export interface MembershipSummary {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  role: string;
  plan: string;
}

export interface Actor {
  userId: string;
  sessionId: string;
  email: string;
  name: string;
  image: string | null;
  emailVerified: boolean;
  /** Better Auth account role (`user` | `admin`) — platform-wide, not tenant-scoped. */
  platformRole: string;
  /** Org the request is scoped to, from `session.activeOrganizationId`. */
  organizationId: string | null;
  organizationName: string | null;
  organizationSlug: string | null;
  plan: string;
  settings: OrganizationSettings;
  /** Org role: `owner` | `admin` | `member` | `viewer`. */
  role: string | null;
  twoFactorEnabled: boolean;
  grants: Grants;
  /** All workspaces this user belongs to — powers the org switcher. */
  memberships: MembershipSummary[];
}

export interface RequestLike {
  headers: Headers;
}

function listMemberships(userId: string): Promise<MembershipSummary[]> {
  return db()
    .select({
      id: organizationTable.id,
      name: organizationTable.name,
      slug: organizationTable.slug,
      logo: organizationTable.logo,
      role: member.role,
      plan: organizationTable.plan,
    })
    .from(member)
    .innerJoin(organizationTable, eq(member.organizationId, organizationTable.id))
    .where(eq(member.userId, userId))
    .orderBy(desc(member.createdAt))
    .then((rows) => rows as MembershipSummary[]);
}

/**
 * Resolves the caller from a request and loads their workspace memberships.
 *
 * The `bearer()` plugin means this works with a session cookie (the Vite SPA)
 * or an `Authorization: Bearer` header (mobile, server-to-server) without the
 * API branching on transport.
 */
/**
 * Better Auth merges plugin field additions into its endpoint return types only
 * for a directly-typed `betterAuth(...)` result. Our instance comes from a
 * factory, so these two plugin-added fields are read through a narrow cast
 * rather than widening the whole config's inferred type.
 */
type SessionWithOrg = { activeOrganizationId?: string | null };
type UserWithRole = { role?: string | null; twoFactorEnabled?: boolean | null };

export async function requireActor(auth: Auth, request: RequestLike): Promise<Actor> {
  const result = await auth.api.getSession({ headers: request.headers });
  if (!result?.user || !result.session) throw unauthenticated();

  const { user, session } = result;
  const memberships = await listMemberships(user.id);

  const activeId = (session as SessionWithOrg).activeOrganizationId ?? null;
  const active = activeId ? memberships.find((m) => m.id === activeId) ?? null : null;
  const role = active?.role ?? null;
  const enriched = user as typeof user & UserWithRole;

  return {
    userId: user.id,
    sessionId: session.id,
    email: user.email,
    name: user.name,
    image: user.image ?? null,
    emailVerified: user.emailVerified,
    platformRole: enriched.role ?? 'user',
    organizationId: active?.id ?? null,
    organizationName: active?.name ?? null,
    organizationSlug: active?.slug ?? null,
    plan: active?.plan ?? 'free',
    settings: active ? ((await loadSettings(active.id)) as OrganizationSettings) : {},
    role,
    twoFactorEnabled: Boolean(enriched.twoFactorEnabled),
    grants: grantsFor(role),
    memberships,
  };
}

let settingsCache = new Map<string, { settings: OrganizationSettings; at: number }>();
const SETTINGS_TTL_MS = 5_000;

/**
 * Short TTL cache because org settings are read on every chat request but change
 * rarely; a few seconds of staleness avoids a query per message without making
 * an admin's change feel ignored.
 */
async function loadSettings(organizationId: string): Promise<OrganizationSettings> {
  const hit = settingsCache.get(organizationId);
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.settings;

  const [row] = await db()
    .select({ settings: organizationTable.settings })
    .from(organizationTable)
    .where(eq(organizationTable.id, organizationId))
    .limit(1);

  const settings = (row?.settings ?? {}) as OrganizationSettings;
  settingsCache.set(organizationId, { settings, at: Date.now() });
  return settings;
}

/** Drops the cached org settings — call after a settings update. */
export function invalidateSettings(organizationId: string): void {
  settingsCache.delete(organizationId);
}

/**
 * The caller is authenticated but has not chosen a workspace yet. This is a
 * 400, not a 401 — retrying the same request will not help until the client
 * calls `setActiveOrganization`.
 */
export function requireOrganization(actor: Actor): string {
  if (!actor.organizationId) {
    throw badRequest('Select a workspace first', { code: 'NO_ACTIVE_ORGANIZATION' });
  }
  return actor.organizationId;
}

/** Asserts the actor's org role grants `resource:action`. */
export function requirePermission(actor: Actor, resource: Resource, action: string): string {
  const organizationId = requireOrganization(actor);
  if (!can(actor.role, resource, action)) {
    throw forbidden(`Your role (${actor.role ?? 'none'}) cannot ${resource}:${action}`);
  }
  return organizationId;
}

export function requireAnyRole(actor: Actor, ...allowed: string[]): string {
  const organizationId = requireOrganization(actor);
  if (!actor.role || !allowed.includes(actor.role)) {
    throw forbidden(`Requires one of: ${allowed.join(', ')}`);
  }
  return organizationId;
}

/** Platform admins may act on any tenant; useful for support tooling. */
export function requirePlatformAdmin(actor: Actor): void {
  if (actor.platformRole !== 'admin') throw forbidden('Requires a platform administrator');
}

/** Throws unless `memberships` contains `organizationId`. */
export function assertMembership(actor: Actor, organizationId: string): void {
  if (!actor.memberships.some((m) => m.id === organizationId)) {
    throw notFound('Workspace');
  }
}

/** True when the user belongs to every one of `organizationIds`. */
export function hasAllMemberships(actor: Actor, organizationIds: string[]): boolean {
  const owned = new Set(actor.memberships.map((m) => m.id));
  return organizationIds.every((id) => owned.has(id));
}
