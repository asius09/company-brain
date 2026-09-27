/* eslint-disable */
/**
 * TEMPORARY: used only to generate the Drizzle schema for Better Auth's tables.
 * The real config lives in ./src/server.ts. Kept separate so schema generation
 * never has to boot the real database connection.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAccessControl } from 'better-auth/plugins/access';
import {
  admin,
  organization,
  twoFactor,
  emailOTP,
  magicLink,
  bearer,
  lastLoginMethod,
  haveIBeenPwned,
  openAPI,
} from 'better-auth/plugins';

import { statement, permissions } from './src/permissions';

const ac = createAccessControl(statement);
const roles = {
  owner: ac.newRole(permissions.owner),
  admin: ac.newRole(permissions.admin),
  member: ac.newRole(permissions.member),
  viewer: ac.newRole(permissions.viewer),
};

export const auth = betterAuth({
  appName: 'Company Brain',
  baseURL: 'http://localhost:3001',
  secret: 'x'.repeat(48),
  database: drizzleAdapter({} as never, { provider: 'pg' }),

  emailAndPassword: { enabled: true, requireEmailVerification: false, minPasswordLength: 10 },

  plugins: [
    admin({ defaultRole: 'user', adminRoles: ['admin'] }),

    organization({
      ac,
      roles,
      allowUserToCreateOrganization: async () => true,
      creatorRole: 'owner',
      membershipLimit: 500,
      organizationLimit: 20,
      invitationExpiresIn: 60 * 60 * 24 * 7,
      invitationLimit: 50,
      cancelPendingInvitationsOnReInvite: true,
      sendInvitationEmail: async () => {},
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
    emailOTP(),
    magicLink({ sendMagicLink: async () => {} }),
    haveIBeenPwned(),
    bearer(),
    lastLoginMethod(),
    openAPI(),
  ],
});
