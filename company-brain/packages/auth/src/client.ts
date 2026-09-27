import { inferAdditionalFields, organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

import { organizationRoles, ac, type OrganizationRole } from './access';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

/**
 * Browser-side client.
 *
 * Passing the same `ac` + `roles` to `organizationClient` lets components call
 * Better Auth's `clientSideHasPermission` so the UI renders exactly what the
 * server will allow. The server stays the authority — this only avoids showing
 * buttons that would 403.
 */
export const authClient = createAuthClient({
  baseURL: API_URL,
  plugins: [
    organizationClient({
      ac,
      roles: organizationRoles,
      schema: {
        organization: {
          additionalFields: {
            plan: { type: 'string', required: false },
            timezone: { type: 'string', required: false },
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
    twoFactorClient(),
    inferAdditionalFields<{
      organization: {
        plan?: string;
        timezone?: string;
        settings?: Record<string, unknown>;
        stats?: Record<string, unknown>;
      };
      member: { jobTitle?: string; department?: string };
    }>(),
  ],
});

export const { signIn, signUp, signOut, useSession, getSession, organization } = authClient;

export { ac, organizationRoles, type OrganizationRole };
export default authClient;
