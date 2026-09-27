import { createAccessControl } from 'better-auth/plugins/access';
import { permissions, statement } from '@company-brain/core/permissions';
import type { Grants, Resource } from '@company-brain/core/permissions';

export type { Grants, Resource };

/**
 * Better Auth's access control is statement-shaped: `{ resource: ['action', ...] }`.
 * The shared definitions in `@company-brain/core` are boolean maps because that
 * is far easier to read and to diff, so they are converted here once — Better
 * Auth then stays the single evaluator, and this app never re-implements the
 * rules with a parallel `if` chain that could drift.
 */
const statements = Object.fromEntries(
  Object.entries(statement).map(([resource, actions]) => [resource, [...actions]]),
) as Record<string, string[]>;

export const ac = createAccessControl(statements);

function toStatements(grants: Grants): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(grants)) {
    const allowed = Object.entries(actions ?? {})
      .filter(([, granted]) => Boolean(granted))
      .map(([action]) => action);
    if (allowed.length > 0) result[resource] = allowed;
  }
  return result;
}

/** Passed to the `organization` plugin so its endpoints enforce the same matrix. */
export const organizationRoles = {
  owner: ac.newRole(toStatements(permissions.owner)),
  admin: ac.newRole(toStatements(permissions.admin)),
  member: ac.newRole(toStatements(permissions.member)),
  viewer: ac.newRole(toStatements(permissions.viewer)),
} as const;

export type OrganizationRole = keyof typeof organizationRoles;

export const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

const KNOWN_ROLES = Object.keys(organizationRoles) as OrganizationRole[];

export function isOrganizationRole(role: string | null | undefined): role is OrganizationRole {
  return typeof role === 'string' && (KNOWN_ROLES as string[]).includes(role);
}

/**
 * Delegates to Better Auth's own evaluator, so the API, Better Auth's
 * organisation endpoints, and the client-side `clientSideHasPermission` helper
 * can never disagree about what a role may do.
 */
export function can(role: string | null | undefined, resource: Resource, action: string): boolean {
  if (!isOrganizationRole(role)) return false;
  return organizationRoles[role].authorize({ [resource]: [action] }).success;
}

/** The permissions map for a role, in the boolean shape the UI wants. */
export function grantsFor(role: string | null | undefined): Grants {
  if (!isOrganizationRole(role)) return {};
  const out: Grants = {};
  for (const [resource, actions] of Object.entries(organizationRoles[role].statements)) {
    out[resource as Resource] = Object.fromEntries(actions.map((action) => [action, true]));
  }
  return out;
}

/** Roles allowed to see a resource at all — used to filter list endpoints. */
export function rolesWith(resource: Resource, action: string): OrganizationRole[] {
  return KNOWN_ROLES.filter((role) => can(role, resource, action));
}

export { statement, permissions };
