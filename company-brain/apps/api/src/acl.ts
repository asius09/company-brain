/**
 * Document-level access control.
 *
 * RLS already guarantees a request cannot see another organization's rows. This
 * is the narrower question: within one organization, which documents may this
 * particular user read?
 *
 * It lives in one place because the answer is applied in two very different
 * queries -- the document list and the search ranking. When the two were
 * written separately, the list applied no visibility rule at all, which leaked
 * private document titles to every member of the tenant.
 */
import { sql, type SQL } from 'drizzle-orm';
import { documents } from '@company-brain/db';

/** Who is asking, as far as document visibility is concerned. */
export interface DocumentAclPrincipal {
  organizationId: string;
  userId: string;
  role: string;
}

/**
 * A SQL predicate for documents this principal may read.
 *
 * The three levels, narrowest last:
 *
 * - `tenant`: everyone in the organization.
 * - `restricted`: an explicit list of users or roles.
 * - `private`: the owner alone.
 *
 * A private document whose owner has been deleted falls back to tenant-wide.
 * The alternative is a document nobody can read, including the admins who would
 * otherwise fix it, so the trade is deliberately made toward availability when
 * there is no owner left to enforce.
 */
export function documentVisibilityFilter(principal: DocumentAclPrincipal): SQL {
  return sql`(
    ${documents.visibility} = 'tenant'
    or (${documents.visibility} = 'restricted' and (
      ${principal.userId} = any(${documents.allowedUserIds})
      or ${principal.role} = any(${documents.allowedRoles})
    ))
    or (${documents.visibility} = 'private' and (
      ${documents.createdBy} is null
      or ${documents.createdBy} = ${principal.userId}
    ))
  )`;
}
