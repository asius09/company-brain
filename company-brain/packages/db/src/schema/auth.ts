/**
 * Better Auth's schema, hand-written to match
 * `packages/auth/scripts/dump-auth-schema.ts` output for the configured plugin
 * set (core + admin + organization + twoFactor + emailOTP + magicLink).
 *
 * VERIFYING: run `pnpm db:migrate` then `pnpm --filter @company-brain/auth verify`.
 * Better Auth logs any column/table drift at boot, so drift is impossible to miss.
 *
 * The Drizzle *property* names are camelCase on purpose: Better Auth's adapter
 * resolves fields via `schemaModel[fieldName]`, i.e. by JS key, so it looks up
 * `emailVerified` and never `email_verified`. The underlying SQL columns stay
 * snake_case via explicit name arguments, and every table below also gets
 * snake_case *index* names.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { jsonb } from './columns';

const now = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const nowUpdated = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

const pk = () => text('id').primaryKey().$defaultFn(() => crypto.randomUUID());

/* -------------------------------------------------------------------------- */
/* Core                                                                       */
/* -------------------------------------------------------------------------- */

export const user = pgTable(
  'user',
  {
    id: pk(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    createdAt: now(),
    updatedAt: nowUpdated(),
    // admin plugin
    role: text('role'),
    banned: boolean('banned').default(false),
    banReason: text('ban_reason'),
    banExpires: timestamp('ban_expires', { withTimezone: true }),
    // twoFactor plugin
    twoFactorEnabled: boolean('two_factor_enabled').default(false),
  },
  (table) => [uniqueIndex('user_email_idx').on(table.email), index('user_banned_idx').on(table.banned)],
);

export const session = pgTable(
  'session',
  {
    id: pk(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull(),
    createdAt: now(),
    updatedAt: nowUpdated(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // admin plugin (impersonation)
    impersonatedBy: text('impersonated_by'),
    // organization plugin — which tenant this session is acting as
    activeOrganizationId: text('active_organization_id'),
  },
  (table) => [
    uniqueIndex('session_token_idx').on(table.token),
    index('session_user_idx').on(table.userId),
    index('session_expires_idx').on(table.expiresAt),
    index('session_active_org_idx').on(table.activeOrganizationId),
  ],
);

export const account = pgTable(
  'account',
  {
    id: pk(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: now(),
    updatedAt: nowUpdated(),
  },
  (table) => [
    // One row per (provider, provider-account). Not unique: a user can hold
    // several accounts at the same provider.
    index('account_user_idx').on(table.userId),
    index('account_provider_idx').on(table.providerId, table.accountId),
  ],
);

export const verification = pgTable(
  'verification',
  {
    id: pk(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: now(),
    updatedAt: nowUpdated(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

/* -------------------------------------------------------------------------- */
/* organization plugin — a Better Auth organization IS a tenant               */
/* -------------------------------------------------------------------------- */

export interface OrganizationSettings {
  chatModel?: string;
  embeddingModel?: string;
  systemPrompt?: string;
  topK?: number;
  minScore?: number;
  temperature?: number;
  maxTokens?: number;
  defaultVisibility?: 'tenant' | 'restricted' | 'private';
  allowMemberInvites?: boolean;
  enforceSso?: boolean;
  allowedEmailDomains?: string[];
}

export interface OrganizationStats {
  sources: number;
  documents: number;
  chunks: number;
  members: number;
}

export const organization = pgTable(
  'organization',
  {
    id: pk(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    logo: text('logo'),
    createdAt: now(),
    metadata: text('metadata'),

    // additionalFields declared on the organization plugin
    plan: text('plan').default('free'),
    timezone: text('timezone').default('UTC'),
    settings: jsonb<OrganizationSettings>('settings').default(sql`'{}'::jsonb`),
    stats: jsonb<OrganizationStats>('stats').default(
      sql`'{"sources":0,"documents":0,"chunks":0,"members":0}'::jsonb`,
    ),
  },
  (table) => [
    uniqueIndex('organization_slug_idx').on(table.slug),
    index('organization_plan_idx').on(table.plan),
  ],
);

export const member = pgTable(
  'member',
  {
    id: pk(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    createdAt: now(),
    // additionalFields declared on the organization plugin
    jobTitle: text('job_title'),
    department: text('department'),
  },
  (table) => [
    uniqueIndex('member_org_user_idx').on(table.organizationId, table.userId),
    index('member_user_idx').on(table.userId),
    index('member_org_role_idx').on(table.organizationId, table.role),
  ],
);

export const invitation = pgTable(
  'invitation',
  {
    id: pk(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role'),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: now(),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('invitation_org_idx').on(table.organizationId),
    index('invitation_email_idx').on(table.email),
  ],
);

/* -------------------------------------------------------------------------- */
/* twoFactor plugin                                                           */
/* -------------------------------------------------------------------------- */

export const twoFactor = pgTable(
  'two_factor',
  {
    id: pk(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    verified: boolean('verified').default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  },
  (table) => [index('two_factor_user_idx').on(table.userId)],
);

export type User = typeof user.$inferSelect;
export type Session = typeof session.$inferSelect;
export type Account = typeof account.$inferSelect;
export type Organization = typeof organization.$inferSelect;
export type Member = typeof member.$inferSelect;
export type Invitation = typeof invitation.$inferSelect;
