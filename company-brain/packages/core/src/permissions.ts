/**
 * Single source of truth for authorisation.
 *
 * These statements/roles are handed to Better Auth's `createAccessControl` (see
 * `@company-brain/auth/permissions`) so that Better Auth's own organisation
 * endpoints and this app's API routes evaluate the exact same rules.
 */

export const statement = {
  /** Better Auth organisation lifecycle. */
  organization: ['create', 'read', 'update', 'delete'],
  member: ['create', 'read', 'update', 'delete'],
  invitation: ['create', 'read', 'update', 'delete', 'cancel'],
  team: ['create', 'read', 'update', 'delete'],
  ac: ['read', 'create', 'update', 'delete'],

  /** Knowledge sources. */
  source: ['create', 'read', 'update', 'delete', 'sync', 'manageCredentials'],

  /** Documents and chunks. */
  document: ['create', 'read', 'update', 'delete', 'reindex'],

  /** Retrieval + chat. */
  chat: ['create', 'read', 'delete'],
  search: ['execute'],

  /** Platform configuration. */
  aiProvider: ['create', 'read', 'update', 'delete', 'test'],
  apiKey: ['create', 'read', 'update', 'delete'],
  usage: ['read'],
  auditLog: ['read'],
  settings: ['read', 'update'],
  billing: ['read', 'manage'],
} as const;

export type Statement = typeof statement;
export type Resource = keyof Statement;
export type Action<R extends Resource = Resource> = Statement[R][number];

/** Turns `['create','read',...]` into `{ create: true, read: true, ... }`. */
const all = <R extends Resource>(resource: R) =>
  Object.fromEntries(statement[resource].map((action) => [action, true])) as Record<
    string,
    true
  >;

const ownerGrants = {
  organization: all('organization'),
  member: all('member'),
  invitation: all('invitation'),
  team: all('team'),
  ac: all('ac'),
  source: all('source'),
  document: all('document'),
  chat: all('chat'),
  search: all('search'),
  aiProvider: all('aiProvider'),
  apiKey: all('apiKey'),
  usage: all('usage'),
  auditLog: all('auditLog'),
  settings: all('settings'),
  billing: all('billing'),
} as const;

/** Everything `owner` can do except deleting the organization or managing billing. */
const adminGrants = {
  ...ownerGrants,
  organization: { read: true, update: true },
  billing: { read: true },
} as const;

const memberGrants = {
  organization: { read: true },
  member: { read: true },
  invitation: { read: true },
  team: { read: true },
  ac: { read: true },
  source: { create: true, read: true, update: true, sync: true },
  document: { create: true, read: true, update: true, reindex: true },
  chat: { create: true, read: true },
  search: { execute: true },
  aiProvider: { read: true },
  apiKey: { read: true },
  usage: { read: true },
  settings: { read: true },
} as const;

const viewerGrants = {
  organization: { read: true },
  member: { read: true },
  team: { read: true },
  source: { read: true },
  document: { read: true },
  chat: { read: true },
  search: { execute: true },
  usage: { read: true },
  settings: { read: true },
} as const;

export const permissions = {
  owner: ownerGrants,
  admin: adminGrants,
  member: memberGrants,
  viewer: viewerGrants,
};

export type RoleGrants = (typeof permissions)[keyof typeof permissions];
export type Grants = Partial<Record<Resource, Record<string, boolean>>>;

export const PERMISSION_LABELS: Record<string, string> = {
  'source:create': 'Connect knowledge sources',
  'source:sync': 'Trigger syncs',
  'source:manageCredentials': 'Manage source credentials',
  'source:delete': 'Delete sources',
  'document:delete': 'Delete documents',
  'document:reindex': 'Reindex documents',
  'chat:create': 'Ask the company brain',
  'aiProvider:create': 'Add AI provider credentials',
  'aiProvider:update': 'Configure AI providers',
  'member:create': 'Invite members',
  'apiKey:create': 'Create API keys',
  'settings:update': 'Change organization settings',
  'organization:delete': 'Delete the organization',
  'billing:manage': 'Manage billing',
  'auditLog:read': 'View the audit log',
  'usage:read': 'View usage',
};

/** Coarse gate used by route middleware before per-record checks. */
export function hasPermission(grants: Grants, resource: Resource, action: string): boolean {
  return Boolean(grants[resource]?.[action]);
}
