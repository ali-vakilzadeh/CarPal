-- Backend S20 (contract 1.4.0, admin console BR-28, BR-30, BR-15): disputes and review/inventory moderation actions.
-- Dispute message threads (one per party: staff templated messages, the party's replies with evidence files), the
-- other party of a dispute (set when staff first write to it), staff withdrawal on the raiser's request (with the
-- request recorded as the resolution), the moderation actions reduce_weight, edit_request and downgrade_fitment, the
-- review weight factor the trust scorer applies, and the review edit requests.
-- Docs/43.db_setup.sql has the same tables, columns, constraints, policies and grants. Idempotent, because a fresh
-- install already has the baseline's objects and still runs this file once.

-- ------------------------------------------------------------------ reviews
ALTER TABLE trust.reviews ADD COLUMN IF NOT EXISTS weight_factor numeric(4,3) NOT NULL DEFAULT 1;
DO $s20$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reviews_weight_factor_check' AND conrelid = 'trust.reviews'::regclass) THEN
    ALTER TABLE trust.reviews ADD CONSTRAINT reviews_weight_factor_check CHECK (weight_factor BETWEEN 0 AND 1);
  END IF;
END
$s20$;

CREATE TABLE IF NOT EXISTS trust.review_edit_requests (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  review_id          uuid NOT NULL REFERENCES trust.reviews (id),
  moderation_case_id uuid,
  requested_by       uuid NOT NULL,
  spans              jsonb NOT NULL CHECK (jsonb_typeof(spans) = 'array' AND jsonb_array_length(spans) BETWEEN 1 AND 20),
  message            text NOT NULL CHECK (char_length(message) BETWEEN 3 AND 1000),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','edited','closed')),
  previous_status    core.review_status NOT NULL,
  due_at             timestamptz NOT NULL,
  edited_at          timestamptz,
  closed_at          timestamptz,
  CHECK (status <> 'edited' OR edited_at IS NOT NULL),
  CHECK (status <> 'closed' OR closed_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS review_edit_requests_live_uq ON trust.review_edit_requests (review_id)
  WHERE status IN ('open','edited') AND deleted_at IS NULL;
COMMENT ON TABLE trust.review_edit_requests IS '52 ReviewEditRequest — moderation edit_request: highlighted spans the author must change (backend S20)';

-- ----------------------------------------------------------------- disputes
ALTER TABLE trust.disputes ADD COLUMN IF NOT EXISTS respondent_user_id uuid;
ALTER TABLE trust.disputes ADD COLUMN IF NOT EXISTS respondent_organization_id uuid;
ALTER TABLE trust.disputes DROP CONSTRAINT IF EXISTS disputes_staff_withdrawal;
ALTER TABLE trust.disputes ADD CONSTRAINT disputes_staff_withdrawal CHECK (status <> 'withdrawn' OR resolved_by IS NULL
  OR (resolution IS NOT NULL AND resolved_at IS NOT NULL));
CREATE INDEX IF NOT EXISTS disputes_respondent_user_idx ON trust.disputes (respondent_user_id) WHERE respondent_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS disputes_respondent_org_idx ON trust.disputes (respondent_organization_id)
  WHERE respondent_organization_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS trust.dispute_messages (
  id                     uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  dispute_id             uuid NOT NULL REFERENCES trust.disputes (id),
  side                   text NOT NULL CHECK (side IN ('raiser','respondent')),
  author_kind            text NOT NULL CHECK (author_kind IN ('staff','party')),
  author_user_id         uuid NOT NULL,
  author_organization_id uuid,
  template_key           text CHECK (template_key IN ('request_information','request_evidence','mediation_invitation',
                           'status_update','withdrawal_confirmation','outcome_notice','other')),
  body                   text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  reply_due_at           timestamptz,
  CHECK ((author_kind = 'staff') = (template_key IS NOT NULL)),
  CHECK (author_kind = 'staff' OR reply_due_at IS NULL)
);
CREATE INDEX IF NOT EXISTS dispute_messages_thread_idx ON trust.dispute_messages (dispute_id, side, created_at);
COMMENT ON TABLE trust.dispute_messages IS '52 DisputeMessage — append-only; staff templated messages and party replies, one thread per side (backend S20)';

-- ------------------------------------------------------ moderation and media
ALTER TABLE admin.moderation_actions DROP CONSTRAINT IF EXISTS moderation_actions_action_type_check;
ALTER TABLE admin.moderation_actions ADD CONSTRAINT moderation_actions_action_type_check CHECK (action_type IN ('approve','hide',
  'remove','restore','request_changes','warn_user','suspend_account','reactivate_account','verify_organization',
  'reject_verification','merge_duplicate','revoke_badge','apply_trust_penalty','confirm_review_approval',
  'reject_review_approval','request_evidence','correct_location','assist_onboarding','reduce_weight','edit_request',
  'downgrade_fitment'));

ALTER TABLE media.media_attachments DROP CONSTRAINT IF EXISTS media_attachments_attached_to_type_check;
ALTER TABLE media.media_attachments ADD CONSTRAINT media_attachments_attached_to_type_check CHECK (attached_to_type IN ('vehicle',
  'vehicle_issue','portfolio_item','post','review','question','answer','inventory_item','appointment','provider_job_log',
  'organization','user','dispute_message'));

-- ------------------------------------- triggers, row-level security, grants
-- As the baseline's generator gives every table (43 §21.1, §21.2), plus the append-only trigger and the tenant policies.
DO $s20$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_touch' AND tgrelid = 'trust.review_edit_requests'::regclass) THEN
    CREATE TRIGGER zz_touch BEFORE UPDATE ON trust.review_edit_requests FOR EACH ROW EXECUTE FUNCTION core.tg_touch();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'append_only' AND tgrelid = 'trust.dispute_messages'::regclass) THEN
    CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON trust.dispute_messages
      FOR EACH ROW EXECUTE FUNCTION core.tg_append_only();
    CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON trust.dispute_messages
      FOR EACH STATEMENT EXECUTE FUNCTION core.tg_append_only();
  END IF;
  ALTER TABLE trust.review_edit_requests ENABLE ROW LEVEL SECURITY;
  ALTER TABLE trust.dispute_messages ENABLE ROW LEVEL SECURITY;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'system_all' AND polrelid = 'trust.review_edit_requests'::regclass) THEN
    CREATE POLICY system_all ON trust.review_edit_requests FOR ALL USING (core.is_system()) WITH CHECK (core.is_system());
    CREATE POLICY staff_all ON trust.review_edit_requests FOR ALL USING (core.is_staff()) WITH CHECK (core.is_staff());
    CREATE POLICY author_read ON trust.review_edit_requests FOR SELECT
      USING (EXISTS (SELECT 1 FROM trust.reviews r WHERE r.id = review_id AND r.author_user_id = core.me()));
    CREATE POLICY author_update ON trust.review_edit_requests FOR UPDATE
      USING (status = 'open' AND EXISTS (SELECT 1 FROM trust.reviews r WHERE r.id = review_id AND r.author_user_id = core.me()))
      WITH CHECK (status = 'edited' AND EXISTS (SELECT 1 FROM trust.reviews r WHERE r.id = review_id AND r.author_user_id = core.me()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'system_all' AND polrelid = 'trust.dispute_messages'::regclass) THEN
    CREATE POLICY system_all ON trust.dispute_messages FOR ALL USING (core.is_system()) WITH CHECK (core.is_system());
    CREATE POLICY staff_all ON trust.dispute_messages FOR ALL USING (core.is_staff()) WITH CHECK (core.is_staff());
    CREATE POLICY party_read ON trust.dispute_messages FOR SELECT
      USING (EXISTS (SELECT 1 FROM trust.disputes d WHERE d.id = dispute_id AND (
               (side = 'raiser' AND (d.raised_by_user_id = core.me() OR d.raised_by_organization_id = core.my_org()))
            OR (side = 'respondent' AND (d.respondent_user_id = core.me() OR d.respondent_organization_id = core.my_org())))));
    CREATE POLICY party_insert ON trust.dispute_messages FOR INSERT
      WITH CHECK (author_kind = 'party' AND author_user_id = core.me() AND EXISTS (
        SELECT 1 FROM trust.disputes d WHERE d.id = dispute_id AND d.status IN ('open','in_mediation') AND (
               (side = 'raiser' AND (d.raised_by_user_id = core.me() OR d.raised_by_organization_id = core.my_org()))
            OR (side = 'respondent' AND (d.respondent_user_id = core.me() OR d.respondent_organization_id = core.my_org())))));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'respondent_read' AND polrelid = 'trust.disputes'::regclass) THEN
    CREATE POLICY respondent_read ON trust.disputes FOR SELECT
      USING (respondent_user_id = core.me() OR respondent_organization_id = core.my_org());
  END IF;
END
$s20$;

REVOKE ALL ON trust.review_edit_requests, trust.dispute_messages FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON trust.review_edit_requests TO carpal_api, carpal_admin_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON trust.review_edit_requests TO carpal_worker;
GRANT SELECT, INSERT ON trust.dispute_messages TO carpal_api, carpal_admin_api, carpal_worker;
