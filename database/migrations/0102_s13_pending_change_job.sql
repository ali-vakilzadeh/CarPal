-- Backend S13 (contract 1.4.0, admin console BR-20/BR-21): the background job an approved ASYNC four-eyes change
-- started (admin.taxonomy_merge), so the requester and the approver can follow it with admin.job_get; and an index
-- for admin.four_eyes_list mine=true. Docs/43.db_setup.sql has the same column and index.

ALTER TABLE admin.pending_admin_changes ADD COLUMN IF NOT EXISTS job_id uuid;
CREATE INDEX IF NOT EXISTS pending_admin_changes_requester_idx ON admin.pending_admin_changes (requested_by, id DESC);
