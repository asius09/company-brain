import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import {
  admin,
  bearer,
  emailOTP,
  haveIBeenPwned,
  lastLoginMethod,
  magicLink,
  openAPI,
  organization,
  twoFactor,
} from 'better-auth/plugins';

import { eq } from 'drizzle-orm';

import { getEnv, createLogger } from '@company-brain/core';
import { db, account, invitation, member, organization as organizationTable, session, twoFactor as twoFactorTable, user, verification } from '@company-brain/db';

import { ac, organizationRoles } from './access';
import { authEmails, isSignupAllowed, sendEmail } from './email';

const log = createLogger('auth');

/**
 * Better Auth resolves fields by the Drizzle *property* name, so this map must
 * be keyed by model name exactly as `getAuthTables()` reports it — including
 * `twoFactor` (camelCase) for the `two_factor` table.
 */
const authSchema = {
  user,
  session,
  account,
  verification,
  organization: organizationTable,
  member,
  invitation,
  twoFactor: twoFactorTable,
};

function buildTrustedOrigins(): string[] {
  const env = getEnv();
  return [...new Set([env.WEB_URL, env.API_URL, env.BETTER_AUTH_URL, ...env.CORS_ORIGINS])].filter(
    Boolean,
  );
}

function socialProviders() {
  const env = getEnv();
  const providers: Record<string, { clientId: string; clientSecret: string }> = {};
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    providers.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  if (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
    providers.discord = { clientId: env.DISCORD_CLIENT_ID, clientSecret: env.DISCORD_CLIENT_SECRET };
  }
  return providers;
}

/**
 * The tenant boundary is a Better Auth *organization*. Every row in the app's
 * own tables carries `organization_id`, and Postgres RLS (see migration
 * `0001_search_and_rls.sql`) enforces isolation on top of the query-level
 * `withTenant()` scoping — so a missing `WHERE organization_id = ?` is a
 * correctness bug the database will still catch.
 */
export function createAuth() {
  const env = getEnv();
  const social = socialProviders();

  return betterAuth({
    appName: 'Company Brain',
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: buildTrustedOrigins(),

    database: drizzleAdapter(db(), {
      provider: 'pg',
      schema: authSchema,
      usePlural: false,
      transaction: true,
    }),

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: env.NODE_ENV === 'production',
      minPasswordLength: 10,
      maxPasswordLength: 128,
      autoSignIn: true,
      sendResetPassword: async ({ user, url }) => {
        const tpl = authEmails.verification({ user: { name: user.name, email: user.email }, url });
        await sendEmail({ to: user.email, subject: 'Reset your password', text: tpl.text, html: tpl.html });
      },
    },

    emailVerification: {
      sendOnSignUp: env.NODE_ENV === 'production',
      sendVerificationEmail: async ({ user, url, token }) => {
        const tpl = authEmails.verification({ user: { name: user.name, email: user.email }, url, token });
        await sendEmail({ to: user.email, subject: tpl.subject, text: tpl.text, html: tpl.html });
      },
    },

    socialProviders: social,
    account: {
      accountLinking: {
        enabled: true,
        // Only auto-link when the provider already verified the address; this
        // stops an attacker from claiming an existing company email.
        trustedProviders: ['github', 'google'],
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * env.SESSION_TTL_DAYS,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 60 * 24 * env.SESSION_FRESH_DAYS,
      cookieCache: { enabled: true, maxAge: 60 * 5 },
    },

    user: {
      changeEmail: { enabled: true },
      deleteUser: {
        enabled: true,
        sendDeleteAccountVerification: async ({ user, url, token }) => {
          const tpl = authEmails.verification({ user: { name: user.name, email: user.email }, url, token });
          await sendEmail({
            to: user.email,
            subject: 'Confirm account deletion',
            text: `${tpl.text}\n\nDeleting your account also removes every workspace you own.`,
            html: tpl.html,
          });
        },
      },
    },

    advanced: {
      cookiePrefix: 'company_brain',
      useSecureCookies: env.NODE_ENV === 'production',
      // `generateId` is deliberately left unset: Better Auth's default emits
      // random string ids, which is what the `text` primary keys expect. Setting
      // it to "uuid" would instead push `gen_random_uuid()` into the INSERT.
    },

    rateLimit: {
      enabled: true,
      window: 60,
      max: env.RATE_LIMIT_PER_MINUTE,
      // Sign-in and signup are the endpoints worth throttling hardest; the
      // default of `max` for a 5-minute window is far too generous.
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 300, max: 5 },
        '/forget-password': { window: 300, max: 5 },
        '/two-factor/verify-totp': { window: 60, max: 10 },
        '/callback/:id': { window: 60, max: 30 },
      },
    },

    onAPIError: {
      throw: false,
    },

    databaseHooks: {
      user: {
        create: {
          // Runs before the row is written, so a rejected sign-up never leaves
          // a half-created user behind.
          before: async (inputUser) => {
            if (!(await isSignupAllowed(inputUser.email))) {
              throw new Error('Sign-up is not available for this email domain');
            }
            return { data: inputUser };
          },
        },
      },
    },

    plugins: [
      admin({
        defaultRole: 'user',
        adminRoles: ['admin'],
      }),

      organization({
        ac,
        roles: organizationRoles,
        // `organizationLimit` already caps workspaces per user; this callback
        // only gates the "you may not create one" branch.
        allowUserToCreateOrganization: async () => true,
        creatorRole: 'owner',
        membershipLimit: 500,
        organizationLimit: 20,
        invitationExpiresIn: 60 * 60 * 24 * 7,
        invitationLimit: 50,
        cancelPendingInvitationsOnReInvite: true,
        sendInvitationEmail: async ({ invitation, organization, inviter }) => {
          // `inviter` is a member row with the user joined onto it, not a user.
          const inviterName = inviter?.user?.name ?? inviter?.user?.email ?? 'Someone';
          const tpl = authEmails.invite({
            user: { name: inviterName, email: invitation.email },
            url: `${getEnv().WEB_URL}/accept-invitation?invitationId=${invitation.id}`,
          });
          await sendEmail({
            to: invitation.email,
            subject: `${inviterName} invited you to ${organization.name}`,
            text: tpl.text,
            html: tpl.html,
          });
        },
        schema: {
          organization: {
            additionalFields: {
              plan: { type: 'string', required: false, defaultValue: 'free' },
              timezone: { type: 'string', required: false, defaultValue: 'UTC' },
              settings: { type: 'json', required: false },
              stats: { type: 'json', required: false },
            },
          },
          member: {
            additionalFields: {
              jobTitle: { type: 'string', required: false },
              department: { type: 'string', required: false },
            },
          },
        },
      }),

      twoFactor({ issuer: 'Company Brain' }),

      emailOTP({
        // 6 digits, short-lived: this is a second factor, not a recovery path.
        otpLength: 6,
        expiresIn: 60 * 10,
        sendVerificationOTP: async ({ email, otp }) => {
          const tpl = authEmails.otp({ user: { name: null, email }, token: otp });
          await sendEmail({ to: email, subject: tpl.subject, text: tpl.text, html: tpl.html });
        },
      }),

      magicLink({
        sendMagicLink: async ({ email, url }) => {
          const tpl = authEmails.magicLink({ user: { name: null, email }, url });
          await sendEmail({ to: email, subject: tpl.subject, text: tpl.text, html: tpl.html });
        },
      }),

      haveIBeenPwned(),
      // Lets a native/mobile client (and the Vite SPA's fetch calls) send the
      // session token as `Authorization: Bearer <token>` instead of a cookie.
      bearer(),
      lastLoginMethod(),
      openAPI(),
    ],
  });
}

let instance: ReturnType<typeof createAuth> | undefined;

/** Cached singleton: booting Better Auth twice in one process duplicates work. */
export function getAuth(): ReturnType<typeof createAuth> {
  if (!instance) {
    instance = createAuth();
    log.info('auth.ready', 'Better Auth instance ready', { models: Object.keys(authSchema) });
  }
  return instance;
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = Awaited<ReturnType<Auth['api']['getSession']>>;
export { authSchema };
