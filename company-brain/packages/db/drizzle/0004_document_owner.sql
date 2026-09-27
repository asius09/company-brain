-- Adds an owner to documents so `visibility = 'private'` has something to mean.
--
-- Previously `private` was filtered as "any member of the organization", which
-- made it identical to `tenant` and quietly widened access rather than narrowing
-- it. Documents inherit their owner from the source that produced them.
--
-- The column is nullable with `on delete set null`: deleting the user who added
-- a source must not delete the knowledge it produced, and a document that loses
-- its owner becomes org-visible rather than invisible to everyone.

alter table documents
  add column if not exists created_by text
    references "user" (id) on delete set null;

-- Backfill: a document with a source inherits that source's owner. Documents
-- with no source were added by hand and have no owner to infer, so they stay
-- null and are treated as tenant-visible.
update documents d
set created_by = s.created_by
from sources s
where d.source_id = s.id
  and d.created_by is null
  and s.created_by is not null;

-- Private lookups always filter on (organization, owner, visibility).
create index if not exists documents_owner_visibility_idx
  on documents (organization_id, created_by, visibility);
