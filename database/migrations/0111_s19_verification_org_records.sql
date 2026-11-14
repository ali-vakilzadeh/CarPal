-- Backend S19 (contract 1.4.0, admin console BR-35 parts 1-filters, 2 and 3, BR-34; R-25): verification and
-- organization records. Request more info on a verification check (the check stays pending, its review clock pauses
-- until the business resubmits), the reviewer a check is assigned to, the registration number and the AI pre-check
-- slot, the edit history of the organization profile (member edits and staff corrections), the possible-duplicate
-- name key of the organization search, and the moderation action types request_verification_info and correct_profile.
-- Docs/43.db_setup.sql has the same tables, columns, constraints, policies and grants. Idempotent, because a fresh
-- install already has the baseline's objects and still runs this file once.

-- ------------------------------------------------------- possible duplicates
CREATE OR REPLACE FUNCTION organization.normalized_name(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(translate(regexp_replace(lower(p_name), '[[:space:][:punct:]‌‍‏ ]+', '', 'g'),
                          'يكۀة', 'یکهه'), '')
$$;
CREATE INDEX IF NOT EXISTS organizations_normalized_name_idx ON organization.organizations (organization.normalized_name(name))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS organizations_contact_phone_idx ON organization.organizations (contact_phone)
  WHERE contact_phone IS NOT NULL AND deleted_at IS NULL;

-- ------------------------------------------------------ verification checks
ALTER TABLE organization.organization_verifications ADD COLUMN IF NOT EXISTS registration_number text;
ALTER TABLE organization.organization_verifications ADD COLUMN IF NOT EXISTS assigned_to uuid;
ALTER TABLE organization.organization_verifications ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
ALTER TABLE organization.organization_verifications ADD COLUMN IF NOT EXISTS sla_started_at timestamptz;
ALTER TABLE organization.organization_verifications ADD COLUMN IF NOT EXISTS sla_paused_at timestamptz;
ALTER TABLE organization.organization_verifications ADD COLUMN IF NOT EXISTS ai_precheck jsonb;
-- Existing checks: the clock started when they were submitted.
UPDATE organization.organization_verifications SET sla_started_at = created_at WHERE sla_started_at IS NULL;
ALTER TABLE organization.organization_verifications ALTER COLUMN sla_started_at SET DEFAULT now();
ALTER TABLE organization.organization_verifications ALTER COLUMN sla_started_at SET NOT NULL;
DO $s19$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_verifications_registration_number_check'
                   AND conrelid = 'organization.organization_verifications'::regclass) THEN
    ALTER TABLE organization.organization_verifications ADD CONSTRAINT organization_verifications_registration_number_check
      CHECK (char_length(registration_number) BETWEEN 1 AND 60);
    ALTER TABLE organization.organization_verifications ADD CONSTRAINT organization_verifications_ai_precheck_check
      CHECK (ai_precheck IS NULL OR jsonb_typeof(ai_precheck) = 'object');
    ALTER TABLE organization.organization_verifications ADD CONSTRAINT organization_verifications_pause_pending
      CHECK (sla_paused_at IS NULL OR status = 'pending');
    ALTER TABLE organization.organization_verifications ADD CONSTRAINT organization_verifications_assignee
      CHECK ((assigned_to IS NULL) = (assigned_at IS NULL));
  END IF;
END
$s19$;
CREATE INDEX IF NOT EXISTS organization_verifications_assignee_idx ON organization.organization_verifications (assigned_to)
  WHERE status = 'pending' AND assigned_to IS NOT NULL;

CREATE TABLE IF NOT EXISTS organization.verification_info_requests (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  verification_id    uuid NOT NULL REFERENCES organization.organization_verifications (id),
  organization_id    uuid NOT NULL REFERENCES organization.organizations (id),
  requested_by       uuid NOT NULL,
  missing_items      text[] NOT NULL CHECK (cardinality(missing_items) BETWEEN 1 AND 10
                       AND missing_items <@ ARRAY['business_document','registration_number','legal_name','address_proof',
                         'location_pin','phone_callback','owner_identity','readable_copy','other']::text[]),
  template_key       text NOT NULL CHECK (template_key IN ('missing_documents','unreadable_documents','details_mismatch',
                       'location_mismatch','callback_failed','other')),
  message            text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  answered_at        timestamptz,
  answered_by        uuid,
  response_note      text CHECK (char_length(response_note) BETWEEN 1 AND 1000),
  added_document_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(added_document_ids) <= 10),
  closed_at          timestamptz,
  CHECK (status <> 'answered' OR (answered_at IS NOT NULL AND answered_by IS NOT NULL)),
  CHECK (status <> 'closed' OR closed_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS verification_info_requests_open_uq ON organization.verification_info_requests (verification_id)
  WHERE status = 'open' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS verification_info_requests_verification_idx ON organization.verification_info_requests (verification_id, id);
COMMENT ON TABLE organization.verification_info_requests IS '52 VerificationInfoRequest — staff ask a business for more information on a pending check (backend S19)';

-- ---------------------------------------------------- profile edit history
CREATE TABLE IF NOT EXISTS organization.organization_profile_changes (
  id              uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  organization_id uuid NOT NULL REFERENCES organization.organizations (id),
  actor_kind      text NOT NULL CHECK (actor_kind IN ('member','staff')),
  actor_user_id   uuid NOT NULL,
  source          text NOT NULL CHECK (source IN ('org.update','admin.org_correct')),
  changes         jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array' AND jsonb_array_length(changes) BETWEEN 1 AND 10),
  reason          text CHECK (char_length(reason) BETWEEN 3 AND 500),
  CHECK ((actor_kind = 'staff') = (reason IS NOT NULL)),
  CHECK ((actor_kind = 'staff') = (source = 'admin.org_correct'))
);
CREATE INDEX IF NOT EXISTS organization_profile_changes_org_idx ON organization.organization_profile_changes (organization_id, id DESC);
COMMENT ON TABLE organization.organization_profile_changes IS '52 OrganizationProfileChange — append-only edit history of the organization profile (backend S19)';

-- ----------------------------------------------------------------- moderation
ALTER TABLE admin.moderation_actions DROP CONSTRAINT IF EXISTS moderation_actions_action_type_check;
ALTER TABLE admin.moderation_actions ADD CONSTRAINT moderation_actions_action_type_check CHECK (action_type IN ('approve','hide',
  'remove','restore','request_changes','warn_user','suspend_account','reactivate_account','verify_organization',
  'reject_verification','merge_duplicate','revoke_badge','apply_trust_penalty','confirm_review_approval',
  'reject_review_approval','request_evidence','correct_location','assist_onboarding','reduce_weight','edit_request',
  'downgrade_fitment','request_verification_info','correct_profile'));

-- ------------------------------------- triggers, row-level security, grants
-- As the baseline's generator gives every table (43 §21.1, §21.2), plus the append-only trigger and the tenant policies.
DO $s19$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_touch' AND tgrelid = 'organization.verification_info_requests'::regclass) THEN
    CREATE TRIGGER zz_touch BEFORE UPDATE ON organization.verification_info_requests FOR EACH ROW EXECUTE FUNCTION core.tg_touch();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'append_only'
                   AND tgrelid = 'organization.organization_profile_changes'::regclass) THEN
    CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON organization.organization_profile_changes
      FOR EACH ROW EXECUTE FUNCTION core.tg_append_only();
    CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON organization.organization_profile_changes
      FOR EACH STATEMENT EXECUTE FUNCTION core.tg_append_only();
  END IF;
  ALTER TABLE organization.verification_info_requests ENABLE ROW LEVEL SECURITY;
  ALTER TABLE organization.organization_profile_changes ENABLE ROW LEVEL SECURITY;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'system_all' AND polrelid = 'organization.verification_info_requests'::regclass) THEN
    CREATE POLICY system_all ON organization.verification_info_requests FOR ALL USING (core.is_system()) WITH CHECK (core.is_system());
    CREATE POLICY staff_all ON organization.verification_info_requests FOR ALL USING (core.is_staff()) WITH CHECK (core.is_staff());
    CREATE POLICY member_read ON organization.verification_info_requests FOR SELECT USING (organization_id = core.my_org());
    CREATE POLICY member_answer ON organization.verification_info_requests FOR UPDATE
      USING (organization_id = core.my_org() AND status = 'open')
      WITH CHECK (organization_id = core.my_org() AND status = 'answered' AND answered_by = core.me());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'system_all' AND polrelid = 'organization.organization_profile_changes'::regclass) THEN
    CREATE POLICY system_all ON organization.organization_profile_changes FOR ALL USING (core.is_system()) WITH CHECK (core.is_system());
    CREATE POLICY staff_all ON organization.organization_profile_changes FOR ALL USING (core.is_staff()) WITH CHECK (core.is_staff());
    CREATE POLICY member_insert ON organization.organization_profile_changes FOR INSERT
      WITH CHECK (organization_id = core.my_org() AND actor_kind = 'member' AND actor_user_id = core.me());
  END IF;
END
$s19$;

REVOKE ALL ON organization.verification_info_requests, organization.organization_profile_changes FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON organization.verification_info_requests TO carpal_api, carpal_admin_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON organization.verification_info_requests TO carpal_worker;
GRANT SELECT, INSERT ON organization.organization_profile_changes TO carpal_api, carpal_admin_api, carpal_worker;
GRANT EXECUTE ON FUNCTION organization.normalized_name(text) TO carpal_app_base;
