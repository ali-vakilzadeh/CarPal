
-- Backend S15b (contract 1.4.0, owner decisions DQ-18 and DQ-19, admin console A-POL-01): consent texts become
-- versioned documents like the policies of S15. Every consent type gets a consent-text document per region
-- (reconsent_mode consent); a consent records the published text it was granted under (consent_records.policy_version_id),
-- confirmations under later texts are kept in identity.consent_confirmations, and a consent-text version that requires
-- re-consent carries the administrator's choice (reconsent_action keep | pause). The consent gate (identity.has_consent)
-- gains the region and treats a paused consent as not granted. Placeholder 1.0 texts are seeded for ir-pilot.
-- Docs/43.db_setup.sql has the same columns, table, functions, triggers, policies and seed. Idempotent, because a fresh
-- install already has the baseline's objects and still runs this file once.

-- ------------------------------------------------------------- consent-text documents
ALTER TABLE identity.policy_documents DROP CONSTRAINT IF EXISTS policy_documents_policy_key_check;
ALTER TABLE identity.policy_documents ADD CONSTRAINT policy_documents_policy_key_check CHECK (policy_key IN (
  'terms','privacy','community_guidelines',
  'vehicle_data_sharing','service_history_sharing','vendor_fitment_context','photo_publishing',
  'showcase_publishing','ai_personalization','review_invitations','fleet_driver_data_visibility',
  'fleet_data_ai_use','provider_analytics_ai_use','vendor_inventory_ai_use','location_usage','marketing'));
ALTER TABLE identity.policy_documents DROP CONSTRAINT IF EXISTS policy_documents_reconsent_mode_check;
ALTER TABLE identity.policy_documents ADD CONSTRAINT policy_documents_reconsent_mode_check
  CHECK (reconsent_mode IN ('blocking','notice','consent'));
ALTER TABLE identity.policy_documents DROP CONSTRAINT IF EXISTS policy_documents_consent_mode;
ALTER TABLE identity.policy_documents ADD CONSTRAINT policy_documents_consent_mode
  CHECK ((reconsent_mode = 'consent') = (policy_key NOT IN ('terms','privacy','community_guidelines')));

ALTER TABLE identity.policy_versions ADD COLUMN IF NOT EXISTS reconsent_action text;
ALTER TABLE identity.policy_versions DROP CONSTRAINT IF EXISTS policy_versions_reconsent_action;
ALTER TABLE identity.policy_versions ADD CONSTRAINT policy_versions_reconsent_action
  CHECK (reconsent_action IS NULL OR (requires_reconsent AND reconsent_action IN ('keep','pause')));

-- A published version keeps its texts, dates, approvers and re-consent choice; only its status moves on.
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
           NEW.approved_by, NEW.published_at, NEW.reconsent_action)
          IS DISTINCT FROM
          (OLD.document_id, OLD.policy_version, OLD.title_translations, OLD.body_translations,
           OLD.change_summary_translations, OLD.effective_at, OLD.requires_reconsent, OLD.published_by,
           OLD.approved_by, OLD.published_at, OLD.reconsent_action)) THEN
    RAISE EXCEPTION 'published policy versions are read-only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

-- ------------------------------------------------------------- consent records
ALTER TABLE identity.consent_records ADD COLUMN IF NOT EXISTS policy_version_id uuid;
DO $s15b$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'consent_records_policy_version_id_fkey'
                  AND conrelid = 'identity.consent_records'::regclass) THEN
    ALTER TABLE identity.consent_records
      ADD CONSTRAINT consent_records_policy_version_id_fkey FOREIGN KEY (policy_version_id) REFERENCES identity.policy_versions (id);
  END IF;
END
$s15b$;

-- Consent records are immutable except the one-time withdrawal (52 §4); the text reference is part of the grant.
CREATE OR REPLACE FUNCTION identity.tg_consent_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT core.is_system() THEN
      RAISE EXCEPTION 'consent records are not deleted; withdraw them' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.subject_type, NEW.subject_id, NEW.consent_type, NEW.scope_entity_type, NEW.scope_entity_id,
      NEW.granted_to_type, NEW.granted_to_id, NEW.policy_version, NEW.policy_version_id, NEW.granted, NEW.granted_at,
      NEW.expires_at, NEW.source)
     IS DISTINCT FROM
     (OLD.subject_type, OLD.subject_id, OLD.consent_type, OLD.scope_entity_type, OLD.scope_entity_id,
      OLD.granted_to_type, OLD.granted_to_id, OLD.policy_version, OLD.policy_version_id, OLD.granted, OLD.granted_at,
      OLD.expires_at, OLD.source)
     OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at) THEN
    RAISE EXCEPTION 'consent records are immutable except a single withdrawal' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE IF NOT EXISTS identity.consent_confirmations (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  consent_id        uuid NOT NULL REFERENCES identity.consent_records (id),
  policy_version_id uuid NOT NULL REFERENCES identity.policy_versions (id),
  confirmed_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_by      uuid NOT NULL,
  UNIQUE (consent_id, policy_version_id)
);
CREATE INDEX IF NOT EXISTS consent_confirmations_version_idx ON identity.consent_confirmations (policy_version_id);
COMMENT ON TABLE identity.consent_confirmations IS '52 ConsentConfirmation — a consent confirmed under a later consent text (append-only)';

CREATE OR REPLACE FUNCTION identity.tg_consent_confirmation_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT core.is_system() THEN
    RAISE EXCEPTION 'consent confirmations are append-only' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

-- Triggers and row-level security as the baseline's generator gives every table (43 §21.1), plus the tenant policy.
DO $s15b$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'consent_confirmations_immutable'
                  AND tgrelid = 'identity.consent_confirmations'::regclass) THEN
    CREATE TRIGGER consent_confirmations_immutable BEFORE UPDATE OR DELETE ON identity.consent_confirmations
      FOR EACH ROW EXECUTE FUNCTION identity.tg_consent_confirmation_immutable();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_touch' AND tgrelid = 'identity.consent_confirmations'::regclass) THEN
    CREATE TRIGGER zz_touch BEFORE UPDATE ON identity.consent_confirmations FOR EACH ROW EXECUTE FUNCTION core.tg_touch();
  END IF;
  ALTER TABLE identity.consent_confirmations ENABLE ROW LEVEL SECURITY;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'system_all' AND polrelid = 'identity.consent_confirmations'::regclass) THEN
    CREATE POLICY system_all ON identity.consent_confirmations FOR ALL USING (core.is_system()) WITH CHECK (core.is_system());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'staff_all' AND polrelid = 'identity.consent_confirmations'::regclass) THEN
    CREATE POLICY staff_all ON identity.consent_confirmations FOR ALL USING (core.is_staff()) WITH CHECK (core.is_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'consent_all' AND polrelid = 'identity.consent_confirmations'::regclass) THEN
    CREATE POLICY consent_all ON identity.consent_confirmations FOR ALL
      USING (EXISTS (SELECT 1 FROM identity.consent_records c WHERE c.id = consent_id))
      WITH CHECK (EXISTS (SELECT 1 FROM identity.consent_records c WHERE c.id = consent_id
                            AND ((c.subject_type = 'user' AND c.subject_id = core.me())
                                 OR (c.subject_type = 'organization' AND c.subject_id = core.my_org()))));
  END IF;
END
$s15b$;

REVOKE ALL ON identity.consent_confirmations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON identity.consent_confirmations TO carpal_api, carpal_admin_api, carpal_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.consent_confirmations TO carpal_worker;

-- ------------------------------------------------------------- consent gate
CREATE OR REPLACE FUNCTION identity.consent_text_at(p_consent_id uuid, p_policy_version_id uuid, p_granted_at timestamptz)
RETURNS timestamptz
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
  SELECT GREATEST(
    coalesce((SELECT v.effective_at FROM identity.policy_versions v WHERE v.id = p_policy_version_id), p_granted_at),
    (SELECT max(v.effective_at) FROM identity.consent_confirmations k
       JOIN identity.policy_versions v ON v.id = k.policy_version_id
      WHERE k.consent_id = p_consent_id AND k.deleted_at IS NULL))
$$;
COMMENT ON FUNCTION identity.consent_text_at IS 'When the consent text a consent stands on came into force (grant or latest confirmation)';

CREATE OR REPLACE FUNCTION identity.consent_reconsent(p_consent_type text, p_text_at timestamptz, p_region text)
RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN bool_or(v.reconsent_action = 'pause') THEN 'pause' WHEN count(*) > 0 THEN 'keep' END
    FROM identity.policy_documents d
    JOIN identity.policy_versions v ON v.document_id = d.id
   WHERE d.region_key = p_region AND d.policy_key = p_consent_type AND d.reconsent_mode = 'consent'
     AND d.deleted_at IS NULL AND v.deleted_at IS NULL AND v.status <> 'draft'
     AND v.requires_reconsent AND v.effective_at <= now()
     AND (p_text_at IS NULL OR v.effective_at > p_text_at)
$$;
COMMENT ON FUNCTION identity.consent_reconsent IS 'Re-consent of a consent: null (none), keep or pause (DQ-19)';

-- The gate gains p_region (the old signature is dropped so no caller keeps the version without the pause rule).
DROP FUNCTION IF EXISTS identity.has_consent(text, uuid, text, text, uuid, text, uuid);
CREATE OR REPLACE FUNCTION identity.has_consent(p_subject_type text, p_subject_id uuid, p_consent_type text,
                                                p_scope_type text DEFAULT NULL, p_scope_id uuid DEFAULT NULL,
                                                p_grantee_type text DEFAULT NULL, p_grantee_id uuid DEFAULT NULL,
                                                p_region text DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM identity.consent_records c
     WHERE c.subject_type = p_subject_type AND c.subject_id = p_subject_id
       AND c.consent_type::text = p_consent_type
       AND c.granted AND c.withdrawn_at IS NULL AND c.deleted_at IS NULL
       AND (c.expires_at IS NULL OR c.expires_at > now())
       AND (c.scope_entity_id IS NULL
            OR (p_scope_id IS NOT NULL AND c.scope_entity_type::text = p_scope_type AND c.scope_entity_id = p_scope_id))
       AND (c.granted_to_type IS NULL
            OR (p_grantee_type IS NOT NULL AND c.granted_to_type = p_grantee_type
                AND (c.granted_to_type = 'platform' OR c.granted_to_id = p_grantee_id)))
       AND (p_region IS NULL
            OR identity.consent_reconsent(p_consent_type,
                 identity.consent_text_at(c.id, c.policy_version_id, c.granted_at), p_region) IS DISTINCT FROM 'pause'))
$$;
COMMENT ON FUNCTION identity.has_consent IS 'L16 consent gate: active, unexpired, matching scope and grantee (null scope/grantee = all), not paused for re-consent in p_region';

-- ------------------------------------------------------------- seed
-- PLACEHOLDER consent texts: version 1.0 of the consent text of every consent type of the pilot region, in force from
-- install time. The final EN and FA texts are published through the admin console (admin.policy_version_publish).
INSERT INTO identity.policy_documents (created_by, policy_key, region_key, reconsent_mode)
SELECT core.system_actor_id(), k, 'ir-pilot', 'consent'
  FROM unnest(ARRAY['vehicle_data_sharing','service_history_sharing','vendor_fitment_context','photo_publishing',
                    'showcase_publishing','ai_personalization','review_invitations','fleet_driver_data_visibility',
                    'fleet_data_ai_use','provider_analytics_ai_use','vendor_inventory_ai_use','location_usage',
                    'marketing']) AS k
ON CONFLICT (policy_key, region_key) DO NOTHING;
INSERT INTO identity.policy_versions (created_by, document_id, policy_version, title_translations, body_translations,
                                      status, effective_at, published_at)
SELECT core.system_actor_id(), d.id, '1.0',
       jsonb_build_object('en', t.title_en, 'fa', t.title_fa),
       jsonb_build_object('en', 'Placeholder text. The final consent text "' || t.title_en || '", version 1.0, will be published here before launch.',
                          'fa', 'متن موقت. متن نهایی رضایت «' || t.title_fa || '»، نسخه 1.0، پیش از راه‌اندازی در اینجا منتشر می‌شود.'),
       'published', now(), now()
  FROM identity.policy_documents d
  JOIN (VALUES ('vehicle_data_sharing', 'Sharing vehicle data with a service provider', 'اشتراک اطلاعات خودرو با ارائه‌دهنده خدمات'),
               ('service_history_sharing', 'Sharing service history', 'اشتراک سوابق سرویس'),
               ('vendor_fitment_context', 'Vehicle details for a parts inquiry', 'مشخصات خودرو برای استعلام قطعه'),
               ('photo_publishing', 'Publishing photos', 'انتشار عکس‌ها'),
               ('showcase_publishing', 'Before and after showcase', 'نمایش نمونه‌کار قبل و بعد'),
               ('ai_personalization', 'AI personalization', 'شخصی‌سازی با هوش مصنوعی'),
               ('review_invitations', 'Review invitations', 'دعوت به ثبت نظر'),
               ('fleet_driver_data_visibility', 'Driver data visible to the fleet', 'نمایش اطلاعات راننده به ناوگان'),
               ('fleet_data_ai_use', 'AI use of fleet data', 'استفاده هوش مصنوعی از داده‌های ناوگان'),
               ('provider_analytics_ai_use', 'AI use of business analytics', 'استفاده هوش مصنوعی از تحلیل‌های کسب‌وکار'),
               ('vendor_inventory_ai_use', 'AI use of private inventory', 'استفاده هوش مصنوعی از موجودی خصوصی'),
               ('location_usage', 'Device location', 'موقعیت مکانی دستگاه'),
               ('marketing', 'Marketing messages', 'پیام‌های تبلیغاتی')) AS t (policy_key, title_en, title_fa)
    ON t.policy_key = d.policy_key
 WHERE d.region_key = 'ir-pilot'
ON CONFLICT (document_id, policy_version) DO NOTHING;
