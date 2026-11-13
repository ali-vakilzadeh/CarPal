-- Backend S15 (contract 1.4.0, admin console BR-12, A-POL-01): policies and consent texts with versions. One document
-- per policy key and region, its versions (EN and FA texts; draft, then a four-eyes publish with an effective date and
-- a re-consent flag; read-only once published) and the users' acceptances of a version (at sign-up and from the
-- re-consent prompt). Seeds placeholder version 1.0 of terms, privacy and community guidelines for the pilot region.
-- Docs/43.db_setup.sql has the same tables, trigger, policies and seed. Idempotent, because a fresh install already
-- has the baseline's version and still runs this file once.

CREATE TABLE IF NOT EXISTS identity.policy_documents (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  policy_key     text NOT NULL CHECK (policy_key IN ('terms','privacy','community_guidelines')),
  region_key     text NOT NULL CHECK (char_length(region_key) BETWEEN 1 AND 40),
  reconsent_mode text NOT NULL CHECK (reconsent_mode IN ('blocking','notice')),
  UNIQUE (policy_key, region_key)
);
COMMENT ON TABLE identity.policy_documents IS '52 PolicyDocument — one per policy key and region';

CREATE TABLE IF NOT EXISTS identity.policy_versions (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  document_id                 uuid NOT NULL REFERENCES identity.policy_documents (id),
  policy_version              text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 20),
  title_translations          jsonb NOT NULL CHECK (jsonb_typeof(title_translations) = 'object'),
  body_translations           jsonb NOT NULL CHECK (jsonb_typeof(body_translations) = 'object'),
  change_summary_translations jsonb CHECK (change_summary_translations IS NULL OR jsonb_typeof(change_summary_translations) = 'object'),
  status                      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','published','superseded')),
  effective_at                timestamptz,
  requires_reconsent          boolean NOT NULL DEFAULT false,
  published_by                uuid,
  approved_by                 uuid,
  published_at                timestamptz,
  UNIQUE (document_id, policy_version),
  CHECK ((status = 'draft') = (effective_at IS NULL)),
  CHECK ((status = 'draft') = (published_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS policy_versions_scheduled_uq ON identity.policy_versions (document_id) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS policy_versions_effective_idx ON identity.policy_versions (document_id, effective_at DESC)
  WHERE status <> 'draft';
COMMENT ON TABLE identity.policy_versions IS '52 PolicyVersion — texts read-only once published (trigger)';

CREATE OR REPLACE FUNCTION identity.tg_policy_version_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND NOT core.is_system() THEN
      RAISE EXCEPTION 'published policy versions are not deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.status = 'draft'
       OR (NEW.document_id, NEW.policy_version, NEW.title_translations, NEW.body_translations,
           NEW.change_summary_translations, NEW.effective_at, NEW.requires_reconsent, NEW.published_by,
           NEW.approved_by, NEW.published_at)
          IS DISTINCT FROM
          (OLD.document_id, OLD.policy_version, OLD.title_translations, OLD.body_translations,
           OLD.change_summary_translations, OLD.effective_at, OLD.requires_reconsent, OLD.published_by,
           OLD.approved_by, OLD.published_at)) THEN
    RAISE EXCEPTION 'published policy versions are read-only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE IF NOT EXISTS identity.policy_acceptances (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  user_id           uuid NOT NULL REFERENCES identity.user_accounts (id),
  policy_version_id uuid NOT NULL REFERENCES identity.policy_versions (id),
  accepted_at       timestamptz NOT NULL DEFAULT now(),
  source            text NOT NULL CHECK (source IN ('signup','prompt')),
  UNIQUE (user_id, policy_version_id)
);
CREATE INDEX IF NOT EXISTS policy_acceptances_version_idx ON identity.policy_acceptances (policy_version_id);
COMMENT ON TABLE identity.policy_acceptances IS '52 PolicyAcceptance — a user accepted one policy version (kept after erasure as evidence)';

-- Triggers and row-level security as the baseline's generator gives every table (43 §21.1), plus the tenant policies.
DO $s15$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'policy_versions_immutable'
                  AND tgrelid = 'identity.policy_versions'::regclass) THEN
    CREATE TRIGGER policy_versions_immutable BEFORE UPDATE OR DELETE ON identity.policy_versions
      FOR EACH ROW EXECUTE FUNCTION identity.tg_policy_version_immutable();
  END IF;
  FOREACH t IN ARRAY ARRAY['identity.policy_documents','identity.policy_versions','identity.policy_acceptances']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_touch' AND tgrelid = t::regclass) THEN
      EXECUTE format('CREATE TRIGGER zz_touch BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION core.tg_touch()', t);
    END IF;
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'system_all' AND polrelid = t::regclass) THEN
      EXECUTE format('CREATE POLICY system_all ON %s FOR ALL USING (core.is_system()) WITH CHECK (core.is_system())', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'staff_all' AND polrelid = t::regclass) THEN
      EXECUTE format('CREATE POLICY staff_all ON %s FOR ALL USING (core.is_staff()) WITH CHECK (core.is_staff())', t);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'read_all' AND polrelid = 'identity.policy_documents'::regclass) THEN
    CREATE POLICY read_all ON identity.policy_documents FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'read_published' AND polrelid = 'identity.policy_versions'::regclass) THEN
    CREATE POLICY read_published ON identity.policy_versions FOR SELECT USING (status <> 'draft');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'self_all' AND polrelid = 'identity.policy_acceptances'::regclass) THEN
    CREATE POLICY self_all ON identity.policy_acceptances FOR ALL USING (user_id = core.me()) WITH CHECK (user_id = core.me());
  END IF;
END
$s15$;

REVOKE ALL ON identity.policy_documents, identity.policy_versions, identity.policy_acceptances FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON identity.policy_documents, identity.policy_versions, identity.policy_acceptances
  TO carpal_api, carpal_admin_api, carpal_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.policy_documents, identity.policy_versions, identity.policy_acceptances
  TO carpal_worker;

-- PLACEHOLDER texts: version 1.0 of each policy of the pilot region, in force from install time. The final EN and FA
-- texts are published before go-live through the admin console (admin.policy_version_publish).
INSERT INTO identity.policy_documents (created_by, policy_key, region_key, reconsent_mode)
VALUES (core.system_actor_id(), 'terms', 'ir-pilot', 'blocking'),
       (core.system_actor_id(), 'privacy', 'ir-pilot', 'blocking'),
       (core.system_actor_id(), 'community_guidelines', 'ir-pilot', 'notice')
ON CONFLICT (policy_key, region_key) DO NOTHING;
INSERT INTO identity.policy_versions (created_by, document_id, policy_version, title_translations, body_translations,
                                      status, effective_at, published_at)
SELECT core.system_actor_id(), d.id, '1.0',
       jsonb_build_object('en', t.title_en, 'fa', t.title_fa),
       jsonb_build_object('en', 'Placeholder text. The final ' || t.title_en || ', version 1.0, will be published here before launch.',
                          'fa', 'متن موقت. متن نهایی ' || t.title_fa || '، نسخه 1.0، پیش از راه‌اندازی در اینجا منتشر می‌شود.'),
       'published', now(), now()
  FROM identity.policy_documents d
  JOIN (VALUES ('terms', 'Terms of Use', 'شرایط استفاده'),
               ('privacy', 'Privacy Policy', 'سیاست حفظ حریم خصوصی'),
               ('community_guidelines', 'Community Guidelines', 'رهنمودهای انجمن')) AS t (policy_key, title_en, title_fa)
    ON t.policy_key = d.policy_key
 WHERE d.region_key = 'ir-pilot'
ON CONFLICT (document_id, policy_version) DO NOTHING;
