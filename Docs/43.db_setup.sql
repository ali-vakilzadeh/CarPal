-- =============================================================================
-- CarPal MVP — Database Setup                                          (Doc 42)
--
-- Builds, in one run:
--   1. cluster roles (owner, migrator, one login role per deployable)
--   2. the primary database `carpal`: one schema per backend module, all tables,
--      constraints, indexes, functions, triggers and row-level security
--   3. primary records: plans and entitlements, feature flags, retention
--      policies, MCP clients, the taxonomy catalog (from Doc 44), the system actor and the
--      bootstrap platform admin
--   4. the analytics database `carpal_analytics`
--
-- Design: 41.db schema.md · Fields: 52.MVP Data Dictionary.md (authoritative)
-- Target: PostgreSQL 16+ with pgvector (>= 0.5). pg_trgm is used when present.
--
-- Run once, as a superuser, against a cluster that does not have the CarPal
-- databases yet (later changes are numbered migrations in database/migrations):
--
--   psql -X -d postgres -f "42.db_setup.sql" \
--        -v env=dev -v admin_email=ops@carpal.app \
--        -v migrator_password='…' -v api_password='…' -v auth_password='…' \
--        -v admin_api_password='…' -v worker_password='…' -v ai_password='…' \
--        -v readonly_password='…' -v analytics_writer_password='…' \
--        -v analytics_reader_password='…'
--
-- Optional: -v db_name=carpal -v analytics_db_name=carpal_analytics
--           -v db_locale=C   (use C.UTF-8 or an ICU locale where available)
--
-- No password is stored in this file. A login role whose password variable is
-- missing is created without a password and cannot sign in until the secret
-- manager sets one.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on
\pset pager off

-- -----------------------------------------------------------------------------
-- 0. Parameters
-- -----------------------------------------------------------------------------
\if :{?env}
\else
  \set env dev
\endif
\if :{?admin_email}
\else
  \set admin_email admin@carpal.app
\endif
\if :{?db_name}
\else
  \set db_name carpal
\endif
\if :{?analytics_db_name}
\else
  \set analytics_db_name carpal_analytics
\endif
\if :{?db_locale}
\else
  \set db_locale C
\endif

SELECT (:'env' IN ('dev', 'staging', 'prod')) AS env_ok \gset
\if :env_ok
\else
  \echo 'env must be dev, staging or prod'
  SELECT 1 / 0 AS invalid_env;
\endif

SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') AS db_exists \gset
\if :db_exists
  \echo 'Database already exists. 42.db_setup.sql builds a new installation only; use migrations for changes.'
  SELECT 1 / 0 AS already_installed;
\endif

\echo '== 1. Cluster roles'

-- -----------------------------------------------------------------------------
-- 1. Cluster roles
--    carpal_owner        owns every object; never logs in
--    carpal_app_base     common grants of all application roles
--    carpal_ctx_system   marker: may use the `system` RLS context (workers, auth, AI)
--    carpal_ctx_staff    marker: may use the `staff` RLS context (admin API only)
-- -----------------------------------------------------------------------------
DO $roles$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('carpal_owner',            false, 0),
      ('carpal_app_base',         false, 0),
      ('carpal_ctx_system',       false, 0),
      ('carpal_ctx_staff',        false, 0),
      ('carpal_migrator',         true,  5),
      ('carpal_auth',             true,  100),
      ('carpal_api',              true,  300),
      ('carpal_admin_api',        true,  50),
      ('carpal_worker',           true,  150),
      ('carpal_ai',               true,  100),
      ('carpal_readonly',         true,  20),
      ('carpal_analytics_writer', true,  50),
      ('carpal_analytics_reader', true,  20)
    ) AS t(name, can_login, conn_limit)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) THEN
      EXECUTE format(
        'CREATE ROLE %I %s NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT %s',
        r.name, CASE WHEN r.can_login THEN 'LOGIN' ELSE 'NOLOGIN' END,
        CASE WHEN r.can_login THEN r.conn_limit ELSE -1 END);
    END IF;
  END LOOP;
END
$roles$;

GRANT carpal_owner      TO carpal_migrator;
GRANT carpal_app_base   TO carpal_auth, carpal_api, carpal_admin_api, carpal_worker, carpal_ai;
GRANT carpal_ctx_system TO carpal_auth, carpal_worker, carpal_ai;
GRANT carpal_ctx_staff  TO carpal_admin_api;

\if :{?migrator_password}
  ALTER ROLE carpal_migrator PASSWORD :'migrator_password';
\endif
\if :{?auth_password}
  ALTER ROLE carpal_auth PASSWORD :'auth_password';
\endif
\if :{?api_password}
  ALTER ROLE carpal_api PASSWORD :'api_password';
\endif
\if :{?admin_api_password}
  ALTER ROLE carpal_admin_api PASSWORD :'admin_api_password';
\endif
\if :{?worker_password}
  ALTER ROLE carpal_worker PASSWORD :'worker_password';
\endif
\if :{?ai_password}
  ALTER ROLE carpal_ai PASSWORD :'ai_password';
\endif
\if :{?readonly_password}
  ALTER ROLE carpal_readonly PASSWORD :'readonly_password';
\endif
\if :{?analytics_writer_password}
  ALTER ROLE carpal_analytics_writer PASSWORD :'analytics_writer_password';
\endif
\if :{?analytics_reader_password}
  ALTER ROLE carpal_analytics_reader PASSWORD :'analytics_reader_password';
\endif

\echo '== 2. Databases'

SELECT format('CREATE DATABASE %I WITH OWNER carpal_owner TEMPLATE template0 ENCODING %L LC_COLLATE %L LC_CTYPE %L',
              :'db_name', 'UTF8', :'db_locale', :'db_locale') \gexec
SELECT format('CREATE DATABASE %I WITH OWNER carpal_owner TEMPLATE template0 ENCODING %L LC_COLLATE %L LC_CTYPE %L',
              :'analytics_db_name', 'UTF8', :'db_locale', :'db_locale')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'analytics_db_name') \gexec

\connect :db_name

-- Nobody but the CarPal roles may connect; nobody may create objects in `public`.
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db_name') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO carpal_app_base, carpal_migrator, carpal_readonly', :'db_name') \gexec
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- Per-role session limits (protect the database from runaway requests).
SELECT format('ALTER ROLE %I IN DATABASE %I SET %s', r, :'db_name', s)
  FROM (VALUES
    ('carpal_api',       'statement_timeout = ''5s'''),
    ('carpal_api',       'lock_timeout = ''2s'''),
    ('carpal_api',       'idle_in_transaction_session_timeout = ''15s'''),
    ('carpal_auth',      'statement_timeout = ''5s'''),
    ('carpal_auth',      'lock_timeout = ''2s'''),
    ('carpal_admin_api', 'statement_timeout = ''15s'''),
    ('carpal_admin_api', 'idle_in_transaction_session_timeout = ''30s'''),
    ('carpal_worker',    'statement_timeout = ''300s'''),
    ('carpal_ai',        'statement_timeout = ''30s'''),
    ('carpal_readonly',  'statement_timeout = ''60s'''),
    ('carpal_readonly',  'default_transaction_read_only = on')
  ) AS t(r, s) \gexec
SELECT format('ALTER ROLE %I IN DATABASE %I SET search_path = pg_catalog, core, ext', r, :'db_name')
  FROM unnest(ARRAY['carpal_auth','carpal_api','carpal_admin_api','carpal_worker','carpal_ai','carpal_readonly','carpal_migrator']) AS r \gexec

\echo '== 3. Extensions'

CREATE SCHEMA ext AUTHORIZATION carpal_owner;
COMMENT ON SCHEMA ext IS 'Extensions (pgvector, pg_trgm). Kept out of public.';
CREATE EXTENSION IF NOT EXISTS vector SCHEMA ext;
DO $ext$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') THEN
    CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA ext;
  ELSE
    RAISE WARNING 'pg_trgm is not installed: trigram search indexes are skipped';
  END IF;
END
$ext$;

-- Every object below is owned by carpal_owner.
SET ROLE carpal_owner;

\echo '== 4. core (backend/libs)'

-- =============================================================================
-- 4. core — shared types, context functions and platform tables (backend/libs)
-- =============================================================================
CREATE SCHEMA core;
COMMENT ON SCHEMA core IS 'Platform library objects: domains, request context, helpers, outbox, jobs (backend/libs)';

CREATE TABLE core.schema_info (
  component    text PRIMARY KEY,
  version      text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  note         text
);

-- ---------------------------------------------------------------- identifiers
-- UUIDv7: 48-bit Unix milliseconds + random bits (RFC 9562), for index locality.
CREATE FUNCTION core.uuid_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  b  bytea  := uuid_send(gen_random_uuid());
BEGIN
  b := set_byte(b, 0, ((ms >> 40) & 255)::int);
  b := set_byte(b, 1, ((ms >> 32) & 255)::int);
  b := set_byte(b, 2, ((ms >> 24) & 255)::int);
  b := set_byte(b, 3, ((ms >> 16) & 255)::int);
  b := set_byte(b, 4, ((ms >> 8)  & 255)::int);
  b := set_byte(b, 5, (ms & 255)::int);
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);   -- version 7
  b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128);   -- RFC 4122 variant
  RETURN encode(b, 'hex')::uuid;
END
$$;

-- The system actor (seeded in §20) is the author of system writes and seeds.
CREATE FUNCTION core.system_actor_id() RETURNS uuid
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT '00000000-0000-7000-8000-000000000001'::uuid $$;

-- ------------------------------------------------------------ request context
-- The tenancy library (backend/libs L5) opens every transaction with
-- core.set_context(...). Values are transaction-local (SET LOCAL semantics).
--   actor_type: anonymous | user | staff | system
--   user_id:    the authenticated user (staff user on the admin plane)
--   org_id:     the organization of the path ({org}), already authorized
--   role:       the caller's role in that organization (for audit only)
--   anon_key:   hash of an anonymous token's device key (anonymous search)
CREATE FUNCTION core.set_context(
  p_actor_type text, p_user_id uuid DEFAULT NULL, p_org_id uuid DEFAULT NULL,
  p_role text DEFAULT NULL, p_request_id text DEFAULT NULL, p_anon_key text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_actor_type NOT IN ('anonymous', 'user', 'staff', 'system') THEN
    RAISE EXCEPTION 'invalid actor_type %', p_actor_type USING ERRCODE = '22023';
  END IF;
  IF p_actor_type = 'system' AND NOT pg_has_role(current_user, 'carpal_ctx_system', 'MEMBER') THEN
    RAISE EXCEPTION 'role % may not use the system context', current_user USING ERRCODE = '42501';
  END IF;
  IF p_actor_type = 'staff' AND NOT pg_has_role(current_user, 'carpal_ctx_staff', 'MEMBER') THEN
    RAISE EXCEPTION 'role % may not use the staff context', current_user USING ERRCODE = '42501';
  END IF;
  IF p_actor_type IN ('user', 'staff') AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required for actor_type %', p_actor_type USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.actor_type', p_actor_type, true);
  PERFORM set_config('app.user_id',    coalesce(p_user_id::text, ''), true);
  PERFORM set_config('app.org_id',     coalesce(p_org_id::text, ''), true);
  PERFORM set_config('app.role',       coalesce(p_role, ''), true);
  PERFORM set_config('app.request_id', coalesce(p_request_id, ''), true);
  PERFORM set_config('app.anon_key',   coalesce(p_anon_key, ''), true);
END
$$;
COMMENT ON FUNCTION core.set_context IS 'Sets the transaction-local RLS context (40 SEC-AZ-3). Call first in every transaction.';

CREATE FUNCTION core.actor_type() RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$ SELECT coalesce(nullif(current_setting('app.actor_type', true), ''), 'anonymous') $$;

CREATE FUNCTION core.me() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION core.my_org() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

CREATE FUNCTION core.my_anon_key() RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.anon_key', true), '') $$;

CREATE FUNCTION core.request_id() RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.request_id', true), '') $$;

-- True only for roles that hold the marker role AND declared the context.
CREATE FUNCTION core.is_system() RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$ SELECT current_setting('app.actor_type', true) = 'system'
           AND pg_has_role(current_user, 'carpal_ctx_system', 'MEMBER') $$;

CREATE FUNCTION core.is_staff() RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$ SELECT current_setting('app.actor_type', true) = 'staff'
           AND nullif(current_setting('app.user_id', true), '') IS NOT NULL
           AND pg_has_role(current_user, 'carpal_ctx_staff', 'MEMBER') $$;

-- Actor written into created_by / changed_by columns.
CREATE FUNCTION core.actor_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$ SELECT coalesce(nullif(current_setting('app.user_id', true), '')::uuid,
                      '00000000-0000-7000-8000-000000000001'::uuid) $$;

-- ----------------------------------------------------------- text and locale
-- Persian/Arabic-Indic digits → Latin (52 §2.5).
CREATE FUNCTION core.latin_digits(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
SET search_path = pg_catalog
AS $$ SELECT translate(t, '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', '01234567890123456789') $$;

-- Search normalization (52 §2.5): NFC, Arabic ي/ى/ك → Persian ی/ی/ک, Latin digits,
-- ZWNJ and tatweel removed for matching, whitespace collapsed, lower case.
CREATE FUNCTION core.normalize_search_text(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
SET search_path = pg_catalog
AS $$
  SELECT lower(btrim(regexp_replace(
           translate(core.latin_digits(normalize(t, NFC)), 'يىك' || chr(8204) || 'ـ', 'ییک '),
           '\s+', ' ', 'g')))
$$;

-- A translations map: {"<locale>": "<non-empty text>", ...} (52 §2.4).
CREATE FUNCTION core.translations_valid(j jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT j IS NULL OR (
    jsonb_typeof(j) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(j) e
       WHERE e.key !~ '^[a-z]{2}$'
          OR jsonb_typeof(e.value) <> 'string'
          OR char_length(e.value #>> '{}') = 0))
$$;

-- Every value of a translations map is at most max_len characters and the map
-- has at least min_locales entries.
CREATE FUNCTION core.translations_ok(j jsonb, max_len int, min_locales int DEFAULT 1) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT j IS NULL OR (
    core.translations_valid(j)
    AND (SELECT count(*) FROM jsonb_object_keys(j)) >= min_locales
    AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(j) e WHERE char_length(e.value) > max_len))
$$;

-- Read rule: requested locale → en → first available (52 §2.4).
CREATE FUNCTION core.l10n(j jsonb, loc text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT coalesce(j ->> loc, j ->> 'en',
                  (SELECT e.value FROM jsonb_each_text(j) e ORDER BY e.key LIMIT 1))
$$;

-- -------------------------------------------------------------------- geo
-- Great-circle distance in metres (no PostGIS in the MVP; geo search runs in
-- Elasticsearch).
CREATE FUNCTION core.distance_m(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
SET search_path = pg_catalog
AS $$
  SELECT round(2 * 6371008.8 * asin(sqrt(
           power(sin(radians((lat2 - lat1)::float8) / 2), 2)
         + cos(radians(lat1::float8)) * cos(radians(lat2::float8))
         * power(sin(radians((lng2 - lng1)::float8) / 2), 2))))::int
$$;

-- -------------------------------------------------------------- domains
CREATE DOMAIN core.locale   AS text CHECK (VALUE ~ '^[a-z]{2}$');
CREATE DOMAIN core.lang     AS text CHECK (VALUE ~ '^[a-z]{2}$');
CREATE DOMAIN core.currency AS text CHECK (VALUE ~ '^[A-Z]{3}$');
CREATE DOMAIN core.country  AS text CHECK (VALUE ~ '^[A-Z]{2}$');
CREATE DOMAIN core.email    AS text CHECK (char_length(VALUE) <= 254 AND VALUE = lower(VALUE)
                                           AND VALUE ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');
CREATE DOMAIN core.phone    AS text CHECK (VALUE ~ '^\+[1-9][0-9]{6,14}$');
CREATE DOMAIN core.url      AS text CHECK (char_length(VALUE) <= 2048 AND VALUE ~ '^https://[^[:space:]@]+$');
CREATE DOMAIN core.slug     AS text CHECK (VALUE ~ '^[a-z0-9]([a-z0-9-]{0,78}[a-z0-9])?$');
CREATE DOMAIN core.tz       AS text CHECK (char_length(VALUE) <= 64 AND VALUE ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)*$');
CREATE DOMAIN core.lat      AS numeric(9,6) CHECK (VALUE BETWEEN -90 AND 90);
CREATE DOMAIN core.lng      AS numeric(9,6) CHECK (VALUE BETWEEN -180 AND 180);
CREATE DOMAIN core.amount   AS numeric(12,2) CHECK (VALUE >= 0);
CREATE DOMAIN core.score    AS smallint CHECK (VALUE BETWEEN 0 AND 100);
CREATE DOMAIN core.rating   AS smallint CHECK (VALUE BETWEEN 1 AND 5);
CREATE DOMAIN core.km       AS integer  CHECK (VALUE BETWEEN 0 AND 2000000);
CREATE DOMAIN core.translations AS jsonb CHECK (core.translations_valid(VALUE));
CREATE DOMAIN core.hash     AS bytea CHECK (octet_length(VALUE) = 32);   -- HMAC-SHA-256 / SHA-256

-- Core enums (52 §3). Text + CHECK so a new value is a one-line migration (40 TR-3).
CREATE DOMAIN core.user_status AS text CHECK (VALUE IN ('pending_verification','active','suspended','deactivated','deleted'));
CREATE DOMAIN core.org_type AS text CHECK (VALUE IN ('provider','vendor','fleet','hybrid_provider_vendor'));
CREATE DOMAIN core.org_status AS text CHECK (VALUE IN ('draft','pending_verification','active','suspended','archived','merged'));
CREATE DOMAIN core.verification_status AS text CHECK (VALUE IN ('unverified','pending','verified','rejected','expired','suspended'));
CREATE DOMAIN core.publication_status AS text CHECK (VALUE IN ('draft','published','suspended'));
CREATE DOMAIN core.owner_type AS text CHECK (VALUE IN ('user','organization'));
CREATE DOMAIN core.requester_type AS text CHECK (VALUE IN ('user','fleet'));
CREATE DOMAIN core.vehicle_status AS text CHECK (VALUE IN ('active','inactive','sold','in_repair','archived'));
CREATE DOMAIN core.urgency_level AS text CHECK (VALUE IN ('low','medium','high','safety_critical'));
CREATE DOMAIN core.appointment_status AS text CHECK (VALUE IN ('draft','requested','provider_reviewing','alternative_proposed',
  'confirmed','checked_in','in_progress','awaiting_parts','ready_for_pickup','completed','cancelled','no_show'));
CREATE DOMAIN core.appointment_type AS text CHECK (VALUE IN ('diagnosis','repair','inspection','bodywork_estimate','parts_installation'));
CREATE DOMAIN core.service_mode AS text CHECK (VALUE IN ('in_shop','mobile','pickup_dropoff'));
CREATE DOMAIN core.review_status AS text CHECK (VALUE IN ('draft','pending_moderation','pending_approval','published','rejected','removed'));
CREATE DOMAIN core.confirmation_path AS text CHECK (VALUE IN ('visit_based','approval_based'));
CREATE DOMAIN core.verified_status AS text CHECK (VALUE IN ('appointment_verified','inquiry_verified','service_record_verified',
  'invoice_verified','fleet_confirmed','admin_verified','pending_approval','approved_without_visit','rejected'));
CREATE DOMAIN core.business_confirmation_status AS text CHECK (VALUE IN ('pending','confirmed','rejected','no_response'));
CREATE DOMAIN core.reviewer_decision AS text CHECK (VALUE IN ('pending','approved','rejected','evidence_requested'));
CREATE DOMAIN core.geo_source AS text CHECK (VALUE IN ('user_pin','geocoded','admin_corrected'));
CREATE DOMAIN core.address_visibility AS text CHECK (VALUE IN ('exact','approximate'));
CREATE DOMAIN core.capability_source AS text CHECK (VALUE IN ('self_declared','ai_suggested','job_evidence','review_evidence','certification','admin_verified'));
CREATE DOMAIN core.confidence_level AS text CHECK (VALUE IN ('self_declared','low_evidence','moderate_evidence','strong_evidence','verified_expert'));
CREATE DOMAIN core.approval_gated_status AS text CHECK (VALUE IN ('pending_provider_approval','active','rejected','inactive'));
CREATE DOMAIN core.experience_level AS text CHECK (VALUE IN ('beginner','intermediate','advanced','specialist'));
CREATE DOMAIN core.inventory_status AS text CHECK (VALUE IN ('draft','active','pending_review','hidden','discontinued','removed'));
CREATE DOMAIN core.stock_status AS text CHECK (VALUE IN ('in_stock','low_stock','out_of_stock','available_on_request'));
CREATE DOMAIN core.fitment_confidence AS text CHECK (VALUE IN ('confirmed','likely','uncertain'));
CREATE DOMAIN core.moderation_status AS text CHECK (VALUE IN ('pending','approved','rejected'));
CREATE DOMAIN core.content_visibility AS text CHECK (VALUE IN ('public','unlisted','private'));
CREATE DOMAIN core.price_tier AS text CHECK (VALUE IN ('budget','mid_range','premium','unspecified'));
CREATE DOMAIN core.notification_channel AS text CHECK (VALUE IN ('in_app','email','push','sms'));
CREATE DOMAIN core.notification_category AS text CHECK (VALUE IN ('appointments','reviews','inquiries','service_reminders',
  'ai_suggestions','fleet','community','moderation','inventory','system','marketing'));
CREATE DOMAIN core.mcp_risk_level AS text CHECK (VALUE IN ('read_only','personalized_read','draft_creation','external_action','admin_action'));
CREATE DOMAIN core.human_approval_status AS text CHECK (VALUE IN ('not_required','pending','approved','rejected'));
CREATE DOMAIN core.role_key AS text CHECK (VALUE IN ('individual','fleet_owner','fleet_manager','fleet_maintenance_coordinator',
  'fleet_driver','fleet_viewer','provider_owner','provider_manager','provider_staff','vendor_owner','vendor_staff',
  'platform_admin','platform_moderator','platform_support','platform_community_reviewer'));
CREATE DOMAIN core.consent_type AS text CHECK (VALUE IN ('vehicle_data_sharing','service_history_sharing','vendor_fitment_context',
  'photo_publishing','showcase_publishing','ai_personalization','review_invitations','fleet_driver_data_visibility',
  'fleet_data_ai_use','provider_analytics_ai_use','vendor_inventory_ai_use','location_usage','marketing'));
CREATE DOMAIN core.consent_scope_type AS text CHECK (VALUE IN ('vehicle','appointment','media_asset','portfolio_item','stock_inquiry'));
CREATE DOMAIN core.media_consent_status AS text CHECK (VALUE IN ('not_required','requested','granted','withdrawn'));
CREATE DOMAIN core.moderation_reason AS text CHECK (VALUE IN ('fake','abusive','hate_speech','harassment','spam','off_topic',
  'privacy','unsafe_advice','misleading','counterfeit','inaccurate_fitment','wrong_location_or_closed','impersonation',
  'non_consensual_media','consent_issue','redaction_issue','hallucination','other'));
CREATE DOMAIN core.report_target_type AS text CHECK (VALUE IN ('review','review_response','post','comment','question','answer',
  'portfolio_item','media_asset','inventory_item','inventory_fitment','organization','organization_location','user','ai_output'));
CREATE DOMAIN core.taxonomy_type AS text CHECK (VALUE IN ('vehicle_brand','vehicle_model','vehicle_series','engine_type','fuel_type',
  'service_system','service_task','part_category','symptom','review_tag','amenity'));
CREATE DOMAIN core.insight_type AS text CHECK (VALUE IN ('triage_summary','urgency_assessment','maintenance_suggestion',
  'provider_match','match_explanation','vehicle_field_suggestion','vehicle_summary','service_history_summary','recurring_issue',
  'category_extraction','resolution_status_suggestion','duplicate_record','skill_heatmap','capability_suggestion',
  'profile_suggestion','badge_eligibility','review_sentiment','review_theme','review_response_draft','review_quality_score',
  'improvement_suggestion','showcase_caption','showcase_draft','redaction_suggestion','appointment_slot_suggestion',
  'customer_need_summary','pre_visit_summary','inventory_normalization','fitment_suggestion','duplicate_inventory',
  'inventory_gap','catalog_quality','fleet_suggestion','fraud_flag','duplicate_entity','search_synonym_suggestion',
  'query_interpretation','moderation_recommendation','profile_confidence_score','likely_specialization'));
CREATE DOMAIN core.environment AS text CHECK (VALUE IN ('dev','staging','prod'));

-- ----------------------------------------------------------- generic triggers
-- updated_at / version / immutable id and created_at (52 §2.1).
CREATE FUNCTION core.tg_touch() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.id         := OLD.id;
  NEW.created_at := OLD.created_at;
  NEW.created_by := OLD.created_by;
  NEW.updated_at := now();
  NEW.updated_by := coalesce(nullif(current_setting('app.user_id', true), '')::uuid, NEW.updated_by);
  NEW.version    := OLD.version + 1;
  RETURN NEW;
END
$$;

-- Append-only tables (audit, histories, logs): no UPDATE or DELETE, ever.
CREATE FUNCTION core.tg_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'table %.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '42501';
END
$$;

-- -------------------------------------------------------------- outbox (WP1)
-- 52 §20 DomainEventOutbox. Written in the same transaction as the change.
CREATE TABLE core.domain_event_outbox (
  event_id       uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  event_type     text NOT NULL CHECK (event_type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  aggregate_type text NOT NULL CHECK (char_length(aggregate_type) BETWEEN 1 AND 60),
  aggregate_id   uuid NOT NULL,
  organization_id uuid,
  payload        jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  request_id     text,
  published_at   timestamptz,
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error     text CHECK (char_length(last_error) <= 1000),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','failed')),
  CHECK (status <> 'published' OR published_at IS NOT NULL)
);
CREATE INDEX domain_event_outbox_pending_idx ON core.domain_event_outbox (occurred_at) WHERE status = 'pending';
CREATE INDEX domain_event_outbox_aggregate_idx ON core.domain_event_outbox (aggregate_type, aggregate_id);
COMMENT ON TABLE core.domain_event_outbox IS '52 DomainEventOutbox — transactional outbox relayed to NATS JetStream by W1';

CREATE FUNCTION core.tg_outbox_notify() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM pg_notify('carpal_outbox', '');
  RETURN NULL;
END
$$;
CREATE TRIGGER outbox_notify AFTER INSERT ON core.domain_event_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION core.tg_outbox_notify();

-- Helper used by every module: core.publish_event('review.published', 'review', id, '{...}').
-- SECURITY DEFINER: the application roles may only INSERT into the outbox; the
-- RETURNING clause would otherwise need SELECT on the table and a SELECT policy.
CREATE FUNCTION core.publish_event(p_event_type text, p_aggregate_type text, p_aggregate_id uuid,
                                   p_payload jsonb DEFAULT '{}'::jsonb, p_schema_version int DEFAULT 1)
RETURNS uuid
LANGUAGE sql VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  INSERT INTO core.domain_event_outbox (event_type, aggregate_type, aggregate_id, organization_id, payload, schema_version, request_id)
  VALUES (p_event_type, p_aggregate_type, p_aggregate_id, nullif(current_setting('app.org_id', true), '')::uuid,
          p_payload, p_schema_version, nullif(current_setting('app.request_id', true), ''))
  RETURNING event_id
$$;

-- ---------------------------------------------------------- background jobs
-- 52 §20 BackgroundJob: durable record behind every `202 Job` (40 §4.1).
CREATE TABLE core.background_jobs (
  id              uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid DEFAULT core.me(),
  updated_by      uuid,
  version         integer NOT NULL DEFAULT 1,
  kind            text NOT NULL CHECK (kind IN ('ai_insight','inventory_import','fleet_import','fleet_export','data_export',
                    'pre_visit_report','bulk_inventory_update','taxonomy_merge','redaction')),
  owner_user_id   uuid NOT NULL,
  organization_id uuid,
  owning_module   text NOT NULL CHECK (owning_module ~ '^[a-z_-]{2,40}$'),
  input_summary   jsonb CHECK (input_summary IS NULL OR jsonb_typeof(input_summary) = 'object'),
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  progress        smallint CHECK (progress BETWEEN 0 AND 100),
  result_type     text CHECK (result_type IN ('ai_insight','inventory_import_batch','fleet_import_batch','fleet_export',
                    'data_subject_request','pre_visit_report','match_session','media_asset','taxonomy_node')),
  result_id       uuid,
  error_code      text CHECK (error_code ~ '^[A-Z_]{3,60}$'),
  started_at      timestamptz,
  finished_at     timestamptz,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '7 days',
  CHECK (status <> 'succeeded' OR (result_type IS NOT NULL AND result_id IS NOT NULL)),
  CHECK (status <> 'failed' OR error_code IS NOT NULL)
);
CREATE INDEX background_jobs_owner_idx ON core.background_jobs (owner_user_id, created_at DESC);
CREATE INDEX background_jobs_org_idx ON core.background_jobs (organization_id, created_at DESC) WHERE organization_id IS NOT NULL;
CREATE INDEX background_jobs_open_idx ON core.background_jobs (status) WHERE status IN ('queued','running');
COMMENT ON TABLE core.background_jobs IS '52 BackgroundJob — status and ownership of asynchronous API work (queue runs on BullMQ)';

-- ------------------------------------------------------- monthly partitions
-- Creates the monthly partitions of the partitioned log tables. Run daily by the
-- scheduler (W15) as carpal_worker; it can only touch the allowlisted tables.
CREATE FUNCTION core.ensure_monthly_partitions(p_table text, p_months_ahead int DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  m        date;
  created  integer := 0;
  part     text;
  sch      text := split_part(p_table, '.', 1);
  tbl      text := split_part(p_table, '.', 2);
BEGIN
  IF p_table NOT IN ('analytics.audit_logs', 'ai_mcp.mcp_access_logs') THEN
    RAISE EXCEPTION 'table % is not a managed partitioned table', p_table USING ERRCODE = '42501';
  END IF;
  IF p_months_ahead NOT BETWEEN 0 AND 24 THEN
    RAISE EXCEPTION 'months_ahead must be 0..24' USING ERRCODE = '22023';
  END IF;
  FOR i IN 0 .. p_months_ahead LOOP
    m := (date_trunc('month', now()) + make_interval(months => i))::date;
    part := format('%s_y%sm%s', tbl, to_char(m, 'YYYY'), to_char(m, 'MM'));
    IF to_regclass(format('%I.%I', sch, part)) IS NULL THEN
      EXECUTE format('CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
                     sch, part, sch, tbl, m, (m + interval '1 month')::date);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$$;

-- Every module table carries the common columns of 52 §2.1 and §2.3:
--   id, version, created_at, created_by, updated_at, updated_by, deleted_at,
--   deletion_reason. core.tg_touch() maintains them (attached in §17).
-- Cross-module references (52 "xref") are plain uuid columns WITHOUT foreign
-- keys (Plan §14.5); same-module references have foreign keys.

\echo '== 5. identity (WP2)'

-- =============================================================================
-- 5. identity — accounts, authentication, preferences, roles, consent (WP2)
-- =============================================================================
CREATE SCHEMA identity;
COMMENT ON SCHEMA identity IS 'Module identity (WP2): accounts, authentication, roles, consent, DSR, onboarding';

CREATE TABLE identity.user_accounts (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  full_name                 text NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 100),
  display_name              text CHECK (char_length(display_name) BETWEEN 2 AND 50),
  email                     core.email NOT NULL,
  phone                     core.phone,
  locale                    core.locale NOT NULL DEFAULT 'en',
  timezone                  core.tz NOT NULL DEFAULT 'UTC',
  status                    core.user_status NOT NULL DEFAULT 'pending_verification',
  email_verified_at         timestamptz,
  phone_verified_at         timestamptz,
  mfa_enabled               boolean NOT NULL DEFAULT false,
  preferred_contact_channel core.notification_channel,
  last_active_at            timestamptz,
  anonymized_at             timestamptz,
  trusted_user              boolean NOT NULL DEFAULT false,
  terms_version             text NOT NULL CHECK (char_length(terms_version) BETWEEN 1 AND 20),
  privacy_policy_version    text NOT NULL CHECK (char_length(privacy_policy_version) BETWEEN 1 AND 20),
  terms_accepted_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_accounts_active_needs_contact
    CHECK (status <> 'active' OR email_verified_at IS NOT NULL OR phone_verified_at IS NOT NULL)
);
CREATE UNIQUE INDEX user_accounts_email_uq ON identity.user_accounts (email)
  WHERE deleted_at IS NULL AND status <> 'deleted';
CREATE UNIQUE INDEX user_accounts_phone_uq ON identity.user_accounts (phone)
  WHERE phone IS NOT NULL AND deleted_at IS NULL AND status <> 'deleted';
COMMENT ON TABLE identity.user_accounts IS '52 UserAccount. Sessions live in Redis, not here.';

CREATE TABLE identity.authentication_methods (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  user_id              uuid NOT NULL REFERENCES identity.user_accounts (id),
  method_type          text NOT NULL CHECK (method_type IN ('email_password','phone_otp','oidc_social','totp_mfa','webauthn','recovery_code')),
  provider_name        text CHECK (provider_name ~ '^[a-z0-9_-]{2,40}$'),
  identifier           text NOT NULL CHECK (char_length(identifier) BETWEEN 1 AND 512),
  label                text CHECK (char_length(label) BETWEEN 1 AND 60),
  credential_reference text CHECK (char_length(credential_reference) <= 1024),
  credential_data      jsonb CHECK (credential_data IS NULL OR jsonb_typeof(credential_data) = 'object'),
  verified_at          timestamptz,
  last_used_at         timestamptz,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  CHECK (method_type <> 'oidc_social' OR provider_name IS NOT NULL),
  CHECK (method_type NOT IN ('email_password','phone_otp','totp_mfa','recovery_code') OR credential_reference IS NOT NULL),
  CHECK (method_type <> 'webauthn' OR credential_data IS NOT NULL)
);
CREATE UNIQUE INDEX authentication_methods_identifier_uq
  ON identity.authentication_methods (method_type, coalesce(provider_name, ''), identifier);
CREATE INDEX authentication_methods_user_idx ON identity.authentication_methods (user_id, method_type);
COMMENT ON TABLE identity.authentication_methods IS '52 AuthenticationMethod. Credentials are hashes or secret-store keys only.';

CREATE TABLE identity.verification_tokens (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  user_id      uuid NOT NULL REFERENCES identity.user_accounts (id),
  token_type   text NOT NULL CHECK (token_type IN ('email_verification','password_reset')),
  token_hash   core.hash NOT NULL UNIQUE,
  target_email core.email,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','expired','revoked')),
  CHECK (token_type <> 'email_verification' OR target_email IS NOT NULL),
  CHECK ((status = 'used') = (used_at IS NOT NULL))
);
CREATE INDEX verification_tokens_user_idx ON identity.verification_tokens (user_id, token_type) WHERE status = 'active';
COMMENT ON TABLE identity.verification_tokens IS '52 VerificationToken — ev/pr link tokens (40 SEC-LT), HMAC only';

CREATE TABLE identity.role_memberships (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  user_id               uuid REFERENCES identity.user_accounts (id),
  organization_id       uuid,                                     -- xref organization
  role                  core.role_key NOT NULL,
  permission_overrides  text[] NOT NULL DEFAULT '{}' CHECK (cardinality(permission_overrides) <= 100),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended','removed')),
  invited_by            uuid REFERENCES identity.user_accounts (id),
  invited_email         core.email,
  invitation_token_hash core.hash UNIQUE,
  invitation_expires_at timestamptz,
  joined_at             timestamptz,
  CONSTRAINT role_memberships_org_rule
    CHECK ((role = 'individual' OR role LIKE 'platform\_%') = (organization_id IS NULL)),
  CHECK (status = 'invited' OR user_id IS NOT NULL),
  CHECK (status <> 'active' OR joined_at IS NOT NULL),
  CHECK (status <> 'invited' OR (invited_email IS NOT NULL AND invitation_token_hash IS NOT NULL
                                 AND invitation_expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX role_memberships_individual_uq ON identity.role_memberships (user_id) WHERE role = 'individual';
CREATE UNIQUE INDEX role_memberships_org_uq ON identity.role_memberships (user_id, organization_id)
  WHERE organization_id IS NOT NULL AND user_id IS NOT NULL AND status <> 'removed';
CREATE UNIQUE INDEX role_memberships_invite_uq ON identity.role_memberships (organization_id, invited_email)
  WHERE status = 'invited';
CREATE UNIQUE INDEX role_memberships_platform_uq ON identity.role_memberships (user_id, role)
  WHERE organization_id IS NULL AND role LIKE 'platform\_%' AND status <> 'removed';
CREATE INDEX role_memberships_org_idx ON identity.role_memberships (organization_id, status) WHERE organization_id IS NOT NULL;
COMMENT ON TABLE identity.role_memberships IS '52 RoleMembership — one active role per user per organization; implicit individual role';

CREATE TABLE identity.user_preferences (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  user_id                    uuid NOT NULL UNIQUE REFERENCES identity.user_accounts (id),
  default_role_membership_id uuid REFERENCES identity.role_memberships (id),
  calendar_system            text NOT NULL DEFAULT 'gregorian' CHECK (calendar_system IN ('gregorian','jalali')),
  digit_style                text NOT NULL DEFAULT 'latin' CHECK (digit_style IN ('latin','persian')),
  distance_unit              text NOT NULL DEFAULT 'km' CHECK (distance_unit IN ('km','mi')),
  navigation_app_key         text CHECK (navigation_app_key ~ '^[a-z0-9_.-]{1,40}$'),
  preferred_currency         core.currency,
  profile_visibility         text NOT NULL DEFAULT 'members_only' CHECK (profile_visibility IN ('public','members_only','private')),
  show_vehicles_on_profile   boolean NOT NULL DEFAULT false,
  ai_personalization_enabled boolean NOT NULL DEFAULT false,
  ai_suggestions_enabled     boolean NOT NULL DEFAULT true,
  critical_alerts_only       boolean NOT NULL DEFAULT false,
  marketing_opt_in           boolean NOT NULL DEFAULT false
);
COMMENT ON TABLE identity.user_preferences IS '52 UserPreference — one per user, created with the account';

CREATE TABLE identity.consent_records (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  subject_type      text NOT NULL CHECK (subject_type IN ('user','organization')),
  subject_id        uuid NOT NULL,
  consent_type      core.consent_type NOT NULL,
  scope_entity_type core.consent_scope_type,
  scope_entity_id   uuid,
  granted_to_type   text CHECK (granted_to_type IN ('organization','platform','mcp_client')),
  granted_to_id     uuid,
  policy_version    text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 20),
  granted           boolean NOT NULL,
  granted_at        timestamptz,
  withdrawn_at      timestamptz,
  expires_at        timestamptz,
  source            text NOT NULL CHECK (source IN ('ui','admin','import','api')),
  CHECK ((scope_entity_type IS NULL) = (scope_entity_id IS NULL)),
  CHECK (granted_to_type IS NULL OR granted_to_type = 'platform' OR granted_to_id IS NOT NULL),
  CHECK (NOT granted OR granted_at IS NOT NULL),
  CHECK (withdrawn_at IS NULL OR granted_at IS NULL OR withdrawn_at >= granted_at),
  CHECK (subject_type = 'user' OR consent_type IN ('fleet_data_ai_use','provider_analytics_ai_use','vendor_inventory_ai_use'))
);
CREATE INDEX consent_records_subject_idx ON identity.consent_records (subject_type, subject_id, consent_type)
  WHERE granted AND withdrawn_at IS NULL;
CREATE INDEX consent_records_grantee_idx ON identity.consent_records (granted_to_type, granted_to_id, consent_type)
  WHERE granted AND withdrawn_at IS NULL;
CREATE INDEX consent_records_scope_idx ON identity.consent_records (scope_entity_type, scope_entity_id)
  WHERE scope_entity_id IS NOT NULL;
COMMENT ON TABLE identity.consent_records IS '52 ConsentRecord — immutable except withdrawn_at (trigger)';

-- Consent records are immutable except the one-time withdrawal (52 §4).
CREATE FUNCTION identity.tg_consent_immutable() RETURNS trigger
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
      NEW.granted_to_type, NEW.granted_to_id, NEW.policy_version, NEW.granted, NEW.granted_at,
      NEW.expires_at, NEW.source)
     IS DISTINCT FROM
     (OLD.subject_type, OLD.subject_id, OLD.consent_type, OLD.scope_entity_type, OLD.scope_entity_id,
      OLD.granted_to_type, OLD.granted_to_id, OLD.policy_version, OLD.granted, OLD.granted_at,
      OLD.expires_at, OLD.source)
     OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at) THEN
    RAISE EXCEPTION 'consent records are immutable except a single withdrawal' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER consent_records_immutable BEFORE UPDATE OR DELETE ON identity.consent_records
  FOR EACH ROW EXECUTE FUNCTION identity.tg_consent_immutable();

CREATE TABLE identity.consent_requests (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  requested_by_organization_id uuid NOT NULL,                     -- xref organization
  requested_by_user_id         uuid NOT NULL,
  subject_user_id              uuid NOT NULL REFERENCES identity.user_accounts (id),
  consent_type                 core.consent_type NOT NULL,
  scope_entity_type            core.consent_scope_type NOT NULL,
  scope_entity_id              uuid NOT NULL,
  source_visit_type            text NOT NULL CHECK (source_visit_type IN ('appointment','service_record')),
  source_visit_id              uuid NOT NULL,
  purpose_i18n_key             text NOT NULL CHECK (purpose_i18n_key ~ '^[a-z0-9_.]{1,120}$'),
  token_hash                   core.hash NOT NULL UNIQUE,
  expires_at                   timestamptz NOT NULL,
  used_at                      timestamptz,
  status                       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','granted','declined','expired','cancelled')),
  resulting_consent_id         uuid REFERENCES identity.consent_records (id),
  CHECK (status <> 'granted' OR (resulting_consent_id IS NOT NULL AND used_at IS NOT NULL))
);
CREATE UNIQUE INDEX consent_requests_pending_uq ON identity.consent_requests
  (subject_user_id, consent_type, scope_entity_type, scope_entity_id) WHERE status = 'pending';
CREATE INDEX consent_requests_org_idx ON identity.consent_requests (requested_by_organization_id, status);
COMMENT ON TABLE identity.consent_requests IS '52 ConsentRequest — cn link (40 §6.4)';

CREATE TABLE identity.data_subject_requests (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  user_id               uuid NOT NULL REFERENCES identity.user_accounts (id),
  request_type          text NOT NULL CHECK (request_type IN ('export','deletion','rectification','consent_withdrawal')),
  details               text CHECK (char_length(details) <= 2000),
  status                text NOT NULL DEFAULT 'received'
                          CHECK (status IN ('received','verifying_identity','in_progress','completed','rejected')),
  requested_at          timestamptz NOT NULL DEFAULT now(),
  due_at                timestamptz NOT NULL DEFAULT now() + interval '30 days',   -- policy deadline (one month)
  export_media_asset_id uuid,                                    -- xref media
  handled_by            uuid,
  rejection_reason      text CHECK (char_length(rejection_reason) BETWEEN 1 AND 500),
  completed_at          timestamptz,
  CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CHECK (NOT (status = 'completed' AND request_type = 'export') OR export_media_asset_id IS NOT NULL)
);
CREATE UNIQUE INDEX data_subject_requests_open_uq ON identity.data_subject_requests (user_id, request_type)
  WHERE status IN ('received','verifying_identity','in_progress');
CREATE INDEX data_subject_requests_due_idx ON identity.data_subject_requests (due_at)
  WHERE status IN ('received','verifying_identity','in_progress');
COMMENT ON TABLE identity.data_subject_requests IS '52 DataSubjectRequest (MVP §14)';

CREATE TABLE identity.onboarding_progress (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  user_id             uuid NOT NULL REFERENCES identity.user_accounts (id),
  organization_id     uuid,                                      -- xref organization
  flow_type           text NOT NULL CHECK (flow_type IN ('individual','fleet','provider','vendor')),
  current_step        text NOT NULL CHECK (char_length(current_step) BETWEEN 1 AND 60),
  completed_steps     text[] NOT NULL DEFAULT '{}' CHECK (cardinality(completed_steps) <= 50),
  status              text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','abandoned','reset')),
  completed_at        timestamptz,
  reset_by            uuid,
  assisted            boolean NOT NULL DEFAULT false,
  assisted_by_user_id uuid,
  terms_version       text CHECK (char_length(terms_version) BETWEEN 1 AND 20),
  terms_accepted_at   timestamptz,
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CHECK (status <> 'reset' OR reset_by IS NOT NULL),
  CHECK (NOT assisted OR assisted_by_user_id IS NOT NULL),
  CHECK (NOT (assisted AND status = 'completed') OR terms_accepted_at IS NOT NULL)
);
CREATE UNIQUE INDEX onboarding_progress_flow_uq ON identity.onboarding_progress (user_id, flow_type, organization_id) NULLS NOT DISTINCT;
COMMENT ON TABLE identity.onboarding_progress IS '52 OnboardingProgress (MVP Module A)';

-- Every new account gets its preferences and the implicit individual role (52 §4).
CREATE FUNCTION identity.tg_user_bootstrap() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO identity.user_preferences (user_id, calendar_system, digit_style, created_by)
  VALUES (NEW.id,
          CASE WHEN NEW.locale = 'fa' THEN 'jalali' ELSE 'gregorian' END,
          CASE WHEN NEW.locale = 'fa' THEN 'persian' ELSE 'latin' END,
          NEW.created_by);
  INSERT INTO identity.role_memberships (user_id, role, status, joined_at, created_by)
  VALUES (NEW.id, 'individual', 'active', now(), NEW.created_by);
  RETURN NULL;
END
$$;
CREATE TRIGGER user_accounts_bootstrap AFTER INSERT ON identity.user_accounts
  FOR EACH ROW EXECUTE FUNCTION identity.tg_user_bootstrap();

-- Minimal public-safe user card for other modules (requester names, review
-- authors). Never returns contact data (40 SEC-OUT-3).
CREATE FUNCTION identity.user_cards(p_ids uuid[])
RETURNS TABLE (id uuid, display_name text, status text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT u.id,
         CASE WHEN u.anonymized_at IS NOT NULL THEN NULL
              ELSE coalesce(u.display_name, split_part(u.full_name, ' ', 1)) END,
         u.status::text
    FROM identity.user_accounts u
   WHERE u.id = ANY (p_ids[1:500])
$$;
COMMENT ON FUNCTION identity.user_cards IS 'Cross-module display card: id, display name, status only';

\echo '== 6. organization (WP3, WP6, WP7)'

-- =============================================================================
-- 6. organization — organizations, locations, provider and vendor profiles
-- =============================================================================
CREATE SCHEMA organization;
COMMENT ON SCHEMA organization IS 'Module organization (WP3, WP6, WP7): organizations, locations, verification, provider and vendor profiles';

CREATE TABLE organization.organizations (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  name                        text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  legal_name                  text CHECK (char_length(legal_name) BETWEEN 2 AND 160),
  organization_type           core.org_type NOT NULL,
  verification_status         core.verification_status NOT NULL DEFAULT 'unverified',
  primary_location_id         uuid,
  contact_email               core.email NOT NULL,
  contact_phone               core.phone,
  website                     core.url,
  description_translations    core.translations CHECK (core.translations_ok(description_translations, 2000)),
  slug                        core.slug,
  trust_score                 core.score,
  merged_into_organization_id uuid REFERENCES organization.organizations (id),
  status                      core.org_status NOT NULL DEFAULT 'draft',
  CHECK (status <> 'merged' OR merged_into_organization_id IS NOT NULL),
  CHECK (merged_into_organization_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX organizations_slug_uq ON organization.organizations (slug) WHERE slug IS NOT NULL;
CREATE INDEX organizations_type_status_idx ON organization.organizations (organization_type, status);
COMMENT ON TABLE organization.organizations IS '52 Organization — provider, vendor, fleet or hybrid';

CREATE TABLE organization.organization_locations (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  organization_id                  uuid NOT NULL REFERENCES organization.organizations (id),
  name                             text CHECK (char_length(name) BETWEEN 2 AND 120),
  address_line_1                   text NOT NULL CHECK (char_length(address_line_1) BETWEEN 2 AND 160),
  address_line_2                   text CHECK (char_length(address_line_2) <= 160),
  city                             text NOT NULL CHECK (char_length(city) BETWEEN 1 AND 100),
  region                           text CHECK (char_length(region) <= 100),
  postal_code                      text CHECK (char_length(postal_code) <= 20),
  country                          core.country NOT NULL,
  latitude                         core.lat NOT NULL,              -- exact point (members and staff only)
  longitude                        core.lng NOT NULL,
  geo_source                       core.geo_source NOT NULL,
  geo_address_distance_m           integer CHECK (geo_address_distance_m >= 0),
  location_check_status            text NOT NULL DEFAULT 'not_checked'
                                     CHECK (location_check_status IN ('not_checked','consistent','far_apart')),
  public_address_visibility        core.address_visibility NOT NULL DEFAULT 'exact',
  public_latitude                  core.lat NOT NULL,              -- set by trigger (0.01° when approximate)
  public_longitude                 core.lng NOT NULL,
  timezone                         core.tz NOT NULL,
  service_radius_km                integer CHECK (service_radius_km BETWEEN 0 AND 1000),
  phone                            core.phone,
  email                            core.email,
  primary_contact_user_id          uuid,                          -- xref identity
  access_instructions_translations core.translations CHECK (core.translations_ok(access_instructions_translations, 500)),
  hours                            jsonb CHECK (hours IS NULL OR jsonb_typeof(hours) = 'object'),
  location_verified_at             timestamptz,
  is_primary                       boolean NOT NULL DEFAULT false,
  status                           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive'))
);
CREATE UNIQUE INDEX organization_locations_primary_uq ON organization.organization_locations (organization_id)
  WHERE is_primary AND status = 'active' AND deleted_at IS NULL;
CREATE INDEX organization_locations_org_idx ON organization.organization_locations (organization_id, status);
COMMENT ON TABLE organization.organization_locations IS '52 OrganizationLocation — one map pin per location; public point by trigger';

ALTER TABLE organization.organizations
  ADD CONSTRAINT organizations_primary_location_fk FOREIGN KEY (primary_location_id)
  REFERENCES organization.organization_locations (id) DEFERRABLE INITIALLY DEFERRED;

-- Public point: exact for `exact`, rounded to 0.01° for `approximate` (40 SEC-OUT-4).
-- Moving the pin or the address clears the location verification.
CREATE FUNCTION organization.tg_location_public_point() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.public_address_visibility = 'approximate' THEN
    NEW.public_latitude  := round(NEW.latitude, 2);
    NEW.public_longitude := round(NEW.longitude, 2);
  ELSE
    NEW.public_latitude  := NEW.latitude;
    NEW.public_longitude := NEW.longitude;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.latitude, NEW.longitude, NEW.address_line_1, NEW.city, NEW.postal_code, NEW.country)
                          IS DISTINCT FROM
                          (OLD.latitude, OLD.longitude, OLD.address_line_1, OLD.city, OLD.postal_code, OLD.country) THEN
    NEW.location_verified_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER organization_locations_public_point BEFORE INSERT OR UPDATE ON organization.organization_locations
  FOR EACH ROW EXECUTE FUNCTION organization.tg_location_public_point();

CREATE TABLE organization.organization_verifications (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  organization_id        uuid NOT NULL REFERENCES organization.organizations (id),
  verification_type      text NOT NULL CHECK (verification_type IN ('business_identity','address','phone','email','location')),
  submitted_document_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(submitted_document_ids) <= 10),
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected','expired')),
  reviewed_by            uuid,
  reviewed_at            timestamptz,
  rejection_reason       text CHECK (char_length(rejection_reason) BETWEEN 1 AND 500),
  expires_at             timestamptz,
  CHECK (status NOT IN ('verified','rejected') OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);
CREATE UNIQUE INDEX organization_verifications_pending_uq ON organization.organization_verifications (organization_id, verification_type)
  WHERE status = 'pending';
CREATE INDEX organization_verifications_queue_idx ON organization.organization_verifications (status, created_at);
COMMENT ON TABLE organization.organization_verifications IS '52 OrganizationVerification (MVP §13)';

CREATE TABLE organization.provider_profiles (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  organization_id                uuid NOT NULL UNIQUE REFERENCES organization.organizations (id),
  provider_type                  text NOT NULL CHECK (provider_type IN ('independent_mechanic','garage','body_shop','mobile_mechanic',
                                   'tire_wheel_specialist','transmission_specialist','ev_hybrid_specialist',
                                   'detailing_reconditioning','diagnostics_specialist','fleet_service_center')),
  description_translations       core.translations CHECK (core.translations_ok(description_translations, 3000)),
  years_in_business              integer CHECK (years_in_business BETWEEN 0 AND 150),
  languages_spoken               core.lang[] NOT NULL DEFAULT '{}' CHECK (cardinality(languages_spoken) <= 20),
  amenity_node_ids               uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(amenity_node_ids) <= 20),   -- xref taxonomy
  service_modes                  text[] NOT NULL CHECK (cardinality(service_modes) BETWEEN 1 AND 3
                                   AND service_modes <@ ARRAY['in_shop','mobile','pickup_dropoff']),
  contact_channels               jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(contact_channels) = 'array'
                                   AND jsonb_array_length(contact_channels) <= 10),
  price_tier                     core.price_tier NOT NULL DEFAULT 'unspecified',
  warranty_offered               boolean NOT NULL DEFAULT false,
  warranty_policy_translations   core.translations CHECK (core.translations_ok(warranty_policy_translations, 1000)),
  response_time_target           text CHECK (response_time_target IN ('within_2h','same_day','within_24h','within_48h')),
  measured_response_time_minutes integer CHECK (measured_response_time_minutes >= 0),
  appointment_capacity_enabled   boolean NOT NULL DEFAULT false,
  profile_completeness           core.score NOT NULL DEFAULT 0,
  activity_status                text NOT NULL DEFAULT 'active' CHECK (activity_status IN ('active','inactive')),
  public_status                  core.publication_status NOT NULL DEFAULT 'draft',
  CHECK (NOT warranty_offered OR warranty_policy_translations IS NOT NULL)
);
CREATE INDEX provider_profiles_public_idx ON organization.provider_profiles (public_status, provider_type);
COMMENT ON TABLE organization.provider_profiles IS '52 ProviderProfile (MVP §3.3)';

CREATE TABLE organization.provider_certifications (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  provider_organization_id uuid NOT NULL REFERENCES organization.organizations (id),
  certification_type       text NOT NULL CHECK (certification_type IN ('manufacturer','industry','trade_license','ev_high_voltage','safety','other')),
  name                     text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  issuer                   text NOT NULL CHECK (char_length(issuer) BETWEEN 2 AND 160),
  credential_number        text CHECK (char_length(credential_number) <= 80),
  scope_node_ids           uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(scope_node_ids) <= 20),
  issued_at                date,
  expires_at               date,
  document_media_asset_id  uuid,                                 -- xref media
  verification_status      core.verification_status NOT NULL DEFAULT 'unverified',
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','removed')),
  CHECK (expires_at IS NULL OR issued_at IS NULL OR expires_at > issued_at),
  CHECK (verification_status <> 'verified' OR document_media_asset_id IS NOT NULL)
);
CREATE INDEX provider_certifications_org_idx ON organization.provider_certifications (provider_organization_id, status);
COMMENT ON TABLE organization.provider_certifications IS '52 ProviderCertification — only verified ones count as evidence';

CREATE TABLE organization.provider_service_categories (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  provider_organization_id  uuid NOT NULL REFERENCES organization.organizations (id),
  taxonomy_node_id          uuid NOT NULL,                        -- xref taxonomy (service_system | service_task)
  display_name_translations core.translations CHECK (core.translations_ok(display_name_translations, 120)),
  description_translations  core.translations CHECK (core.translations_ok(description_translations, 1000)),
  experience_level          core.experience_level NOT NULL,
  price_indicator           core.price_tier,
  typical_duration_minutes  integer CHECK (typical_duration_minutes BETWEEN 5 AND 1440),
  appointment_types         text[] NOT NULL DEFAULT '{}' CHECK (appointment_types <@
                              ARRAY['diagnosis','repair','inspection','bodywork_estimate','parts_installation']),
  visibility                text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  source                    core.capability_source NOT NULL DEFAULT 'self_declared',
  ai_insight_id             uuid,                                 -- xref ai_mcp
  status                    core.approval_gated_status NOT NULL DEFAULT 'active',
  CHECK (source <> 'ai_suggested' OR ai_insight_id IS NOT NULL),
  UNIQUE (provider_organization_id, taxonomy_node_id)
);
COMMENT ON TABLE organization.provider_service_categories IS '52 ProviderServiceCategory — the service catalog';

CREATE TABLE organization.provider_vehicle_coverage (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  provider_organization_id uuid NOT NULL REFERENCES organization.organizations (id),
  brand_node_id            uuid NOT NULL,
  model_node_id            uuid,
  series_node_id           uuid,
  engine_type_node_id      uuid,
  fuel_type_node_id        uuid,
  coverage_level           text NOT NULL CHECK (coverage_level IN ('basic','standard','advanced','specialist')),
  source                   core.capability_source NOT NULL DEFAULT 'self_declared',
  ai_insight_id            uuid,
  status                   core.approval_gated_status NOT NULL DEFAULT 'active',
  CHECK (series_node_id IS NULL OR model_node_id IS NOT NULL),
  CHECK (source <> 'ai_suggested' OR ai_insight_id IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (provider_organization_id, brand_node_id, model_node_id, series_node_id, engine_type_node_id, fuel_type_node_id)
);
COMMENT ON TABLE organization.provider_vehicle_coverage IS '52 ProviderVehicleCoverage — unlimited rows';

CREATE TABLE organization.provider_capabilities (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  provider_organization_id uuid NOT NULL REFERENCES organization.organizations (id),
  brand_node_id            uuid,
  model_node_id            uuid,
  series_node_id           uuid,
  service_system_node_id   uuid NOT NULL,
  service_task_node_id     uuid,
  experience_level         core.experience_level NOT NULL,
  confidence_level         core.confidence_level NOT NULL DEFAULT 'self_declared',
  confidence_score         numeric(8,2) NOT NULL DEFAULT 0,
  evidence_count           integer NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  public_visibility        boolean NOT NULL DEFAULT false,
  badge_eligible           boolean NOT NULL DEFAULT false,
  source                   core.capability_source NOT NULL DEFAULT 'self_declared',
  ai_insight_id            uuid,
  status                   core.approval_gated_status NOT NULL DEFAULT 'active',
  CHECK (series_node_id IS NULL OR model_node_id IS NOT NULL),
  CHECK (NOT badge_eligible OR confidence_level IN ('strong_evidence','verified_expert')),
  CHECK (source <> 'ai_suggested' OR ai_insight_id IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (provider_organization_id, brand_node_id, model_node_id, series_node_id,
                             service_system_node_id, service_task_node_id)
);
CREATE INDEX provider_capabilities_system_idx ON organization.provider_capabilities (service_system_node_id, confidence_level)
  WHERE status = 'active';
COMMENT ON TABLE organization.provider_capabilities IS '52 ProviderCapability — confidence grows only from evidence (54 §2)';

CREATE TABLE organization.provider_capability_evidence (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  capability_id         uuid NOT NULL REFERENCES organization.provider_capabilities (id),
  evidence_type         text NOT NULL CHECK (evidence_type IN ('completed_appointment','verified_review','portfolio_item',
                          'service_record','certification','job_log')),
  reference_entity_type text NOT NULL CHECK (reference_entity_type IN ('appointment','review','portfolio_item',
                          'service_record','certification','job_log')),
  reference_entity_id   uuid NOT NULL,
  base_weight           smallint NOT NULL CHECK (base_weight BETWEEN -100 AND 100),
  evidence_date         date NOT NULL,
  linked_by             text NOT NULL CHECK (linked_by IN ('system_rule','ai_mapping','provider','admin')),
  ai_insight_id         uuid,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('pending_approval','active','revoked')),
  CHECK (linked_by <> 'ai_mapping' OR ai_insight_id IS NOT NULL),
  UNIQUE (capability_id, reference_entity_type, reference_entity_id)
);
COMMENT ON TABLE organization.provider_capability_evidence IS '52 ProviderCapabilityEvidence — immutable once counted, except revocation';

-- Counted evidence is immutable; revoked evidence stays revoked (54 §9).
CREATE FUNCTION organization.tg_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.linked_by = 'ai_mapping' AND NEW.status <> 'pending_approval' THEN
      RAISE EXCEPTION 'AI-linked evidence starts as pending_approval (54 §2.2)' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('active','revoked')
     AND (NEW.capability_id, NEW.evidence_type, NEW.reference_entity_type, NEW.reference_entity_id,
          NEW.base_weight, NEW.evidence_date, NEW.linked_by, NEW.ai_insight_id)
         IS DISTINCT FROM
         (OLD.capability_id, OLD.evidence_type, OLD.reference_entity_type, OLD.reference_entity_id,
          OLD.base_weight, OLD.evidence_date, OLD.linked_by, OLD.ai_insight_id) THEN
    RAISE EXCEPTION 'counted evidence is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
    RAISE EXCEPTION 'revoked evidence cannot be restored' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'pending_approval' THEN
    RAISE EXCEPTION 'counted evidence cannot return to pending' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER provider_capability_evidence_immutable BEFORE INSERT OR UPDATE ON organization.provider_capability_evidence
  FOR EACH ROW EXECUTE FUNCTION organization.tg_evidence_immutable();

CREATE TABLE organization.provider_job_logs (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  provider_organization_id uuid NOT NULL REFERENCES organization.organizations (id),
  job_date                 date NOT NULL,
  brand_node_id            uuid,
  model_node_id            uuid,
  series_node_id           uuid,
  service_system_node_id   uuid NOT NULL,
  service_task_node_id     uuid,
  description              text CHECK (char_length(description) <= 3000),
  vehicle_id               uuid,                                  -- xref vehicle; consent-gated
  appointment_id           uuid,
  service_record_id        uuid,
  logged_by_user_id        uuid NOT NULL,
  verification_status      text NOT NULL DEFAULT 'self_reported'
                             CHECK (verification_status IN ('self_reported','appointment_verified','customer_confirmed','invoice_verified')),
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed'))
);
CREATE INDEX provider_job_logs_org_idx ON organization.provider_job_logs (provider_organization_id, job_date DESC);
COMMENT ON TABLE organization.provider_job_logs IS '52 ProviderJobLog (MVP Module C)';

CREATE TABLE organization.provider_customer_notes (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  provider_organization_id uuid NOT NULL REFERENCES organization.organizations (id),
  customer_user_id         uuid NOT NULL,
  vehicle_id               uuid,
  body                     text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  author_user_id           uuid NOT NULL,
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed'))
);
CREATE INDEX provider_customer_notes_customer_idx ON organization.provider_customer_notes (provider_organization_id, customer_user_id);
CREATE INDEX provider_customer_notes_export_idx ON organization.provider_customer_notes (customer_user_id);   -- DSR export
COMMENT ON TABLE organization.provider_customer_notes IS '52 ProviderCustomerNote — org-private; part of the customer''s data export';

CREATE TABLE organization.portfolio_items (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  provider_organization_id uuid NOT NULL REFERENCES organization.organizations (id),
  title                    text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 140),
  description              text CHECK (char_length(description) <= 3000),
  content_locale           core.locale NOT NULL,
  brand_node_id            uuid,
  model_node_id            uuid,
  series_node_id           uuid,
  service_system_node_id   uuid NOT NULL,
  service_task_node_id     uuid,
  tag_node_ids             uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(tag_node_ids) <= 20),
  job_date                 date,
  job_log_id               uuid REFERENCES organization.provider_job_logs (id),
  service_record_id        uuid,
  appointment_id           uuid,
  customer_consent_status  core.media_consent_status NOT NULL DEFAULT 'not_required',
  consent_reference_id     uuid,
  caption                  text CHECK (char_length(caption) <= 1000),
  caption_source           text CHECK (caption_source IN ('manual','ai_approved')),
  ai_caption_insight_id    uuid,
  visibility               core.content_visibility NOT NULL DEFAULT 'public',
  moderation_status        core.moderation_status NOT NULL DEFAULT 'pending',
  like_count               integer NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  published_at             timestamptz,
  status                   text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','published','rejected','archived')),
  CHECK (caption IS NULL OR caption_source IS NOT NULL),
  CHECK (customer_consent_status <> 'granted' OR consent_reference_id IS NOT NULL),
  CONSTRAINT portfolio_items_publish_rule CHECK (status <> 'published' OR (published_at IS NOT NULL
    AND moderation_status = 'approved' AND customer_consent_status IN ('not_required','granted')))
);
CREATE INDEX portfolio_items_org_idx ON organization.portfolio_items (provider_organization_id, status);
CREATE INDEX portfolio_items_public_idx ON organization.portfolio_items (service_system_node_id, published_at DESC)
  WHERE status = 'published' AND visibility = 'public';
COMMENT ON TABLE organization.portfolio_items IS '52 PortfolioItem (MVP §5.6) — before/after media via media.media_attachments';

CREATE TABLE organization.vendor_profiles (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  organization_id                uuid NOT NULL UNIQUE REFERENCES organization.organizations (id),
  vendor_type                    text NOT NULL CHECK (vendor_type IN ('parts_retailer','wholesaler','used_parts_specialist',
                                   'performance_parts','oem_supplier','tire_specialist','battery_specialist','accessories')),
  description_translations       core.translations CHECK (core.translations_ok(description_translations, 3000)),
  delivery_options               text[] NOT NULL CHECK (cardinality(delivery_options) BETWEEN 1 AND 3
                                   AND delivery_options <@ ARRAY['pickup','local_delivery','shipping_future']),
  trade_customers_supported      boolean NOT NULL DEFAULT false,
  default_price_visibility       text NOT NULL DEFAULT 'public' CHECK (default_price_visibility IN ('public','trade_only','on_request')),
  return_policy_translations     core.translations CHECK (core.translations_ok(return_policy_translations, 1000)),
  warranty_policy_translations   core.translations CHECK (core.translations_ok(warranty_policy_translations, 1000)),
  response_time_target           text CHECK (response_time_target IN ('within_2h','same_day','within_24h','within_48h')),
  measured_response_time_minutes integer CHECK (measured_response_time_minutes >= 0),
  catalog_quality_score          core.score NOT NULL DEFAULT 0,
  profile_completeness           core.score NOT NULL DEFAULT 0,
  catalog_coming_soon            boolean NOT NULL DEFAULT false,
  public_status                  core.publication_status NOT NULL DEFAULT 'draft',
  CONSTRAINT vendor_profiles_mvp_reserved CHECK (NOT ('shipping_future' = ANY (delivery_options)))   -- reserved (52 §23)
);
COMMENT ON TABLE organization.vendor_profiles IS '52 VendorProfile (MVP §3.4)';

CREATE TABLE organization.vendor_coverage (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  vendor_organization_id uuid NOT NULL REFERENCES organization.organizations (id),
  taxonomy_node_id       uuid NOT NULL,
  coverage_type          text NOT NULL CHECK (coverage_type IN ('brand','model','part_category')),
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  UNIQUE (vendor_organization_id, taxonomy_node_id, coverage_type)
);
COMMENT ON TABLE organization.vendor_coverage IS '52 VendorCoverage';

-- Public organization card for other modules.
CREATE FUNCTION organization.org_cards(p_ids uuid[])
RETURNS TABLE (id uuid, name text, organization_type text, slug text, status text, verification_status text, trust_score smallint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT o.id, o.name, o.organization_type::text, o.slug::text, o.status::text, o.verification_status::text, o.trust_score::smallint
    FROM organization.organizations o
   WHERE o.id = ANY (p_ids[1:500])
$$;

\echo '== 7. billing (WP3)'

-- =============================================================================
-- 7. billing — plans, entitlements, subscriptions (WP3)
-- =============================================================================
CREATE SCHEMA billing;
COMMENT ON SCHEMA billing IS 'Module billing (WP3): plans, entitlements, subscriptions';

CREATE TABLE billing.plans (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  plan_key               text NOT NULL UNIQUE CHECK (plan_key IN ('individual_free','fleet_20','fleet_50','fleet_100',
                           'fleet_custom','provider_basic','provider_pro','vendor_basic','vendor_pro')),
  audience               text NOT NULL CHECK (audience IN ('individual','fleet','provider','vendor')),
  name_i18n_key          text NOT NULL CHECK (name_i18n_key ~ '^[a-z0-9_.]{1,120}$'),
  max_vehicles           integer CHECK (max_vehicles >= 0),
  max_users              integer CHECK (max_users >= 0),
  trial_days             integer CHECK (trial_days BETWEEN 0 AND 365),
  is_default_for_audience boolean NOT NULL DEFAULT false,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive'))
);
CREATE UNIQUE INDEX plans_default_uq ON billing.plans (audience) WHERE is_default_for_audience;
COMMENT ON TABLE billing.plans IS '52 Plan (MVP §5.12) — names come from the UI dictionary';

CREATE TABLE billing.entitlements (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  plan_id         uuid NOT NULL REFERENCES billing.plans (id),
  entitlement_key text NOT NULL CHECK (entitlement_key IN ('max_vehicles','max_fleet_users','ai_tools_enabled',
                    'ai_fleet_suggestions_enabled','max_inventory_items','inventory_bulk_import_enabled',
                    'appointment_capacity_tools_enabled','advanced_analytics_enabled','fleet_reports_enabled',
                    'fleet_approval_workflow_enabled','featured_placement_eligible','export_enabled')),
  value_type      text NOT NULL CHECK (value_type IN ('boolean','integer')),
  value           text,
  UNIQUE (plan_id, entitlement_key),
  CHECK ((value_type = 'boolean' AND value IN ('true','false'))
      OR (value_type = 'integer' AND (value IS NULL OR value ~ '^[0-9]{1,10}$')))   -- null integer = unlimited
);
COMMENT ON TABLE billing.entitlements IS '52 Entitlement — enforced server-side inside write transactions';

CREATE TABLE billing.subscriptions (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  subscriber_type            text NOT NULL CHECK (subscriber_type IN ('user','organization')),
  subscriber_id              uuid NOT NULL,                       -- xref identity / organization
  plan_id                    uuid NOT NULL REFERENCES billing.plans (id),
  status                     text NOT NULL DEFAULT 'active' CHECK (status IN ('trial','active','expired','cancelled','past_due_future')),
  billing_mode               text NOT NULL DEFAULT 'manual' CHECK (billing_mode IN ('manual','self_serve_future')),
  started_at                 timestamptz NOT NULL DEFAULT now(),
  trial_ends_at              timestamptz,
  expires_at                 timestamptz,
  assigned_by                uuid,
  vehicle_limit_override     integer CHECK (vehicle_limit_override >= 0),
  user_limit_override        integer CHECK (user_limit_override >= 0),
  entitlement_overrides      jsonb CHECK (entitlement_overrides IS NULL OR jsonb_typeof(entitlement_overrides) = 'object'),
  external_billing_reference text CHECK (char_length(external_billing_reference) <= 200),
  CHECK (status <> 'trial' OR trial_ends_at IS NOT NULL),
  CHECK (expires_at IS NULL OR expires_at > started_at),
  CONSTRAINT subscriptions_mvp_reserved CHECK (status <> 'past_due_future' AND billing_mode = 'manual')
);
CREATE UNIQUE INDEX subscriptions_current_uq ON billing.subscriptions (subscriber_type, subscriber_id)
  WHERE status IN ('trial','active');
CREATE INDEX subscriptions_trial_idx ON billing.subscriptions (trial_ends_at) WHERE status = 'trial';
COMMENT ON TABLE billing.subscriptions IS '52 Subscription — one active or trial subscription per subscriber';

-- Plan audience must match the subscriber kind (individual ↔ user).
CREATE FUNCTION billing.tg_subscription_audience() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  aud text;
BEGIN
  SELECT p.audience INTO aud FROM billing.plans p WHERE p.id = NEW.plan_id;
  IF (NEW.subscriber_type = 'user') <> (aud = 'individual') THEN
    RAISE EXCEPTION 'plan audience % does not match subscriber type %', aud, NEW.subscriber_type USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER subscriptions_audience BEFORE INSERT OR UPDATE OF plan_id, subscriber_type ON billing.subscriptions
  FOR EACH ROW EXECUTE FUNCTION billing.tg_subscription_audience();

CREATE TABLE billing.subscription_change_requests (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  organization_id           uuid NOT NULL,
  requested_by_user_id      uuid NOT NULL,
  current_subscription_id   uuid REFERENCES billing.subscriptions (id),
  requested_plan_id         uuid NOT NULL REFERENCES billing.plans (id),
  note                      text CHECK (char_length(note) <= 1000),
  status                    text NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','declined','withdrawn')),
  handled_by                uuid,
  handled_at                timestamptz,
  resulting_subscription_id uuid REFERENCES billing.subscriptions (id),
  CHECK (status NOT IN ('assigned','declined') OR (handled_by IS NOT NULL AND handled_at IS NOT NULL)),
  CHECK (status <> 'assigned' OR resulting_subscription_id IS NOT NULL)
);
CREATE UNIQUE INDEX subscription_change_requests_open_uq ON billing.subscription_change_requests (organization_id)
  WHERE status = 'open';
COMMENT ON TABLE billing.subscription_change_requests IS '52 SubscriptionChangeRequest — admin assigns the plan manually in the MVP';

-- Effective entitlement value for a subscriber: override → plan value (null = unlimited).
CREATE FUNCTION billing.effective_entitlement(p_subscriber_type text, p_subscriber_id uuid, p_key text)
RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
           WHEN p_key = 'max_vehicles' AND s.vehicle_limit_override IS NOT NULL THEN s.vehicle_limit_override::text
           WHEN p_key = 'max_fleet_users' AND s.user_limit_override IS NOT NULL THEN s.user_limit_override::text
           WHEN s.entitlement_overrides ? p_key THEN s.entitlement_overrides ->> p_key
           ELSE e.value
         END
    FROM billing.subscriptions s
    LEFT JOIN billing.entitlements e ON e.plan_id = s.plan_id AND e.entitlement_key = p_key
   WHERE s.subscriber_type = p_subscriber_type AND s.subscriber_id = p_subscriber_id
     AND s.status IN ('trial','active')
$$;
COMMENT ON FUNCTION billing.effective_entitlement IS 'Read inside the write transaction with the subscription row locked (40 SEC-AZ-9)';

\echo '== 8. taxonomy (WP4)'

-- =============================================================================
-- 8. taxonomy — controlled vocabulary (WP4)
-- =============================================================================
CREATE SCHEMA taxonomy;
COMMENT ON SCHEMA taxonomy IS 'Module taxonomy (WP4): nodes, synonyms, mappings';

CREATE TABLE taxonomy.taxonomy_nodes (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  type                     core.taxonomy_type NOT NULL,
  parent_id                uuid REFERENCES taxonomy.taxonomy_nodes (id),
  name_translations        core.translations NOT NULL
                             CHECK (name_translations ?& ARRAY['en','fa'] AND core.translations_ok(name_translations, 120)),
  description_translations core.translations CHECK (core.translations_ok(description_translations, 500)),
  slug                     core.slug NOT NULL,
  regions                  core.country[] NOT NULL DEFAULT '{}',
  attributes               jsonb CHECK (attributes IS NULL OR jsonb_typeof(attributes) = 'object'),
  sort_order               integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  merged_into_id           uuid REFERENCES taxonomy.taxonomy_nodes (id),
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','deprecated','merged')),
  CHECK (status <> 'merged' OR merged_into_id IS NOT NULL),
  CHECK (parent_id IS DISTINCT FROM id),
  UNIQUE NULLS NOT DISTINCT (type, parent_id, slug)
);
CREATE INDEX taxonomy_nodes_type_idx ON taxonomy.taxonomy_nodes (type, parent_id, sort_order) WHERE status = 'active';
CREATE INDEX taxonomy_nodes_name_gin ON taxonomy.taxonomy_nodes USING gin (name_translations jsonb_path_ops);
CREATE INDEX taxonomy_nodes_safety_idx ON taxonomy.taxonomy_nodes (id)
  WHERE type = 'symptom' AND (attributes ->> 'safety_critical')::boolean IS TRUE;
COMMENT ON TABLE taxonomy.taxonomy_nodes IS '52 TaxonomyNode — EN and FA labels required';

-- Parent rules, no cycles, type-specific attribute keys (52 §7).
CREATE FUNCTION taxonomy.tg_node_rules() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  parent_type text;
  allowed     text[];
  bad_key     text;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT n.type INTO parent_type FROM taxonomy.taxonomy_nodes n WHERE n.id = NEW.parent_id;
    IF NOT (
         (NEW.type = 'vehicle_model'  AND parent_type = 'vehicle_brand')
      OR (NEW.type = 'vehicle_series' AND parent_type = 'vehicle_model')
      OR (NEW.type = 'engine_type'    AND parent_type IN ('vehicle_brand','vehicle_model','vehicle_series'))
      OR (NEW.type = 'service_task'   AND parent_type = 'service_system')
      OR (NEW.type = 'part_category'  AND parent_type = 'part_category')
      OR (NEW.type = 'symptom'        AND parent_type = 'symptom')) THEN
      RAISE EXCEPTION 'TAXONOMY_MISMATCH: % cannot have a % parent', NEW.type, coalesce(parent_type, 'missing')
        USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (
        WITH RECURSIVE up AS (
          SELECT n.id, n.parent_id FROM taxonomy.taxonomy_nodes n WHERE n.id = NEW.parent_id
          UNION
          SELECT n.id, n.parent_id FROM taxonomy.taxonomy_nodes n JOIN up ON n.id = up.parent_id)
        SELECT 1 FROM up WHERE up.id = NEW.id) THEN
      RAISE EXCEPTION 'TAXONOMY_MISMATCH: circular parent' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.type IN ('vehicle_model','vehicle_series','service_task') THEN
    RAISE EXCEPTION 'TAXONOMY_MISMATCH: % needs a parent', NEW.type USING ERRCODE = '23514';
  END IF;

  allowed := CASE NEW.type
    WHEN 'vehicle_series' THEN ARRAY['production_start_year','production_end_year']
    WHEN 'engine_type'    THEN ARRAY['engine_code','displacement_cc','performance_variant']
    WHEN 'fuel_type'      THEN ARRAY['powertrain']
    WHEN 'symptom'        THEN ARRAY['safety_critical']
    WHEN 'review_tag'     THEN ARRAY['sentiment','applies_to']
    WHEN 'part_category'  THEN ARRAY['position_applicable']
    ELSE ARRAY[]::text[] END;
  SELECT k INTO bad_key FROM jsonb_object_keys(coalesce(NEW.attributes, '{}'::jsonb)) k
   WHERE NOT (k = ANY (allowed)) LIMIT 1;
  IF bad_key IS NOT NULL THEN
    RAISE EXCEPTION 'attribute % is not allowed for type %', bad_key, NEW.type USING ERRCODE = '23514';
  END IF;
  IF NEW.type = 'symptom' AND NEW.attributes ? 'safety_critical'
     AND jsonb_typeof(NEW.attributes -> 'safety_critical') <> 'boolean' THEN
    RAISE EXCEPTION 'safety_critical must be boolean' USING ERRCODE = '23514';
  END IF;
  IF NEW.type = 'fuel_type' AND NEW.attributes ? 'powertrain'
     AND NOT (NEW.attributes ->> 'powertrain' IN ('petrol','diesel','hybrid','plug_in_hybrid','electric')) THEN
    RAISE EXCEPTION 'invalid powertrain' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER taxonomy_nodes_rules BEFORE INSERT OR UPDATE OF type, parent_id, attributes ON taxonomy.taxonomy_nodes
  FOR EACH ROW EXECUTE FUNCTION taxonomy.tg_node_rules();

CREATE TABLE taxonomy.taxonomy_synonyms (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  taxonomy_node_id uuid NOT NULL REFERENCES taxonomy.taxonomy_nodes (id),
  term             text NOT NULL CHECK (char_length(term) BETWEEN 1 AND 120),
  term_normalized  text GENERATED ALWAYS AS (core.normalize_search_text(term)) STORED,
  locale           core.locale NOT NULL,
  synonym_type     text NOT NULL CHECK (synonym_type IN ('synonym','alias','misspelling','local_term','abbreviation','transliteration')),
  script           text CHECK (script IN ('native','latin')),
  source           text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai_suggested','import')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('pending_review','active','inactive')),
  CHECK (synonym_type <> 'transliteration' OR script IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (taxonomy_node_id, term, locale, script)
);
CREATE INDEX taxonomy_synonyms_term_idx ON taxonomy.taxonomy_synonyms (term_normalized) WHERE status = 'active';
CREATE INDEX taxonomy_synonyms_review_idx ON taxonomy.taxonomy_synonyms (created_at) WHERE status = 'pending_review';
COMMENT ON TABLE taxonomy.taxonomy_synonyms IS '52 TaxonomySynonym — AI suggestions need admin approval';

CREATE TABLE taxonomy.taxonomy_mappings (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  source_node_id uuid NOT NULL REFERENCES taxonomy.taxonomy_nodes (id),
  target_node_id uuid NOT NULL REFERENCES taxonomy.taxonomy_nodes (id),
  mapping_type   text NOT NULL CHECK (mapping_type IN ('symptom_to_system','symptom_to_task','part_category_to_system','task_to_part_category')),
  weight         smallint NOT NULL CHECK (weight BETWEEN 0 AND 100),
  source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai_suggested','import')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('pending_review','active','inactive')),
  CHECK (source_node_id <> target_node_id),
  UNIQUE (source_node_id, target_node_id, mapping_type)
);
CREATE INDEX taxonomy_mappings_target_idx ON taxonomy.taxonomy_mappings (target_node_id, mapping_type);
COMMENT ON TABLE taxonomy.taxonomy_mappings IS '52 TaxonomyMapping — powers triage, matching and fitment';

CREATE FUNCTION taxonomy.tg_mapping_types() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  st text; tt text;
BEGIN
  SELECT type INTO st FROM taxonomy.taxonomy_nodes WHERE id = NEW.source_node_id;
  SELECT type INTO tt FROM taxonomy.taxonomy_nodes WHERE id = NEW.target_node_id;
  IF NOT ((NEW.mapping_type = 'symptom_to_system'       AND st = 'symptom'       AND tt = 'service_system')
       OR (NEW.mapping_type = 'symptom_to_task'         AND st = 'symptom'       AND tt = 'service_task')
       OR (NEW.mapping_type = 'part_category_to_system' AND st = 'part_category' AND tt = 'service_system')
       OR (NEW.mapping_type = 'task_to_part_category'   AND st = 'service_task'  AND tt = 'part_category')) THEN
    RAISE EXCEPTION 'TAXONOMY_MISMATCH: % does not map % to %', NEW.mapping_type, st, tt USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER taxonomy_mappings_types BEFORE INSERT OR UPDATE ON taxonomy.taxonomy_mappings
  FOR EACH ROW EXECUTE FUNCTION taxonomy.tg_mapping_types();

-- Reason recorded in history rows written by triggers (status changes).
CREATE FUNCTION core.set_change_reason(p_reason text) RETURNS void
LANGUAGE sql VOLATILE
SET search_path = pg_catalog
AS $$ SELECT set_config('app.change_reason', coalesce(left(p_reason, 500), ''), true) $$;

\echo '== 9. vehicle (WP5)'

-- =============================================================================
-- 9. vehicle — vehicles, service history, issues, reminders (WP5)
-- =============================================================================
CREATE SCHEMA vehicle;
COMMENT ON SCHEMA vehicle IS 'Module vehicle (WP5): vehicles, documents, service history, issues, reminders';

CREATE TABLE vehicle.vehicles (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  owner_type             core.owner_type NOT NULL,
  owner_id               uuid NOT NULL,                           -- xref user or fleet organization
  vin_encrypted          bytea,                                   -- 52 `vin`: AES-256-GCM envelope (40 SEC-CR)
  vin_hash               core.hash,                               -- keyed HMAC-SHA-256
  vin_last4              text CHECK (vin_last4 ~ '^[A-HJ-NPR-Z0-9]{4}$'),
  vin_decode_status      text NOT NULL DEFAULT 'not_attempted'
                           CHECK (vin_decode_status IN ('not_attempted','decoded','partial','failed','manual')),
  vin_decoder_source     text CHECK (char_length(vin_decoder_source) <= 60),
  vin_decoded_at         timestamptz,
  license_plate          text CHECK (char_length(license_plate) <= 20),
  nickname               text CHECK (char_length(nickname) BETWEEN 1 AND 60),
  brand_node_id          uuid NOT NULL,
  model_node_id          uuid NOT NULL,
  series_node_id         uuid,
  year                   integer NOT NULL CHECK (year BETWEEN 1950 AND 2100),   -- ≤ current year + 2 (application)
  engine_type_node_id    uuid,
  fuel_type_node_id      uuid,
  transmission           text CHECK (transmission IN ('manual','automatic','cvt','dct','other')),
  drivetrain             text CHECK (drivetrain IN ('fwd','rwd','awd','4wd')),
  body_style             text CHECK (body_style IN ('sedan','hatchback','wagon','coupe','convertible','suv','pickup','van','minivan','other')),
  color                  text CHECK (char_length(color) <= 50),
  mileage_km             core.km,
  ownership_start_date   date,
  primary_photo_media_id uuid,
  notes                  text CHECK (char_length(notes) <= 2000),
  status                 core.vehicle_status NOT NULL DEFAULT 'active',
  profile_completeness   core.score NOT NULL DEFAULT 0,
  obd_profile            jsonb,
  CHECK ((vin_encrypted IS NULL) = (vin_hash IS NULL) AND (vin_hash IS NULL) = (vin_last4 IS NULL)),
  CONSTRAINT vehicles_mvp_reserved CHECK (obd_profile IS NULL)            -- Phase 2 OBDII hook
);
CREATE UNIQUE INDEX vehicles_vin_per_owner_uq ON vehicle.vehicles (owner_type, owner_id, vin_hash)
  WHERE vin_hash IS NOT NULL AND status <> 'archived' AND deleted_at IS NULL;
CREATE INDEX vehicles_vin_hash_idx ON vehicle.vehicles (vin_hash) WHERE vin_hash IS NOT NULL;   -- duplicate VIN warning
CREATE INDEX vehicles_owner_idx ON vehicle.vehicles (owner_type, owner_id, status);
COMMENT ON TABLE vehicle.vehicles IS '52 Vehicle — VIN encrypted; only vin_last4 is returned by normal reads';

CREATE TABLE vehicle.vehicle_status_history (
  id          uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  vehicle_id  uuid NOT NULL REFERENCES vehicle.vehicles (id),
  old_status  core.vehicle_status,
  new_status  core.vehicle_status NOT NULL,
  changed_by  uuid NOT NULL DEFAULT core.actor_id(),
  reason      text CHECK (char_length(reason) <= 500),
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicle_status_history_vehicle_idx ON vehicle.vehicle_status_history (vehicle_id, changed_at);
COMMENT ON TABLE vehicle.vehicle_status_history IS '52 VehicleStatusHistory — append-only; feeds fleet downtime';

CREATE FUNCTION vehicle.tg_vehicle_status_history() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO vehicle.vehicle_status_history (vehicle_id, old_status, new_status, reason)
    VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
            nullif(current_setting('app.change_reason', true), ''));
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER vehicles_status_history AFTER INSERT OR UPDATE OF status ON vehicle.vehicles
  FOR EACH ROW EXECUTE FUNCTION vehicle.tg_vehicle_status_history();

CREATE TABLE vehicle.vehicle_mileage_logs (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  vehicle_id          uuid NOT NULL REFERENCES vehicle.vehicles (id),
  mileage_km          core.km NOT NULL,
  recorded_at         timestamptz NOT NULL,
  source              text NOT NULL CHECK (source IN ('user','fleet_driver','service_record','appointment','obdii_future')),
  recorded_by         uuid,
  lower_than_previous boolean NOT NULL DEFAULT false,              -- warning, not a block (52 §8)
  CONSTRAINT vehicle_mileage_logs_mvp_reserved CHECK (source <> 'obdii_future')
);
CREATE INDEX vehicle_mileage_logs_vehicle_idx ON vehicle.vehicle_mileage_logs (vehicle_id, recorded_at DESC);
COMMENT ON TABLE vehicle.vehicle_mileage_logs IS '52 VehicleMileageLog — latest reading mirrored on the vehicle';

CREATE FUNCTION vehicle.tg_mileage_before() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  prev integer;
BEGIN
  SELECT m.mileage_km INTO prev FROM vehicle.vehicle_mileage_logs m
   WHERE m.vehicle_id = NEW.vehicle_id AND m.recorded_at <= NEW.recorded_at AND m.deleted_at IS NULL
   ORDER BY m.recorded_at DESC LIMIT 1;
  NEW.lower_than_previous := prev IS NOT NULL AND NEW.mileage_km < prev;
  RETURN NEW;
END
$$;
CREATE TRIGGER vehicle_mileage_logs_before BEFORE INSERT ON vehicle.vehicle_mileage_logs
  FOR EACH ROW EXECUTE FUNCTION vehicle.tg_mileage_before();

CREATE FUNCTION vehicle.tg_mileage_after() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE vehicle.vehicles v SET mileage_km = NEW.mileage_km
   WHERE v.id = NEW.vehicle_id
     AND NOT EXISTS (SELECT 1 FROM vehicle.vehicle_mileage_logs m
                      WHERE m.vehicle_id = NEW.vehicle_id AND m.recorded_at > NEW.recorded_at AND m.deleted_at IS NULL);
  RETURN NULL;
END
$$;
CREATE TRIGGER vehicle_mileage_logs_after AFTER INSERT ON vehicle.vehicle_mileage_logs
  FOR EACH ROW EXECUTE FUNCTION vehicle.tg_mileage_after();

CREATE TABLE vehicle.vehicle_documents (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  vehicle_id                  uuid NOT NULL REFERENCES vehicle.vehicles (id),
  document_type               text NOT NULL CHECK (document_type IN ('insurance','registration','warranty','invoice','inspection_report','other')),
  title                       text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  media_asset_id              uuid NOT NULL,                     -- xref media (private, encrypted)
  visibility                  text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared_with_provider','fleet')),
  shared_with_organization_id uuid,
  issued_at                   date,
  expires_at                  date,
  uploaded_by                 uuid NOT NULL,
  status                      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  CHECK (visibility <> 'shared_with_provider' OR shared_with_organization_id IS NOT NULL),
  CHECK (expires_at IS NULL OR issued_at IS NULL OR expires_at >= issued_at)
);
CREATE INDEX vehicle_documents_vehicle_idx ON vehicle.vehicle_documents (vehicle_id) WHERE status = 'active';
CREATE INDEX vehicle_documents_shared_idx ON vehicle.vehicle_documents (shared_with_organization_id)
  WHERE visibility = 'shared_with_provider' AND status = 'active';
CREATE INDEX vehicle_documents_expiry_idx ON vehicle.vehicle_documents (expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;
COMMENT ON TABLE vehicle.vehicle_documents IS '52 VehicleDocument — shared with a provider only by consent';

CREATE TABLE vehicle.vehicle_issues (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  vehicle_id               uuid NOT NULL REFERENCES vehicle.vehicles (id),
  title                    text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description              text NOT NULL CHECK (char_length(description) BETWEEN 10 AND 3000),
  content_locale           core.locale NOT NULL,
  symptom_node_id          uuid,
  urgency_level            core.urgency_level NOT NULL,
  source                   text NOT NULL CHECK (source IN ('user','fleet_driver','ai_triage')),
  reported_by_user_id      uuid NOT NULL,
  triage_session_id        uuid,
  ai_triage_insight_id     uuid,
  fleet_approval_status    text CHECK (fleet_approval_status IN ('pending','approved','rejected')),
  converted_appointment_id uuid,
  status                   text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','scheduled','resolved','cancelled')),
  resolved_at              timestamptz,
  CHECK (source <> 'fleet_driver' OR fleet_approval_status IS NOT NULL),
  CHECK (status <> 'resolved' OR resolved_at IS NOT NULL)
);
CREATE INDEX vehicle_issues_vehicle_idx ON vehicle.vehicle_issues (vehicle_id, status);
COMMENT ON TABLE vehicle.vehicle_issues IS '52 VehicleIssue — AI output is referenced, never stored as issue text';

CREATE TABLE vehicle.vehicle_service_records (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  vehicle_id               uuid NOT NULL REFERENCES vehicle.vehicles (id),
  service_date             date NOT NULL,
  provider_organization_id uuid,
  service_system_node_id   uuid NOT NULL,
  service_task_node_id     uuid,
  description              text CHECK (char_length(description) <= 4000),
  parts_used               jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(parts_used) = 'array' AND jsonb_array_length(parts_used) <= 50),
  cost_amount              core.amount,
  currency                 core.currency,
  cost_breakdown           jsonb CHECK (cost_breakdown IS NULL OR jsonb_typeof(cost_breakdown) = 'object'),
  warranty_note            text CHECK (char_length(warranty_note) <= 500),
  mileage_km               core.km,
  source_type              text NOT NULL CHECK (source_type IN ('user_manual','provider_logged','appointment_completed',
                             'invoice_upload','imported_file_future','obdii_event_future')),
  verification_status      text NOT NULL DEFAULT 'self_reported' CHECK (verification_status IN ('self_reported',
                             'provider_confirmed','appointment_verified','invoice_verified','admin_verified')),
  appointment_id           uuid,
  job_log_id               uuid,
  resolves_issue_id        uuid REFERENCES vehicle.vehicle_issues (id),
  next_service_insight_id  uuid,
  created_by_type          text NOT NULL CHECK (created_by_type IN ('user','organization','system')),
  visibility               text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared_with_providers','fleet')),
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disputed','removed')),
  CHECK (cost_amount IS NULL OR currency IS NOT NULL),
  CHECK (source_type NOT IN ('provider_logged','appointment_completed') OR provider_organization_id IS NOT NULL),
  CHECK (source_type <> 'appointment_completed' OR appointment_id IS NOT NULL),
  CONSTRAINT vehicle_service_records_mvp_reserved CHECK (source_type NOT IN ('imported_file_future','obdii_event_future'))
);
CREATE INDEX vehicle_service_records_vehicle_idx ON vehicle.vehicle_service_records (vehicle_id, service_date DESC);
CREATE INDEX vehicle_service_records_provider_idx ON vehicle.vehicle_service_records (provider_organization_id, service_date DESC)
  WHERE provider_organization_id IS NOT NULL;
CREATE UNIQUE INDEX vehicle_service_records_appointment_uq ON vehicle.vehicle_service_records (appointment_id)
  WHERE appointment_id IS NOT NULL AND status <> 'removed';
COMMENT ON TABLE vehicle.vehicle_service_records IS '52 VehicleServiceRecord (MVP Module I)';

CREATE TABLE vehicle.service_record_evidence (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  service_record_id     uuid NOT NULL REFERENCES vehicle.vehicle_service_records (id),
  evidence_type         text NOT NULL CHECK (evidence_type IN ('invoice','photo','document','appointment_record','obd_code_future')),
  media_asset_id        uuid,
  reference_entity_type text CHECK (reference_entity_type IN ('appointment')),
  reference_entity_id   uuid,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  CHECK (evidence_type NOT IN ('invoice','photo','document') OR media_asset_id IS NOT NULL),
  CHECK (evidence_type <> 'appointment_record' OR (reference_entity_type IS NOT NULL AND reference_entity_id IS NOT NULL)),
  CONSTRAINT service_record_evidence_mvp_reserved CHECK (evidence_type <> 'obd_code_future')
);
CREATE INDEX service_record_evidence_record_idx ON vehicle.service_record_evidence (service_record_id);
COMMENT ON TABLE vehicle.service_record_evidence IS '52 ServiceRecordEvidence';

CREATE TABLE vehicle.maintenance_reminders (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  vehicle_id        uuid NOT NULL REFERENCES vehicle.vehicles (id),
  reminder_type     text NOT NULL CHECK (reminder_type IN ('oil','brakes','tires','battery','inspection','seasonal','document_expiry','custom')),
  title             text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  reason            text CHECK (char_length(reason) <= 500),
  source            text NOT NULL CHECK (source IN ('rule','ai_suggestion','manual','fleet_policy')),
  insight_id        uuid,
  due_by_mileage_km core.km,
  due_by_date       date,
  priority          text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  snoozed_until     date,
  status            text NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','due','overdue','completed','dismissed')),
  CHECK (due_by_mileage_km IS NOT NULL OR due_by_date IS NOT NULL),
  CHECK (source <> 'ai_suggestion' OR insight_id IS NOT NULL)
);
CREATE INDEX maintenance_reminders_vehicle_idx ON vehicle.maintenance_reminders (vehicle_id, status);
CREATE INDEX maintenance_reminders_due_idx ON vehicle.maintenance_reminders (due_by_date)
  WHERE status IN ('upcoming','due','overdue');
COMMENT ON TABLE vehicle.maintenance_reminders IS '52 MaintenanceReminder';

-- Minimal vehicle card for providers and vendors in an appointment or inquiry:
-- taxonomy, year and nickname only. Never VIN, plate, notes or owner.
CREATE FUNCTION vehicle.vehicle_cards(p_ids uuid[])
RETURNS TABLE (id uuid, brand_node_id uuid, model_node_id uuid, series_node_id uuid, year integer,
               engine_type_node_id uuid, fuel_type_node_id uuid, nickname text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT v.id, v.brand_node_id, v.model_node_id, v.series_node_id, v.year,
         v.engine_type_node_id, v.fuel_type_node_id, v.nickname
    FROM vehicle.vehicles v
   WHERE v.id = ANY (p_ids[1:500]) AND v.deleted_at IS NULL
$$;

\echo '== 10. inventory (WP7)'

-- =============================================================================
-- 10. inventory — vendor catalog, fitment, trade accounts, inquiries (WP7)
-- =============================================================================
CREATE SCHEMA inventory;
COMMENT ON SCHEMA inventory IS 'Module inventory (WP7): items, fitment, trade accounts, stock inquiries, CSV imports';

CREATE TABLE inventory.inventory_import_batches (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  vendor_organization_id      uuid NOT NULL,
  source_media_asset_id       uuid NOT NULL,
  column_mapping              jsonb NOT NULL CHECK (jsonb_typeof(column_mapping) IN ('array','object')),
  ai_normalization_requested  boolean NOT NULL DEFAULT true,
  status                      text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','validating','processing',
                                'completed','completed_with_errors','failed')),
  total_rows                  integer NOT NULL DEFAULT 0 CHECK (total_rows BETWEEN 0 AND 20000),
  created_count               integer NOT NULL DEFAULT 0 CHECK (created_count >= 0),
  updated_count               integer NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  error_count                 integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  error_report_media_asset_id uuid,
  started_at                  timestamptz,
  finished_at                 timestamptz
);
CREATE INDEX inventory_import_batches_vendor_idx ON inventory.inventory_import_batches (vendor_organization_id, created_at DESC);
COMMENT ON TABLE inventory.inventory_import_batches IS '52 InventoryImportBatch — runs in the import-jobs worker';

CREATE TABLE inventory.inventory_items (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  vendor_organization_id   uuid NOT NULL,
  sku                      text NOT NULL CHECK (char_length(sku) BETWEEN 1 AND 80),
  name_translations        core.translations NOT NULL CHECK (core.translations_ok(name_translations, 160)),
  normalized_name          text CHECK (char_length(normalized_name) <= 200),
  description_translations core.translations CHECK (core.translations_ok(description_translations, 2000)),
  brand                    text CHECK (char_length(brand) <= 100),
  oem_numbers              text[] NOT NULL DEFAULT '{}' CHECK (cardinality(oem_numbers) <= 50),
  aftermarket_numbers      text[] NOT NULL DEFAULT '{}' CHECK (cardinality(aftermarket_numbers) <= 50),
  part_origin              text NOT NULL CHECK (part_origin IN ('oem','aftermarket')),
  condition                text NOT NULL CHECK (condition IN ('new','used','refurbished','remanufactured')),
  part_category_node_id    uuid NOT NULL,
  position                 text[] NOT NULL DEFAULT '{}' CHECK (position <@ ARRAY['front','rear','left','right','upper','lower']),
  price_public             core.amount,
  price_trade              core.amount,                          -- never public, never indexed (40 SEC-OUT-1)
  price_on_request         boolean NOT NULL DEFAULT false,
  currency                 core.currency,
  stock_quantity           integer CHECK (stock_quantity >= 0),
  stock_status             core.stock_status NOT NULL,
  location_id              uuid,                                 -- xref organization location
  warranty_note            text CHECK (char_length(warranty_note) <= 500),
  notes                    text CHECK (char_length(notes) <= 2000),   -- internal
  visibility               text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','trade_only','hidden')),
  data_quality_score       core.score NOT NULL DEFAULT 0,
  duplicate_of_item_id     uuid REFERENCES inventory.inventory_items (id),
  import_batch_id          uuid REFERENCES inventory.inventory_import_batches (id),
  status                   core.inventory_status NOT NULL DEFAULT 'draft',
  CHECK (price_on_request OR price_public IS NOT NULL),
  CHECK ((price_public IS NULL AND price_trade IS NULL) OR currency IS NOT NULL),
  CHECK (duplicate_of_item_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX inventory_items_sku_uq ON inventory.inventory_items (vendor_organization_id, sku)
  WHERE status <> 'removed' AND deleted_at IS NULL;
CREATE INDEX inventory_items_vendor_idx ON inventory.inventory_items (vendor_organization_id, status, updated_at DESC);
CREATE INDEX inventory_items_category_idx ON inventory.inventory_items (part_category_node_id)
  WHERE status = 'active' AND visibility <> 'hidden';
CREATE INDEX inventory_items_name_gin ON inventory.inventory_items USING gin (name_translations jsonb_path_ops);
COMMENT ON TABLE inventory.inventory_items IS '52 InventoryItem — tenant-isolated; public projections exclude price_trade and notes';

CREATE TABLE inventory.inventory_fitment (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  inventory_item_id   uuid NOT NULL REFERENCES inventory.inventory_items (id),
  brand_node_id       uuid NOT NULL,
  model_node_id       uuid,
  series_node_id      uuid,
  year_start          integer CHECK (year_start BETWEEN 1950 AND 2100),
  year_end            integer CHECK (year_end BETWEEN 1950 AND 2100),
  engine_type_node_id uuid,
  fuel_type_node_id   uuid,
  notes               text CHECK (char_length(notes) <= 500),
  confidence          core.fitment_confidence NOT NULL,
  source              text NOT NULL CHECK (source IN ('manual','csv_import','ai_suggested','vendor_confirmed','manufacturer_data_future')),
  ai_insight_id       uuid,
  confirmed_by        uuid,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('pending_vendor_confirmation','active','rejected','inactive')),
  CHECK (series_node_id IS NULL OR model_node_id IS NOT NULL),
  CHECK (year_end IS NULL OR year_start IS NULL OR year_end >= year_start),
  CHECK (source <> 'ai_suggested' OR ai_insight_id IS NOT NULL),
  CHECK (confidence <> 'confirmed' OR confirmed_by IS NOT NULL),
  CHECK (source <> 'ai_suggested' OR status IN ('pending_vendor_confirmation','rejected','inactive') OR confirmed_by IS NOT NULL),
  CONSTRAINT inventory_fitment_mvp_reserved CHECK (source <> 'manufacturer_data_future')
);
CREATE INDEX inventory_fitment_item_idx ON inventory.inventory_fitment (inventory_item_id, status);
CREATE INDEX inventory_fitment_vehicle_idx ON inventory.inventory_fitment (brand_node_id, model_node_id, series_node_id)
  WHERE status = 'active';
COMMENT ON TABLE inventory.inventory_fitment IS '52 InventoryFitment — AI suggestions wait for vendor confirmation';

CREATE TABLE inventory.vendor_trade_accounts (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  vendor_organization_id         uuid NOT NULL,
  trade_customer_organization_id uuid NOT NULL,
  status                         text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','revoked')),
  approved_by                    uuid,
  approved_at                    timestamptz,
  notes                          text CHECK (char_length(notes) <= 500),
  CHECK (vendor_organization_id <> trade_customer_organization_id),
  CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  UNIQUE (vendor_organization_id, trade_customer_organization_id)
);
CREATE INDEX vendor_trade_accounts_customer_idx ON inventory.vendor_trade_accounts (trade_customer_organization_id, status);
COMMENT ON TABLE inventory.vendor_trade_accounts IS '52 VendorTradeAccount — unlocks trade-only items and trade prices';

CREATE TABLE inventory.stock_inquiries (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  inventory_item_id         uuid NOT NULL REFERENCES inventory.inventory_items (id),
  vendor_organization_id    uuid NOT NULL,
  requester_type            text NOT NULL CHECK (requester_type IN ('user','provider','fleet')),
  requester_user_id         uuid NOT NULL,
  requester_organization_id uuid,
  vehicle_id                uuid,
  vehicle_context_snapshot  jsonb CHECK (vehicle_context_snapshot IS NULL OR (jsonb_typeof(vehicle_context_snapshot) = 'object'
                              AND NOT (vehicle_context_snapshot ?| ARRAY['vin','vin_last4','license_plate','plate','owner_id']))),
  consent_reference_id      uuid,
  quantity                  integer CHECK (quantity BETWEEN 1 AND 10000),
  status                    text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','answered','reserved','unavailable','completed','cancelled')),
  reserved_until            timestamptz,
  first_response_at         timestamptz,
  closed_at                 timestamptz,
  closed_by_side            text CHECK (closed_by_side IN ('requester','vendor')),
  CHECK (requester_type = 'user' OR requester_organization_id IS NOT NULL),
  CHECK (vehicle_id IS NULL OR consent_reference_id IS NOT NULL),
  CHECK (status <> 'reserved' OR reserved_until IS NOT NULL),
  CHECK (status NOT IN ('completed','unavailable','cancelled') OR closed_at IS NOT NULL),
  CHECK (status <> 'completed' OR closed_by_side IS NOT NULL)
);
CREATE UNIQUE INDEX stock_inquiries_open_uq ON inventory.stock_inquiries (requester_user_id, inventory_item_id)
  WHERE status IN ('sent','answered','reserved');
CREATE INDEX stock_inquiries_vendor_idx ON inventory.stock_inquiries (vendor_organization_id, status, created_at DESC);
CREATE INDEX stock_inquiries_requester_idx ON inventory.stock_inquiries (requester_user_id, created_at DESC);
CREATE INDEX stock_inquiries_reserved_idx ON inventory.stock_inquiries (reserved_until) WHERE status = 'reserved';
COMMENT ON TABLE inventory.stock_inquiries IS '52 StockInquiry — no checkout; either side can complete';

-- Vendor is taken from the item; transitions follow 40 §13.1 per side.
CREATE FUNCTION inventory.tg_inquiry_rules() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  item_vendor uuid;
  side        text;
  ok          boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT i.vendor_organization_id INTO item_vendor FROM inventory.inventory_items i WHERE i.id = NEW.inventory_item_id;
    IF NEW.vendor_organization_id IS DISTINCT FROM item_vendor THEN
      RAISE EXCEPTION 'vendor_organization_id must match the item''s vendor' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'sent' THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: a new inquiry starts as sent' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  side := CASE WHEN core.is_system() OR core.is_staff() THEN 'any'
               WHEN core.my_org() = OLD.vendor_organization_id THEN 'vendor'
               ELSE 'requester' END;
  ok := CASE OLD.status
    WHEN 'sent' THEN
      (side IN ('vendor','any') AND NEW.status IN ('answered','reserved','unavailable'))
      OR (side IN ('requester','any') AND NEW.status = 'cancelled')
    WHEN 'answered' THEN
      (side IN ('vendor','any') AND NEW.status IN ('reserved','unavailable','completed'))
      OR (side IN ('requester','any') AND NEW.status IN ('cancelled','completed'))
    WHEN 'reserved' THEN
      (side IN ('vendor','any') AND NEW.status IN ('answered','unavailable','completed','cancelled'))
      OR (side IN ('requester','any') AND NEW.status IN ('cancelled','completed'))
    ELSE false END;
  IF NOT ok THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: inquiry % -> % (%)', OLD.status, NEW.status, side USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('completed','unavailable','cancelled') THEN
    NEW.closed_at := coalesce(NEW.closed_at, now());
    IF NEW.status = 'completed' AND NEW.closed_by_side IS NULL AND side <> 'any' THEN
      NEW.closed_by_side := side;
    END IF;
  END IF;
  IF OLD.status = 'sent' AND side = 'vendor' THEN
    NEW.first_response_at := coalesce(NEW.first_response_at, now());
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER stock_inquiries_rules BEFORE INSERT OR UPDATE ON inventory.stock_inquiries
  FOR EACH ROW EXECUTE FUNCTION inventory.tg_inquiry_rules();

CREATE TABLE inventory.inquiry_messages (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  inquiry_id     uuid NOT NULL REFERENCES inventory.stock_inquiries (id),
  author_user_id uuid NOT NULL,
  author_side    text NOT NULL CHECK (author_side IN ('requester','vendor')),
  body           text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  content_locale core.locale NOT NULL
);
CREATE INDEX inquiry_messages_inquiry_idx ON inventory.inquiry_messages (inquiry_id, created_at);
COMMENT ON TABLE inventory.inquiry_messages IS '52 InquiryMessage — thread-ready for live chat';

\echo '== 11. discovery (WP8)'

-- =============================================================================
-- 11. discovery — match sessions and results (WP8). Search projections live in
--     Elasticsearch, not here.
-- =============================================================================
CREATE SCHEMA discovery;
COMMENT ON SCHEMA discovery IS 'Module discovery (WP8): match sessions and stored match explanations';

CREATE TABLE discovery.match_sessions (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  requester_user_id         uuid,
  anonymous_key_hash        text CHECK (anonymous_key_hash ~ '^[0-9a-f]{64}$'),
  requester_organization_id uuid,
  source                    text NOT NULL CHECK (source IN ('search','ai_triage','fleet_workflow','profile_recommendation')),
  search_mode               text CHECK (search_mode IN ('all','providers','vendors','parts','showcases','qna')),
  entry_point               text CHECK (entry_point IN ('search_box','map','help_me','profile','favourites','directory_page')),
  target_type               text NOT NULL CHECK (target_type IN ('provider','vendor','inventory_item','place')),
  vehicle_id                uuid,
  issue_id                  uuid,
  triage_session_id         uuid,
  query_text                text CHECK (char_length(query_text) <= 500),
  query_normalized          text CHECK (char_length(query_normalized) <= 500),
  interpreted_intent        jsonb CHECK (interpreted_intent IS NULL OR jsonb_typeof(interpreted_intent) = 'object'),
  interpretation_source     text NOT NULL DEFAULT 'rules' CHECK (interpretation_source IN ('rules','rules_plus_ai')),
  safety_flag               boolean NOT NULL DEFAULT false,
  symptom_node_id           uuid,
  service_system_node_id    uuid,
  service_task_node_id      uuid,
  part_category_node_id     uuid,
  latitude                  core.lat,
  longitude                 core.lng,
  distance_origin           text CHECK (distance_origin IN ('user_position','chosen_city','map_center')),
  map_viewport              jsonb CHECK (map_viewport IS NULL OR jsonb_typeof(map_viewport) = 'object'),
  vehicle_filter_applied    boolean,
  urgency_level             core.urgency_level,
  filters                   jsonb CHECK (filters IS NULL OR jsonb_typeof(filters) = 'object'),
  locale                    core.locale NOT NULL,
  CHECK (requester_user_id IS NOT NULL OR anonymous_key_hash IS NOT NULL),
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);
CREATE INDEX match_sessions_user_idx ON discovery.match_sessions (requester_user_id, created_at DESC) WHERE requester_user_id IS NOT NULL;
CREATE INDEX match_sessions_created_idx ON discovery.match_sessions (created_at);   -- retention
COMMENT ON TABLE discovery.match_sessions IS '52 MatchSession — one search or recommendation request; works without AI';

-- query_normalized is always computed with the platform normalization (52 §2.5).
CREATE FUNCTION discovery.tg_session_normalize() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.query_normalized := left(core.normalize_search_text(NEW.query_text), 500);
  RETURN NEW;
END
$$;
CREATE TRIGGER match_sessions_normalize BEFORE INSERT OR UPDATE OF query_text ON discovery.match_sessions
  FOR EACH ROW EXECUTE FUNCTION discovery.tg_session_normalize();

CREATE TABLE discovery.match_results (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  match_session_id       uuid NOT NULL REFERENCES discovery.match_sessions (id),
  target_entity_type     text NOT NULL CHECK (target_entity_type IN ('organization','inventory_item')),
  target_entity_id       uuid NOT NULL,
  rank                   integer NOT NULL CHECK (rank >= 1),
  match_score            numeric(5,2) NOT NULL CHECK (match_score BETWEEN 0 AND 100),
  confidence             text NOT NULL CHECK (confidence IN ('low','moderate','high')),
  reasons                jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array' AND jsonb_array_length(reasons) BETWEEN 1 AND 8),
  explanation_text       text CHECK (char_length(explanation_text) <= 1000),
  explanation_source     text CHECK (explanation_source IN ('ai','template')),
  explanation_insight_id uuid,
  is_sponsored           boolean NOT NULL DEFAULT false,
  relevant_to_vehicle    boolean,
  matching_item_count    integer CHECK (matching_item_count >= 0),
  viewed_at              timestamptz,
  selected_at            timestamptz,
  appointment_id         uuid,
  CHECK (explanation_text IS NULL OR explanation_source IS NOT NULL),
  CHECK (explanation_source IS DISTINCT FROM 'ai' OR explanation_insight_id IS NOT NULL),
  CONSTRAINT match_results_no_featured_mvp CHECK (NOT is_sponsored),     -- featured.enabled is off (52 §10)
  UNIQUE (match_session_id, rank)
);
CREATE INDEX match_results_target_idx ON discovery.match_results (target_entity_type, target_entity_id, created_at DESC);
COMMENT ON TABLE discovery.match_results IS '52 MatchResult — every ranked result has structured reasons; never sponsored in the MVP';

\echo '== 12. trust (WP9)'

-- =============================================================================
-- 12. trust — reviews (two confirmation paths), invitations, disputes,
--     trust signals and badges (WP9)
-- =============================================================================
CREATE SCHEMA trust;
COMMENT ON SCHEMA trust IS 'Module trust (WP9): reviews, invitations, responses, disputes, trust signals, badges';

CREATE TABLE trust.review_requests (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  subject_organization_id     uuid NOT NULL,
  appointment_id              uuid,
  service_record_id           uuid,
  stock_inquiry_id            uuid,
  provider_job_log_id         uuid,
  invited_user_id             uuid,
  invited_contact_encrypted   bytea,                             -- 52 `invited_contact` (encrypted email)
  invited_contact_hash        core.hash,
  invited_by_user_id          uuid,
  channel                     text NOT NULL CHECK (channel IN ('in_app','email')),
  link_token_hash             core.hash UNIQUE,
  token_used_at               timestamptz,
  code_verified_at            timestamptz,
  business_confirmation_given boolean NOT NULL DEFAULT false,
  sent_at                     timestamptz,
  opened_at                   timestamptz,
  status                      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','opened','reminded','converted','expired','cancelled')),
  reminder_count              smallint NOT NULL DEFAULT 0 CHECK (reminder_count BETWEEN 0 AND 3),
  last_sent_at                timestamptz,
  expires_at                  timestamptz,
  converted_review_id         uuid,
  CHECK (num_nonnulls(appointment_id, service_record_id, stock_inquiry_id, provider_job_log_id) = 1),
  CHECK (invited_user_id IS NOT NULL OR invited_contact_encrypted IS NOT NULL),
  CHECK ((invited_contact_encrypted IS NULL) = (invited_contact_hash IS NULL)),
  CHECK (channel <> 'email' OR link_token_hash IS NOT NULL),
  CONSTRAINT review_requests_seven_days CHECK (sent_at IS NULL OR expires_at = sent_at + interval '7 days'),
  CHECK (status NOT IN ('sent','opened','reminded','converted') OR sent_at IS NOT NULL),
  CHECK (status <> 'converted' OR converted_review_id IS NOT NULL),
  CHECK (provider_job_log_id IS NULL OR business_confirmation_given)
);
CREATE UNIQUE INDEX review_requests_appointment_uq ON trust.review_requests (appointment_id)
  WHERE appointment_id IS NOT NULL AND status IN ('pending','sent','opened','reminded','converted');
CREATE UNIQUE INDEX review_requests_record_uq ON trust.review_requests (service_record_id)
  WHERE service_record_id IS NOT NULL AND status IN ('pending','sent','opened','reminded','converted');
CREATE UNIQUE INDEX review_requests_inquiry_uq ON trust.review_requests (stock_inquiry_id)
  WHERE stock_inquiry_id IS NOT NULL AND status IN ('pending','sent','opened','reminded','converted');
CREATE UNIQUE INDEX review_requests_job_uq ON trust.review_requests (provider_job_log_id)
  WHERE provider_job_log_id IS NOT NULL AND status IN ('pending','sent','opened','reminded','converted');
CREATE INDEX review_requests_org_idx ON trust.review_requests (subject_organization_id, status, created_at DESC);
CREATE INDEX review_requests_invitee_idx ON trust.review_requests (invited_user_id, status) WHERE invited_user_id IS NOT NULL;
CREATE INDEX review_requests_contact_idx ON trust.review_requests (invited_contact_hash) WHERE invited_contact_hash IS NOT NULL;
CREATE INDEX review_requests_expiry_idx ON trust.review_requests (expires_at) WHERE status IN ('sent','opened','reminded');
COMMENT ON TABLE trust.review_requests IS '52 ReviewRequest — single-use link, one visit, one recipient, expires sent_at + 7 days';

CREATE TABLE trust.reviews (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  author_user_id                uuid NOT NULL,
  subject_organization_id       uuid NOT NULL,
  subject_type                  text NOT NULL CHECK (subject_type IN ('provider','vendor')),
  subject_location_id           uuid,
  context_vehicle_id            uuid,
  context_appointment_id        uuid,
  context_service_record_id     uuid,
  context_stock_inquiry_id      uuid,
  service_system_node_id        uuid,
  service_task_node_id          uuid,
  service_date                  date,
  overall_rating                core.rating NOT NULL,
  would_return                  boolean,
  title                         text CHECK (char_length(title) BETWEEN 3 AND 120),
  body                          text NOT NULL CHECK (char_length(body) BETWEEN 10 AND 5000),
  content_locale                core.locale NOT NULL,
  confirmation_path             core.confirmation_path,
  verified_status               core.verified_status NOT NULL,
  business_confirmation_status  core.business_confirmation_status,
  business_confirmation_due_at  timestamptz,
  business_confirmed_at         timestamptz,
  business_confirmed_by_user_id uuid,
  business_confirmation_source  text CHECK (business_confirmation_source IN ('business_answer','business_invited','deadline_passed')),
  business_confirmation_note    text CHECK (char_length(business_confirmation_note) <= 500),   -- staff only
  reviewer_decision             core.reviewer_decision,
  reviewer_user_id              uuid,
  reviewer_decided_at           timestamptz,
  reviewer_reason_code          text CHECK (char_length(reviewer_reason_code) BETWEEN 1 AND 60),
  disputed_by_business          boolean NOT NULL DEFAULT false,
  trust_weight                  numeric(4,3) CHECK (trust_weight BETWEEN 0 AND 1),          -- internal (40 SEC-OUT-1)
  counts_toward_core_score      boolean NOT NULL DEFAULT false,
  helpful_count                 integer NOT NULL DEFAULT 0 CHECK (helpful_count >= 0),
  report_status                 text NOT NULL DEFAULT 'none' CHECK (report_status IN ('none','reported','under_review','resolved')),
  ai_sentiment                  text CHECK (ai_sentiment IN ('positive','neutral','negative','mixed')),   -- internal
  ai_complaint_flags            text[] NOT NULL DEFAULT '{}' CHECK (ai_complaint_flags <@
                                  ARRAY['safety_related','pricing','timeliness','quality','communication']),
  ai_analysis_insight_id        uuid,
  review_request_id             uuid REFERENCES trust.review_requests (id),
  status                        core.review_status NOT NULL DEFAULT 'pending_moderation',
  published_at                  timestamptz,
  CONSTRAINT reviews_path_matches_status CHECK (confirmation_path IS NULL
    OR (confirmation_path = 'visit_based') = (verified_status IN ('appointment_verified','inquiry_verified',
        'service_record_verified','invoice_verified','fleet_confirmed','admin_verified'))),
  CONSTRAINT reviews_path2_fields CHECK (confirmation_path IS DISTINCT FROM 'approval_based'
    OR (business_confirmation_status IS NOT NULL AND reviewer_decision IS NOT NULL AND business_confirmation_due_at IS NOT NULL)),
  CONSTRAINT reviews_path1_no_business_step CHECK (confirmation_path IS DISTINCT FROM 'visit_based'
    OR (business_confirmation_status IS NULL AND reviewer_decision IS NULL)),
  CHECK (verified_status <> 'appointment_verified' OR context_appointment_id IS NOT NULL),
  CHECK (verified_status <> 'service_record_verified' OR context_service_record_id IS NOT NULL),
  CHECK (verified_status <> 'inquiry_verified' OR context_stock_inquiry_id IS NOT NULL),
  CHECK (subject_type = 'provider' OR would_return IS NULL),
  CHECK (status <> 'pending_approval' OR confirmation_path = 'approval_based'),
  CONSTRAINT reviews_publish_rule CHECK (status <> 'published' OR (published_at IS NOT NULL
    AND confirmation_path IS NOT NULL AND verified_status NOT IN ('pending_approval','rejected'))),
  CONSTRAINT reviews_path2_publish_rule CHECK (NOT (status = 'published' AND confirmation_path = 'approval_based')
    OR (reviewer_decision = 'approved' AND verified_status = 'approved_without_visit'
        AND (business_confirmation_status IN ('confirmed','no_response')
             OR (business_confirmation_status = 'rejected' AND disputed_by_business)))),
  CHECK (NOT counts_toward_core_score OR status = 'published'),
  CHECK (reviewer_decision IS NULL OR reviewer_decision IN ('pending','approved') OR reviewer_reason_code IS NOT NULL)
);
CREATE UNIQUE INDEX reviews_appointment_uq ON trust.reviews (author_user_id, context_appointment_id)
  WHERE context_appointment_id IS NOT NULL AND status <> 'removed';
CREATE UNIQUE INDEX reviews_record_uq ON trust.reviews (author_user_id, context_service_record_id)
  WHERE context_service_record_id IS NOT NULL AND status <> 'removed';
CREATE UNIQUE INDEX reviews_inquiry_uq ON trust.reviews (author_user_id, context_stock_inquiry_id)
  WHERE context_stock_inquiry_id IS NOT NULL AND status <> 'removed';
CREATE INDEX reviews_subject_idx ON trust.reviews (subject_organization_id, status, published_at DESC);
CREATE INDEX reviews_author_idx ON trust.reviews (author_user_id, created_at DESC);
CREATE INDEX reviews_approval_queue_idx ON trust.reviews (business_confirmation_due_at) WHERE status = 'pending_approval';
COMMENT ON TABLE trust.reviews IS '52 Review — Path 1 visit-based or Path 2 approval-based; no unverified reviews are published';

ALTER TABLE trust.review_requests
  ADD CONSTRAINT review_requests_converted_review_fk FOREIGN KEY (converted_review_id) REFERENCES trust.reviews (id);

CREATE TABLE trust.review_sub_ratings (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  review_id uuid NOT NULL REFERENCES trust.reviews (id),
  dimension text NOT NULL CHECK (dimension IN ('work_quality','communication','timeliness','price_accuracy','cleanliness',
              'part_accuracy','availability_accuracy','price_fairness','service_speed')),
  rating    core.rating NOT NULL,
  UNIQUE (review_id, dimension)
);
COMMENT ON TABLE trust.review_sub_ratings IS '52 ReviewSubRating — provider and vendor dimension sets';

CREATE FUNCTION trust.tg_sub_rating_dimension() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  st text;
BEGIN
  SELECT r.subject_type INTO st FROM trust.reviews r WHERE r.id = NEW.review_id;
  IF NOT ((st = 'provider' AND NEW.dimension IN ('work_quality','communication','timeliness','price_accuracy','cleanliness'))
       OR (st = 'vendor'   AND NEW.dimension IN ('part_accuracy','availability_accuracy','price_fairness','service_speed','communication'))) THEN
    RAISE EXCEPTION 'dimension % does not apply to a % review', NEW.dimension, st USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER review_sub_ratings_dimension BEFORE INSERT OR UPDATE ON trust.review_sub_ratings
  FOR EACH ROW EXECUTE FUNCTION trust.tg_sub_rating_dimension();

CREATE TABLE trust.review_tags (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  review_id           uuid NOT NULL REFERENCES trust.reviews (id),
  taxonomy_node_id    uuid NOT NULL,
  source              text NOT NULL CHECK (source IN ('user_selected','ai_suggested')),
  confirmed_by_author boolean NOT NULL DEFAULT false,
  CHECK (source <> 'user_selected' OR confirmed_by_author),
  UNIQUE (review_id, taxonomy_node_id)
);
COMMENT ON TABLE trust.review_tags IS '52 ReviewTag — AI-suggested tags are public only when confirmed by the author';

CREATE TABLE trust.review_responses (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  review_id            uuid NOT NULL REFERENCES trust.reviews (id),
  organization_id      uuid NOT NULL,
  response_text        text NOT NULL CHECK (char_length(response_text) BETWEEN 1 AND 3000),
  content_locale       core.locale NOT NULL,
  ai_assisted          boolean NOT NULL DEFAULT false,
  ai_draft_insight_id  uuid,
  edited_after_ai      boolean NOT NULL DEFAULT false,
  sensitivity_flags    text[] NOT NULL DEFAULT '{}' CHECK (sensitivity_flags <@ ARRAY['legal','safety','privacy']),
  responded_by_user_id uuid NOT NULL,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','removed')),
  published_at         timestamptz,
  CHECK (NOT ai_assisted OR ai_draft_insight_id IS NOT NULL),
  CHECK (status <> 'published' OR published_at IS NOT NULL)
);
CREATE UNIQUE INDEX review_responses_published_uq ON trust.review_responses (review_id) WHERE status = 'published';
CREATE UNIQUE INDEX review_responses_draft_uq ON trust.review_responses (review_id) WHERE status = 'draft';
COMMENT ON TABLE trust.review_responses IS '52 ReviewResponse — at most one published; AI drafts never auto-published';

CREATE FUNCTION trust.tg_response_subject() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trust.reviews r WHERE r.id = NEW.review_id
                  AND r.subject_organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'only the review subject can respond' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER review_responses_subject BEFORE INSERT OR UPDATE OF review_id, organization_id ON trust.review_responses
  FOR EACH ROW EXECUTE FUNCTION trust.tg_response_subject();

CREATE TABLE trust.disputes (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  target_entity_type        text NOT NULL CHECK (target_entity_type IN ('review','service_record','badge','appointment','moderation_action')),
  target_entity_id          uuid NOT NULL,
  dispute_type              text NOT NULL CHECK (dispute_type IN ('fake_review','inaccurate_review','mediation_request',
                              'badge_challenge','service_record_dispute','moderation_appeal','review_approval_objection')),
  raised_by_user_id         uuid NOT NULL,
  raised_by_organization_id uuid,
  reason                    text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 2000),
  status                    text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_mediation','resolved_upheld','resolved_rejected','withdrawn')),
  assigned_to               uuid,
  moderator_notes           text CHECK (char_length(moderator_notes) <= 3000),   -- internal
  resolution                text CHECK (char_length(resolution) <= 2000),
  resolved_at               timestamptz,
  CHECK (status NOT IN ('resolved_upheld','resolved_rejected') OR (resolution IS NOT NULL AND resolved_at IS NOT NULL)),
  CHECK (dispute_type <> 'review_approval_objection' OR target_entity_type = 'review')
);
CREATE UNIQUE INDEX disputes_open_uq ON trust.disputes (raised_by_user_id, target_entity_type, target_entity_id)
  WHERE status IN ('open','in_mediation');
CREATE INDEX disputes_queue_idx ON trust.disputes (status, dispute_type, created_at);
CREATE INDEX disputes_target_idx ON trust.disputes (target_entity_type, target_entity_id);
COMMENT ON TABLE trust.disputes IS '52 Dispute — decided by a different staff member from the original decision';

CREATE TABLE trust.trust_signals (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  subject_type           text NOT NULL CHECK (subject_type IN ('organization','user')),
  subject_id             uuid NOT NULL,
  signal_group           text NOT NULL CHECK (signal_group IN ('user_generated','provider_generated','platform_verified','ai_derived','composite')),
  signal_type            text NOT NULL CHECK (signal_type IN (
    'avg_star_rating','review_count','review_tag_distribution','review_photo_count','repeat_customer_rate',
    'helpful_vote_count','qa_participation_count',
    'completed_job_count','before_after_media_count','avg_response_time','profile_completeness','service_category_count',
    'certification_count','appointment_reliability','review_response_quality','review_response_rate',
    'confirmed_appointment_count','verified_invoice_count','service_record_confirmation_count','review_authenticity_score',
    'moderation_outcome_score','dispute_outcome_score','provider_cancellation_rate','completion_rate','request_response_rate',
    'customer_no_show_rate','fleet_downtime_avg','first_time_fix_rate','cost_estimate_accuracy','fitment_coverage',
    'inquiry_fulfillment_rate',
    'skill_heatmap_score','sentiment_theme','review_quality_score','profile_confidence_score','likely_specialization',
    'risk_fraud_flag',
    'overall_trust_score','catalog_quality_score','admin_trust_penalty')),
  scope_taxonomy_node_id uuid,
  value                  numeric(16,4) NOT NULL,
  value_details          jsonb CHECK (value_details IS NULL OR jsonb_typeof(value_details) = 'object'),
  source_insight_id      uuid,
  rule_version           text NOT NULL CHECK (char_length(rule_version) BETWEEN 1 AND 20),
  is_public              boolean NOT NULL DEFAULT false,
  calculated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (signal_group <> 'ai_derived' OR source_insight_id IS NOT NULL),
  CHECK (NOT is_public OR signal_type NOT IN ('risk_fraud_flag','review_authenticity_score'))
);
CREATE INDEX trust_signals_subject_idx ON trust.trust_signals (subject_type, subject_id, signal_type, calculated_at DESC);
COMMENT ON TABLE trust.trust_signals IS '52 TrustSignal — computed from day one; versioned by scoring rule (54)';

CREATE TABLE trust.provider_badges (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  provider_organization_id uuid NOT NULL,
  badge_type               text NOT NULL CHECK (badge_type IN ('verified_business','make_specialist','system_expert','highly_rated',
                             'fast_responder','high_response_rate','repeat_customer_favorite','fast_appointment_turnaround',
                             'excellent_communication','fleet_friendly','ev_ready')),
  scope_taxonomy_node_ids  uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(scope_taxonomy_node_ids) <= 3),
  rule_key                 text NOT NULL CHECK (char_length(rule_key) BETWEEN 1 AND 60),
  rule_version             text NOT NULL CHECK (char_length(rule_version) BETWEEN 1 AND 20),
  evaluation_snapshot      jsonb NOT NULL CHECK (jsonb_typeof(evaluation_snapshot) = 'object'),
  requires_admin_approval  boolean NOT NULL DEFAULT false,
  approved_by              uuid,
  awarded_at               timestamptz NOT NULL DEFAULT now(),
  last_evaluated_at        timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz,
  visibility               text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('pending_approval','active','revoked','expired')),
  revoked_reason           text CHECK (char_length(revoked_reason) BETWEEN 1 AND 500),
  CHECK (badge_type NOT IN ('make_specialist','system_expert') OR cardinality(scope_taxonomy_node_ids) >= 1),
  CHECK (badge_type <> 'verified_business' OR requires_admin_approval),
  CHECK (NOT requires_admin_approval OR status <> 'active' OR approved_by IS NOT NULL),
  CHECK (status <> 'revoked' OR revoked_reason IS NOT NULL)
);
CREATE UNIQUE INDEX provider_badges_current_uq ON trust.provider_badges (provider_organization_id, badge_type, scope_taxonomy_node_ids)
  WHERE status IN ('pending_approval','active');
COMMENT ON TABLE trust.provider_badges IS '52 ProviderBadge — rule-based and auditable; no free-text badges';

\echo '== 13. appointment (WP10)'

-- =============================================================================
-- 13. appointment — requests, calendar, capacity, pre-visit report (WP10)
-- =============================================================================
CREATE SCHEMA appointment;
COMMENT ON SCHEMA appointment IS 'Module appointment (WP10): appointments, calendar, availability, pre-visit reports';

CREATE TABLE appointment.appointments (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  requester_type             core.requester_type NOT NULL,
  requester_user_id          uuid NOT NULL,
  requester_organization_id  uuid,
  provider_organization_id   uuid NOT NULL,
  provider_location_id       uuid,
  vehicle_id                 uuid NOT NULL,
  source                     text NOT NULL CHECK (source IN ('direct_search','ai_match','review_profile','fleet_workflow')),
  match_result_id            uuid,
  related_issue_id           uuid,
  triage_session_id          uuid,
  fleet_approval_id          uuid,
  appointment_type           core.appointment_type NOT NULL,
  service_mode               core.service_mode NOT NULL,
  service_system_node_id     uuid,
  service_task_node_id       uuid,
  symptom_node_id            uuid,
  triage_status              text NOT NULL GENERATED ALWAYS AS
                               (CASE WHEN triage_session_id IS NULL THEN 'not_provided' ELSE 'provided' END) STORED,
  safety_flag                boolean NOT NULL DEFAULT false,
  description                text NOT NULL CHECK (char_length(description) BETWEEN 10 AND 3000),
  content_locale             core.locale NOT NULL,
  urgency_level              core.urgency_level NOT NULL,
  customer_expectations      text CHECK (char_length(customer_expectations) <= 1000),
  preferred_contact_channel  core.notification_channel,
  proposed_start_at          timestamptz,
  proposed_end_at            timestamptz,
  confirmed_start_at         timestamptz,
  confirmed_end_at           timestamptz,
  estimated_duration_minutes integer CHECK (estimated_duration_minutes BETWEEN 5 AND 1440),
  estimated_completion_from  timestamptz,
  estimated_completion_to    timestamptz,
  parts_availability_note    text CHECK (char_length(parts_availability_note) <= 500),
  check_in_token_hash        core.hash UNIQUE,
  check_in_token_expires_at  timestamptz,
  checked_in_at              timestamptz,
  customer_delay_minutes     integer CHECK (customer_delay_minutes BETWEEN 5 AND 240),
  cost_estimate_amount       core.amount,
  cost_estimate_currency     core.currency,
  consent_to_share_history   boolean NOT NULL DEFAULT false,
  consent_reference_id       uuid,
  status                     core.appointment_status NOT NULL DEFAULT 'draft',
  cancelled_by               text CHECK (cancelled_by IN ('requester','provider','system')),
  cancellation_reason        text CHECK (char_length(cancellation_reason) BETWEEN 1 AND 500),
  completed_at               timestamptz,
  payment_reference_future   text,
  CHECK (requester_type <> 'fleet' OR requester_organization_id IS NOT NULL),
  CHECK (source NOT IN ('ai_match','fleet_workflow') OR service_system_node_id IS NOT NULL),
  CHECK (proposed_end_at IS NULL OR proposed_end_at > proposed_start_at),
  CHECK (confirmed_end_at IS NULL OR confirmed_end_at > confirmed_start_at),
  CHECK (estimated_completion_to IS NULL OR estimated_completion_from IS NULL OR estimated_completion_to >= estimated_completion_from),
  CHECK (status <> 'alternative_proposed' OR proposed_start_at IS NOT NULL),
  CHECK (status NOT IN ('confirmed','checked_in','in_progress','awaiting_parts','ready_for_pickup','completed')
         OR confirmed_start_at IS NOT NULL),
  CHECK (status <> 'checked_in' OR checked_in_at IS NOT NULL),
  CHECK (status <> 'cancelled' OR (cancelled_by IS NOT NULL AND cancellation_reason IS NOT NULL)),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CHECK (cost_estimate_amount IS NULL OR cost_estimate_currency IS NOT NULL),
  CHECK (NOT consent_to_share_history OR consent_reference_id IS NOT NULL),
  CONSTRAINT appointments_mvp_reserved CHECK (payment_reference_future IS NULL)
);
CREATE INDEX appointments_provider_idx ON appointment.appointments (provider_organization_id, status, confirmed_start_at);
CREATE INDEX appointments_requester_idx ON appointment.appointments (requester_user_id, created_at DESC);
CREATE INDEX appointments_fleet_idx ON appointment.appointments (requester_organization_id, created_at DESC)
  WHERE requester_organization_id IS NOT NULL;
CREATE INDEX appointments_vehicle_idx ON appointment.appointments (vehicle_id);
CREATE INDEX appointments_capacity_idx ON appointment.appointments (provider_location_id, confirmed_start_at)
  WHERE status IN ('confirmed','checked_in','in_progress','awaiting_parts','ready_for_pickup');
COMMENT ON TABLE appointment.appointments IS '52 Appointment — status machine enforced by trigger (52 §12)';

-- Allowed transitions per side (40 §16.1, 52 §12).
CREATE FUNCTION appointment.transition_allowed(p_from text, p_to text, p_side text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_side = 'requester' THEN (p_from, p_to) IN (
      ('draft','requested'), ('draft','cancelled'), ('requested','cancelled'), ('provider_reviewing','cancelled'),
      ('alternative_proposed','confirmed'), ('alternative_proposed','requested'), ('alternative_proposed','cancelled'),
      ('confirmed','cancelled'), ('confirmed','checked_in'))
    WHEN p_side = 'provider' THEN (p_from, p_to) IN (
      ('requested','provider_reviewing'), ('requested','confirmed'), ('requested','alternative_proposed'), ('requested','cancelled'),
      ('provider_reviewing','confirmed'), ('provider_reviewing','alternative_proposed'), ('provider_reviewing','cancelled'),
      ('alternative_proposed','cancelled'), ('confirmed','checked_in'), ('confirmed','no_show'), ('confirmed','cancelled'),
      ('checked_in','in_progress'), ('checked_in','cancelled'), ('in_progress','awaiting_parts'),
      ('in_progress','ready_for_pickup'), ('in_progress','completed'), ('awaiting_parts','in_progress'),
      ('awaiting_parts','cancelled'), ('ready_for_pickup','completed'))
    WHEN p_side = 'system' THEN
      appointment.transition_allowed(p_from, p_to, 'requester') OR appointment.transition_allowed(p_from, p_to, 'provider')
    ELSE false END
$$;

CREATE FUNCTION appointment.caller_side(p_requester_user uuid, p_requester_org uuid, p_provider_org uuid) RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
  SELECT coalesce(nullif(current_setting('app.actor_side', true), ''),
           CASE WHEN core.is_system() OR core.is_staff() THEN 'system'
                WHEN core.my_org() IS NOT NULL AND core.my_org() = p_provider_org THEN 'provider'
                WHEN core.my_org() IS NOT NULL AND core.my_org() = p_requester_org THEN 'requester'
                WHEN core.my_org() IS NULL AND core.me() = p_requester_user THEN 'requester'
                ELSE 'none' END)
$$;

CREATE FUNCTION appointment.tg_appointment_status() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  side text := appointment.caller_side(NEW.requester_user_id, NEW.requester_organization_id, NEW.provider_organization_id);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('draft','requested') THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: a new appointment is draft or requested' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT appointment.transition_allowed(OLD.status, NEW.status, side) THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: appointment % -> % (%)', OLD.status, NEW.status, side USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'cancelled' AND NEW.cancelled_by IS NULL THEN
      NEW.cancelled_by := CASE side WHEN 'provider' THEN 'provider' WHEN 'requester' THEN 'requester' ELSE 'system' END;
    END IF;
    IF NEW.status = 'checked_in' THEN
      NEW.checked_in_at := coalesce(NEW.checked_in_at, now());
    END IF;
    IF NEW.status = 'completed' THEN
      NEW.completed_at := coalesce(NEW.completed_at, now());
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER appointments_status BEFORE INSERT OR UPDATE OF status ON appointment.appointments
  FOR EACH ROW EXECUTE FUNCTION appointment.tg_appointment_status();

CREATE TABLE appointment.appointment_status_history (
  id              uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  appointment_id  uuid NOT NULL REFERENCES appointment.appointments (id),
  old_status      core.appointment_status,
  new_status      core.appointment_status NOT NULL,
  changed_by      uuid NOT NULL DEFAULT core.actor_id(),
  changed_by_side text NOT NULL CHECK (changed_by_side IN ('requester','provider','system')),
  note            text CHECK (char_length(note) <= 500),
  changed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointment_status_history_idx ON appointment.appointment_status_history (appointment_id, changed_at);
COMMENT ON TABLE appointment.appointment_status_history IS '52 AppointmentStatusHistory — append-only, written by trigger';

CREATE FUNCTION appointment.tg_appointment_history() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  side text := appointment.caller_side(NEW.requester_user_id, NEW.requester_organization_id, NEW.provider_organization_id);
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO appointment.appointment_status_history (appointment_id, old_status, new_status, changed_by_side, note)
    VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
            CASE WHEN side IN ('requester','provider') THEN side ELSE 'system' END,
            nullif(current_setting('app.change_reason', true), ''));
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER appointments_history AFTER INSERT OR UPDATE OF status ON appointment.appointments
  FOR EACH ROW EXECUTE FUNCTION appointment.tg_appointment_history();

CREATE TABLE appointment.appointment_time_windows (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  appointment_id uuid NOT NULL REFERENCES appointment.appointments (id),
  start_at       timestamptz NOT NULL,
  end_at         timestamptz NOT NULL,
  priority       smallint NOT NULL CHECK (priority BETWEEN 1 AND 5),
  CHECK (end_at > start_at)
);
CREATE INDEX appointment_time_windows_idx ON appointment.appointment_time_windows (appointment_id, priority);
COMMENT ON TABLE appointment.appointment_time_windows IS '52 AppointmentTimeWindow — at least one once requested';

-- A requested appointment needs at least one preferred window (checked at commit).
CREATE FUNCTION appointment.tg_requested_needs_window() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status = 'requested' AND NOT EXISTS (
       SELECT 1 FROM appointment.appointment_time_windows w
        WHERE w.appointment_id = NEW.id AND w.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'a requested appointment needs at least one time window' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER appointments_requested_window AFTER INSERT OR UPDATE OF status ON appointment.appointments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION appointment.tg_requested_needs_window();

CREATE TABLE appointment.appointment_participants (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  appointment_id   uuid NOT NULL REFERENCES appointment.appointments (id),
  user_id          uuid NOT NULL,
  organization_id  uuid,
  participant_role text NOT NULL CHECK (participant_role IN ('requester','fleet_manager','fleet_maintenance_coordinator',
                     'driver','service_advisor','technician')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed'))
);
CREATE UNIQUE INDEX appointment_participants_uq ON appointment.appointment_participants (appointment_id, user_id, participant_role)
  WHERE status = 'active';
CREATE INDEX appointment_participants_user_idx ON appointment.appointment_participants (user_id) WHERE status = 'active';
COMMENT ON TABLE appointment.appointment_participants IS '52 AppointmentParticipant';

CREATE TABLE appointment.appointment_notes (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  appointment_id uuid NOT NULL REFERENCES appointment.appointments (id),
  author_user_id uuid NOT NULL,
  author_side    text NOT NULL CHECK (author_side IN ('requester','provider')),
  note_type      text NOT NULL CHECK (note_type IN ('internal','customer_visible')),
  body           text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 3000),
  content_locale core.locale NOT NULL,
  CHECK (author_side <> 'requester' OR note_type = 'customer_visible')
);
CREATE INDEX appointment_notes_idx ON appointment.appointment_notes (appointment_id, created_at);
COMMENT ON TABLE appointment.appointment_notes IS '52 AppointmentNote — internal notes never reach the requester';

CREATE TABLE appointment.pre_visit_reports (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  appointment_id            uuid NOT NULL UNIQUE REFERENCES appointment.appointments (id),
  vehicle_summary           text NOT NULL CHECK (char_length(vehicle_summary) BETWEEN 1 AND 2000),
  mileage_km                core.km,
  reported_symptom_node_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(reported_symptom_node_ids) <= 20),
  triage_status             text NOT NULL CHECK (triage_status IN ('provided','not_provided')),
  issue_summary             text NOT NULL CHECK (char_length(issue_summary) BETWEEN 1 AND 2000),
  ai_triage_insight_id      uuid,
  ai_summary                text CHECK (char_length(ai_summary) <= 3000),
  likely_service_node_ids   uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(likely_service_node_ids) <= 20),
  relevant_history_summary  text CHECK (char_length(relevant_history_summary) <= 3000),
  previous_related_repairs  jsonb CHECK (previous_related_repairs IS NULL OR (jsonb_typeof(previous_related_repairs) = 'array'
                              AND jsonb_array_length(previous_related_repairs) <= 20)),
  known_warnings            text[] NOT NULL DEFAULT '{}' CHECK (cardinality(known_warnings) <= 20),
  suggested_focus_areas     text[] NOT NULL DEFAULT '{}' CHECK (cardinality(suggested_focus_areas) <= 20),
  media_attachment_ids      uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(media_attachment_ids) <= 20),
  customer_expectations     text CHECK (char_length(customer_expectations) <= 1000),
  urgency_level             core.urgency_level NOT NULL,
  fleet_approval_status     text CHECK (fleet_approval_status IN ('pending','approved','rejected')),
  preferred_contact_channel core.notification_channel,
  obd_summary_future        jsonb,
  consent_reference_id      uuid,
  generated_at              timestamptz,
  status                    text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','generated','shared','archived')),
  CHECK (triage_status <> 'not_provided' OR ai_triage_insight_id IS NULL),
  CONSTRAINT pre_visit_reports_history_consent CHECK ((relevant_history_summary IS NULL AND previous_related_repairs IS NULL)
                                                      OR consent_reference_id IS NOT NULL),
  CONSTRAINT pre_visit_reports_mvp_reserved CHECK (obd_summary_future IS NULL)
);
COMMENT ON TABLE appointment.pre_visit_reports IS '52 PreVisitReport (MVP Module H) — history only with service_history_sharing consent';

CREATE TABLE appointment.provider_availability_rules (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  provider_organization_id    uuid NOT NULL,
  location_id                 uuid NOT NULL,
  day_of_week                 smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),   -- 0 = Sunday, location timezone
  start_time                  time NOT NULL,
  end_time                    time NOT NULL,
  slot_duration_minutes       integer NOT NULL CHECK (slot_duration_minutes BETWEEN 15 AND 480),
  appointment_types           text[] NOT NULL DEFAULT '{}' CHECK (appointment_types <@
                                ARRAY['diagnosis','repair','inspection','bodywork_estimate','parts_installation']),
  max_concurrent_appointments integer NOT NULL CHECK (max_concurrent_appointments BETWEEN 1 AND 100),
  buffer_minutes              integer NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 240),
  effective_from              date,
  effective_to                date,
  status                      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  CHECK (end_time > start_time),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);
CREATE INDEX provider_availability_rules_idx ON appointment.provider_availability_rules (provider_organization_id, location_id, day_of_week)
  WHERE status = 'active';
COMMENT ON TABLE appointment.provider_availability_rules IS '52 ProviderAvailabilityRule (MVP Module G)';

CREATE TABLE appointment.provider_time_off (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  provider_organization_id uuid NOT NULL,
  location_id              uuid,                                  -- null = all locations
  start_at                 timestamptz NOT NULL,
  end_at                   timestamptz NOT NULL,
  reason                   text CHECK (char_length(reason) <= 200),
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  CHECK (end_at > start_at)
);
CREATE INDEX provider_time_off_idx ON appointment.provider_time_off (provider_organization_id, start_at) WHERE status = 'active';
COMMENT ON TABLE appointment.provider_time_off IS '52 ProviderTimeOff';

-- Capacity check used when confirming (52 §12). Serializes confirmations per
-- location with a transaction-scoped advisory lock, then checks the matching
-- availability rule, time off and overlapping appointments (with buffers).
-- p_tz is the location timezone (owned by the organization module).
CREATE FUNCTION appointment.capacity_available(p_provider uuid, p_location uuid, p_tz text,
                                               p_start timestamptz, p_end timestamptz,
                                               p_type text DEFAULT NULL, p_exclude uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog
AS $$
DECLARE
  local_start timestamp := p_start AT TIME ZONE p_tz;
  local_end   timestamp := p_end AT TIME ZONE p_tz;
  r           record;
  used        integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('appointment.capacity:' || p_location::text, 0));
  IF local_start::date <> local_end::date THEN
    RETURN false;
  END IF;
  SELECT * INTO r FROM appointment.provider_availability_rules a
   WHERE a.provider_organization_id = p_provider AND a.location_id = p_location AND a.status = 'active'
     AND a.deleted_at IS NULL
     AND a.day_of_week = extract(dow FROM local_start)::int
     AND a.start_time <= local_start::time AND a.end_time >= local_end::time
     AND (a.effective_from IS NULL OR a.effective_from <= local_start::date)
     AND (a.effective_to IS NULL OR a.effective_to >= local_start::date)
     AND (p_type IS NULL OR cardinality(a.appointment_types) = 0 OR p_type = ANY (a.appointment_types))
   ORDER BY a.max_concurrent_appointments DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM appointment.provider_time_off t
              WHERE t.provider_organization_id = p_provider AND t.status = 'active' AND t.deleted_at IS NULL
                AND (t.location_id IS NULL OR t.location_id = p_location)
                AND tstzrange(t.start_at, t.end_at) && tstzrange(p_start, p_end)) THEN
    RETURN false;
  END IF;
  SELECT count(*) INTO used FROM appointment.appointments ap
   WHERE ap.provider_organization_id = p_provider AND ap.provider_location_id = p_location
     AND ap.status IN ('confirmed','checked_in','in_progress','awaiting_parts','ready_for_pickup')
     AND ap.deleted_at IS NULL
     AND (p_exclude IS NULL OR ap.id <> p_exclude)
     AND tstzrange(ap.confirmed_start_at - make_interval(mins => r.buffer_minutes),
                   coalesce(ap.confirmed_end_at, ap.confirmed_start_at + make_interval(mins => r.slot_duration_minutes))
                     + make_interval(mins => r.buffer_minutes))
         && tstzrange(p_start, p_end);
  RETURN used < r.max_concurrent_appointments;
END
$$;
COMMENT ON FUNCTION appointment.capacity_available IS 'Call inside the confirming transaction; returns false → 409 CAPACITY_UNAVAILABLE';

-- Check-in from a `ci` link without sign-in (40 appointments.check_in_link):
-- one atomic conditional update, inside the window of ±2 h around the start.
CREATE FUNCTION appointment.check_in_by_token(p_token_hash bytea)
RETURNS TABLE (appointment_id uuid, status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  a record;
BEGIN
  SELECT ap.id, ap.status, ap.confirmed_start_at, ap.check_in_token_expires_at INTO a
    FROM appointment.appointments ap
   WHERE ap.check_in_token_hash = p_token_hash AND ap.deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND OR a.check_in_token_expires_at < now() THEN
    RAISE EXCEPTION 'LINK_EXPIRED' USING ERRCODE = 'P0410';
  END IF;
  IF a.status = 'checked_in' THEN
    RETURN QUERY SELECT a.id, a.status::text;
    RETURN;
  END IF;
  IF a.status <> 'confirmed' OR now() NOT BETWEEN a.confirmed_start_at - interval '2 hours'
                                             AND a.confirmed_start_at + interval '2 hours' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: outside_window' USING ERRCODE = 'P0409';
  END IF;
  PERFORM set_config('app.actor_side', 'requester', true);
  UPDATE appointment.appointments ap SET status = 'checked_in', checked_in_at = now()
   WHERE ap.id = a.id AND ap.status = 'confirmed';
  PERFORM set_config('app.actor_side', '', true);
  PERFORM core.publish_event('appointment.status_changed', 'appointment', a.id,
                             jsonb_build_object('old_status', 'confirmed', 'new_status', 'checked_in', 'via', 'link'));
  RETURN QUERY SELECT a.id, 'checked_in'::text;
END
$$;

\echo '== 14. fleet (WP11)'

-- =============================================================================
-- 14. fleet — fleet profile, drivers, partners, approvals, imports, exports
-- =============================================================================
CREATE SCHEMA fleet;
COMMENT ON SCHEMA fleet IS 'Module fleet (WP11): profiles, assignments, preferred partners, approvals, imports, exports';

CREATE TABLE fleet.fleet_profiles (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  organization_id                uuid NOT NULL UNIQUE,
  fleet_size                     integer NOT NULL CHECK (fleet_size BETWEEN 1 AND 100000),
  industry                       text CHECK (char_length(industry) <= 100),
  approval_workflow_enabled      boolean NOT NULL DEFAULT true,
  cost_approval_threshold_amount core.amount,
  preferred_provider_mode        text NOT NULL DEFAULT 'preferred' CHECK (preferred_provider_mode IN ('strict','preferred','suggested')),
  reporting_currency             core.currency NOT NULL,
  status                         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived'))
);
COMMENT ON TABLE fleet.fleet_profiles IS '52 FleetProfile';

CREATE TABLE fleet.fleet_vehicle_assignments (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  fleet_organization_id uuid NOT NULL,
  vehicle_id            uuid NOT NULL,
  driver_user_id        uuid NOT NULL,
  assigned_by           uuid NOT NULL,
  assigned_at           timestamptz NOT NULL DEFAULT now(),
  ended_at              timestamptz,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  CHECK (status <> 'ended' OR ended_at IS NOT NULL),
  CHECK (ended_at IS NULL OR ended_at >= assigned_at)
);
CREATE UNIQUE INDEX fleet_vehicle_assignments_active_uq ON fleet.fleet_vehicle_assignments (vehicle_id) WHERE status = 'active';
CREATE INDEX fleet_vehicle_assignments_driver_idx ON fleet.fleet_vehicle_assignments (driver_user_id) WHERE status = 'active';
CREATE INDEX fleet_vehicle_assignments_fleet_idx ON fleet.fleet_vehicle_assignments (fleet_organization_id, status);
COMMENT ON TABLE fleet.fleet_vehicle_assignments IS '52 FleetVehicleAssignment — one active assignment per vehicle';

CREATE TABLE fleet.fleet_preferred_partners (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  fleet_organization_id   uuid NOT NULL,
  partner_organization_id uuid NOT NULL,
  relationship_type       text NOT NULL CHECK (relationship_type IN ('preferred_provider','approved_vendor')),
  service_system_node_id  uuid,
  part_category_node_id   uuid,
  priority                smallint NOT NULL CHECK (priority BETWEEN 1 AND 10),
  notes                   text CHECK (char_length(notes) <= 500),
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  CHECK (relationship_type = 'preferred_provider' OR service_system_node_id IS NULL),
  CHECK (relationship_type = 'approved_vendor' OR part_category_node_id IS NULL),
  CHECK (fleet_organization_id <> partner_organization_id)
);
CREATE UNIQUE INDEX fleet_preferred_partners_uq ON fleet.fleet_preferred_partners
  (fleet_organization_id, partner_organization_id, relationship_type, service_system_node_id, part_category_node_id)
  NULLS NOT DISTINCT WHERE status = 'active';
COMMENT ON TABLE fleet.fleet_preferred_partners IS '52 FleetPreferredPartner — preferred shops and approved vendors';

CREATE TABLE fleet.fleet_approvals (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  fleet_organization_id             uuid NOT NULL,
  vehicle_id                        uuid NOT NULL,
  approval_type                     text NOT NULL CHECK (approval_type IN ('repair_request','provider_selection','cost_estimate')),
  related_issue_id                  uuid,
  related_appointment_id            uuid,
  ai_triage_insight_id              uuid,
  selected_provider_organization_id uuid,
  cost_estimate_amount              core.amount,
  cost_estimate_currency            core.currency,
  requested_by_user_id              uuid NOT NULL,
  approver_user_id                  uuid,
  status                            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','needs_more_info')),
  decision_reason                   text CHECK (char_length(decision_reason) <= 500),
  decided_at                        timestamptz,
  CHECK (approval_type <> 'provider_selection' OR selected_provider_organization_id IS NOT NULL),
  CHECK (approval_type <> 'cost_estimate' OR (cost_estimate_amount IS NOT NULL AND cost_estimate_currency IS NOT NULL)),
  CHECK (status = 'pending' OR (approver_user_id IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT fleet_approvals_no_self_approval CHECK (approver_user_id IS DISTINCT FROM requested_by_user_id)
);
CREATE INDEX fleet_approvals_fleet_idx ON fleet.fleet_approvals (fleet_organization_id, status, created_at DESC);
COMMENT ON TABLE fleet.fleet_approvals IS '52 FleetApproval (MVP Module K) — requester cannot approve their own request';

CREATE TABLE fleet.fleet_import_batches (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  fleet_organization_id       uuid NOT NULL,
  source_media_asset_id       uuid NOT NULL,
  column_mapping              jsonb NOT NULL CHECK (jsonb_typeof(column_mapping) IN ('array','object')),
  status                      text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','validating','processing',
                                'completed','completed_with_errors','failed')),
  total_rows                  integer NOT NULL DEFAULT 0 CHECK (total_rows BETWEEN 0 AND 20000),
  created_count               integer NOT NULL DEFAULT 0 CHECK (created_count >= 0),
  error_count                 integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  error_report_media_asset_id uuid,
  finished_at                 timestamptz
);
CREATE INDEX fleet_import_batches_idx ON fleet.fleet_import_batches (fleet_organization_id, created_at DESC);
COMMENT ON TABLE fleet.fleet_import_batches IS '52 FleetImportBatch (Should-have)';

CREATE TABLE fleet.fleet_exports (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  fleet_organization_id uuid NOT NULL,
  export_type           text NOT NULL CHECK (export_type IN ('cost_report','service_history','vehicle_list','repair_frequency','provider_usage')),
  filters               jsonb CHECK (filters IS NULL OR jsonb_typeof(filters) = 'object'),
  format                text NOT NULL DEFAULT 'csv' CHECK (format IN ('csv')),
  requested_by          uuid NOT NULL,
  status                text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed')),
  file_media_asset_id   uuid,
  expires_at            timestamptz,
  CHECK (status <> 'completed' OR file_media_asset_id IS NOT NULL)
);
CREATE INDEX fleet_exports_idx ON fleet.fleet_exports (fleet_organization_id, created_at DESC);
COMMENT ON TABLE fleet.fleet_exports IS '52 FleetExport (Should-have)';

\echo '== 15. community (WP12)'

-- =============================================================================
-- 15. community — follows, favourites, posts, comments, reactions, Q&A (WP12)
-- =============================================================================
CREATE SCHEMA community;
COMMENT ON SCHEMA community IS 'Module community (WP12): follows, favorites, posts, comments, reactions, Q&A';

CREATE TABLE community.follows (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  user_id                 uuid NOT NULL,
  organization_id         uuid NOT NULL,
  notification_preference text NOT NULL DEFAULT 'all' CHECK (notification_preference IN ('all','important_only','none')),
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unfollowed'))
);
CREATE UNIQUE INDEX follows_active_uq ON community.follows (user_id, organization_id) WHERE status = 'active';
CREATE INDEX follows_org_idx ON community.follows (organization_id) WHERE status = 'active';
COMMENT ON TABLE community.follows IS '52 Follow';

CREATE TABLE community.favorites (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  user_id         uuid NOT NULL,
  organization_id uuid NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed'))
);
CREATE UNIQUE INDEX favorites_active_uq ON community.favorites (user_id, organization_id) WHERE status = 'active';
COMMENT ON TABLE community.favorites IS '52 Favorite — input to matching preferences';

CREATE TABLE community.posts (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  author_organization_id uuid NOT NULL,
  author_user_id         uuid NOT NULL,
  post_type              text NOT NULL CHECK (post_type IN ('showcase','availability','seasonal_advice','special_offer',
                           'educational_tip','job_completion','community_event')),
  title                  text CHECK (char_length(title) BETWEEN 3 AND 140),
  body                   text NOT NULL CHECK (char_length(body) BETWEEN 10 AND 3000),
  content_locale         core.locale NOT NULL,
  portfolio_item_id      uuid,
  taxonomy_node_ids      uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(taxonomy_node_ids) <= 20),
  offer_valid_until      date,
  event_starts_at        timestamptz,
  comments_enabled       boolean NOT NULL DEFAULT false,
  ai_caption_insight_id  uuid,
  visibility             core.content_visibility NOT NULL DEFAULT 'public',
  moderation_status      core.moderation_status NOT NULL DEFAULT 'pending',
  helpful_count          integer NOT NULL DEFAULT 0 CHECK (helpful_count >= 0),
  like_count             integer NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','hidden','removed')),
  published_at           timestamptz,
  CHECK (post_type NOT IN ('showcase','job_completion') OR portfolio_item_id IS NOT NULL),
  CHECK (post_type <> 'special_offer' OR offer_valid_until IS NOT NULL),
  CHECK (post_type <> 'community_event' OR event_starts_at IS NOT NULL),
  CHECK (status <> 'published' OR (published_at IS NOT NULL AND moderation_status = 'approved'))
);
CREATE INDEX posts_org_idx ON community.posts (author_organization_id, status, published_at DESC);
COMMENT ON TABLE community.posts IS '52 Post (Should-have)';

CREATE TABLE community.questions (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  author_user_id     uuid NOT NULL,
  vehicle_id         uuid,                                       -- private link, never public
  brand_node_id      uuid,
  model_node_id      uuid,
  series_node_id     uuid,
  symptom_node_id    uuid,
  category_node_id   uuid,
  title              text NOT NULL CHECK (char_length(title) BETWEEN 5 AND 160),
  body               text NOT NULL CHECK (char_length(body) BETWEEN 10 AND 5000),
  content_locale     core.locale NOT NULL,
  accepted_answer_id uuid,
  moderation_status  core.moderation_status NOT NULL DEFAULT 'pending',
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed','hidden')),
  CHECK (vehicle_id IS NOT NULL OR symptom_node_id IS NOT NULL OR category_node_id IS NOT NULL)
);
CREATE INDEX questions_author_idx ON community.questions (author_user_id);
CREATE INDEX questions_public_idx ON community.questions (created_at DESC) WHERE moderation_status = 'approved' AND status <> 'hidden';
COMMENT ON TABLE community.questions IS '52 Question (Should-have)';

CREATE TABLE community.answers (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  question_id            uuid NOT NULL REFERENCES community.questions (id),
  author_user_id         uuid NOT NULL,
  author_organization_id uuid,
  body                   text NOT NULL CHECK (char_length(body) BETWEEN 10 AND 5000),
  content_locale         core.locale NOT NULL,
  helpful_count          integer NOT NULL DEFAULT 0 CHECK (helpful_count >= 0),
  moderation_status      core.moderation_status NOT NULL DEFAULT 'pending',
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden','removed')),
  UNIQUE (id, question_id)
);
CREATE INDEX answers_question_idx ON community.answers (question_id, created_at);
COMMENT ON TABLE community.answers IS '52 Answer (Should-have)';

-- The accepted answer must belong to the same question.
ALTER TABLE community.questions
  ADD CONSTRAINT questions_accepted_answer_fk FOREIGN KEY (accepted_answer_id, id)
  REFERENCES community.answers (id, question_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE community.comments (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  target_type       text NOT NULL CHECK (target_type IN ('post','portfolio_item','question','answer')),
  target_id         uuid NOT NULL,
  author_user_id    uuid NOT NULL,
  body              text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  content_locale    core.locale NOT NULL,
  moderation_status core.moderation_status NOT NULL DEFAULT 'pending',
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden','removed'))
);
CREATE INDEX comments_target_idx ON community.comments (target_type, target_id, created_at);
COMMENT ON TABLE community.comments IS '52 Comment (Should-have)';

CREATE TABLE community.reactions (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  target_type   text NOT NULL CHECK (target_type IN ('review','answer','post','comment','portfolio_item')),
  target_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  reaction_type text NOT NULL CHECK (reaction_type IN ('helpful','like')),
  CHECK ((reaction_type = 'helpful' AND target_type IN ('review','answer','post'))
      OR (reaction_type = 'like' AND target_type IN ('post','comment','portfolio_item'))),
  UNIQUE (user_id, target_type, target_id, reaction_type)
);
CREATE INDEX reactions_target_idx ON community.reactions (target_type, target_id, reaction_type);
COMMENT ON TABLE community.reactions IS '52 Reaction — one per user, target and type; removal deletes the row';

\echo '== 16. media (WP13)'

-- =============================================================================
-- 16. media — assets and attachments (WP13)
-- =============================================================================
CREATE SCHEMA media;
COMMENT ON SCHEMA media IS 'Module media (WP13): assets (scan, redaction, consent) and attachments';

CREATE TABLE media.media_assets (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  owner_type           text NOT NULL CHECK (owner_type IN ('user','organization','system')),
  owner_id             uuid NOT NULL,
  purpose              text NOT NULL CHECK (purpose IN ('avatar','org_logo','org_cover','vehicle_photo','vehicle_document',
                         'issue_photo','service_evidence','review_photo','review_evidence','portfolio','post','qna',
                         'inventory_image','appointment_photo','job_log_photo','verification_document',
                         'certification_document','inventory_import_csv','fleet_import_csv','system_export')),
  media_type           text NOT NULL CHECK (media_type IN ('image','video','document')),
  mime_type            text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp','image/heic','video/mp4',
                         'application/pdf','text/csv')),
  file_size_bytes      bigint NOT NULL CHECK (file_size_bytes BETWEEN 1 AND 104857600),
  checksum_sha256      text CHECK (checksum_sha256 ~ '^[A-Za-z0-9+/]{43}=$'),
  storage_reference    text CHECK (char_length(storage_reference) <= 512),     -- never returned (40 SEC-OUT-1)
  thumbnail_reference  text CHECK (char_length(thumbnail_reference) <= 512),
  width                integer CHECK (width BETWEEN 1 AND 20000),
  height               integer CHECK (height BETWEEN 1 AND 20000),
  duration_seconds     integer CHECK (duration_seconds BETWEEN 1 AND 60),
  privacy_level        text NOT NULL CHECK (privacy_level IN ('public','shared','private','internal')),
  encrypted_at_rest    boolean NOT NULL DEFAULT false,
  scan_status          text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','infected','failed')),
  exif_stripped        boolean NOT NULL DEFAULT false,
  redaction_status     text NOT NULL DEFAULT 'not_needed' CHECK (redaction_status IN ('not_needed','suggested','pending','completed','failed')),
  redaction_insight_id uuid,
  consent_status       core.media_consent_status NOT NULL DEFAULT 'not_required',
  consent_reference_id uuid,
  moderation_status    core.moderation_status NOT NULL DEFAULT 'pending',
  uploaded_by          uuid NOT NULL,
  upload_expires_at    timestamptz,
  status               text NOT NULL DEFAULT 'pending_upload' CHECK (status IN ('pending_upload','active','quarantined','removed')),
  publicly_servable    boolean GENERATED ALWAYS AS (
                         privacy_level = 'public' AND status = 'active' AND scan_status = 'clean' AND exif_stripped
                         AND moderation_status = 'approved' AND redaction_status IN ('completed','not_needed')
                         AND consent_status IN ('granted','not_required')) STORED,
  CHECK (media_type <> 'document' OR encrypted_at_rest),
  CHECK (consent_status <> 'granted' OR consent_reference_id IS NOT NULL),
  CHECK (scan_status <> 'infected' OR status IN ('quarantined','removed')),
  CHECK (status <> 'pending_upload' OR upload_expires_at IS NOT NULL),
  CHECK ((media_type = 'image') = (mime_type LIKE 'image/%')),
  CHECK ((media_type = 'video') = (mime_type = 'video/mp4'))
);
CREATE INDEX media_assets_owner_idx ON media.media_assets (owner_type, owner_id, created_at DESC);
CREATE INDEX media_assets_pending_idx ON media.media_assets (upload_expires_at) WHERE status = 'pending_upload';
CREATE INDEX media_assets_scan_idx ON media.media_assets (created_at) WHERE scan_status = 'pending' AND status = 'active';
COMMENT ON TABLE media.media_assets IS '52 MediaAsset — never served before a clean scan; public only when publicly_servable';

CREATE TABLE media.media_attachments (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  media_asset_id   uuid NOT NULL REFERENCES media.media_assets (id),
  attached_to_type text NOT NULL CHECK (attached_to_type IN ('vehicle','vehicle_issue','portfolio_item','post','review','question',
                     'answer','inventory_item','appointment','provider_job_log','organization','user')),
  attached_to_id   uuid NOT NULL,
  role             text NOT NULL CHECK (role IN ('gallery','cover','logo','avatar','before','after','evidence','issue_photo')),
  pair_group_key   text CHECK (char_length(pair_group_key) BETWEEN 1 AND 60),
  display_order    integer NOT NULL DEFAULT 0 CHECK (display_order BETWEEN 0 AND 1000),
  caption          text CHECK (char_length(caption) <= 300),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  CHECK (role NOT IN ('before','after') OR pair_group_key IS NOT NULL)
);
CREATE INDEX media_attachments_target_idx ON media.media_attachments (attached_to_type, attached_to_id, display_order)
  WHERE status = 'active';
CREATE INDEX media_attachments_asset_idx ON media.media_attachments (media_asset_id);
CREATE UNIQUE INDEX media_attachments_pair_uq ON media.media_attachments (attached_to_type, attached_to_id, pair_group_key, role)
  WHERE role IN ('before','after') AND status = 'active';
COMMENT ON TABLE media.media_attachments IS '52 MediaAttachment — before/after paired by pair_group_key';

-- Delivery data for signed URLs. The media module calls it only after the
-- owning module confirmed the viewer may see the attachment (40 SEC-UP-4).
CREATE FUNCTION media.delivery_info(p_asset_id uuid)
RETURNS TABLE (id uuid, storage_reference text, thumbnail_reference text, mime_type text,
               privacy_level text, publicly_servable boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT a.id, a.storage_reference, a.thumbnail_reference, a.mime_type, a.privacy_level, a.publicly_servable
    FROM media.media_assets a
   WHERE a.id = p_asset_id AND a.status = 'active' AND a.scan_status = 'clean' AND a.deleted_at IS NULL
$$;

\echo '== 17. notification (WP14)'

-- =============================================================================
-- 17. notification — notifications, deliveries, preferences, push tokens
-- =============================================================================
CREATE SCHEMA notification;
COMMENT ON SCHEMA notification IS 'Module notification (WP14): in-app, email, push';

CREATE TABLE notification.notifications (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  recipient_user_id       uuid NOT NULL,
  organization_context_id uuid,
  event_type              text NOT NULL CHECK (event_type IN ('appointment_requested','appointment_confirmed',
    'appointment_alternative_proposed','appointment_status_updated','appointment_reminder','appointment_cancelled',
    'review_invitation','review_status_updated','review_response_published','inquiry_answered','service_reminder',
    'ai_triage_ready','ai_suggestion_ready','favorite_provider_update','appointment_request_received','review_received',
    'review_approval_needed','review_response_draft_ready','ai_skill_insight_ready','customer_message','moderation_alert',
    'profile_suggestion','inquiry_received','inventory_import_finished','ai_fitment_suggestion','low_data_quality_alert',
    'driver_issue_reported','fleet_approval_needed','repair_completed','vehicle_due_for_service','monthly_report_ready',
    'moderation_update','system_announcement','marketing','review_awaiting_approval')),
  category                core.notification_category NOT NULL,
  priority                text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','critical')),
  template_key            text NOT NULL CHECK (template_key ~ '^[a-z0-9_.]{1,120}$'),
  template_params         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(template_params) = 'object'),
  locale                  core.locale NOT NULL,
  reference_entity_type   text CHECK (char_length(reference_entity_type) BETWEEN 1 AND 40),
  reference_entity_id     uuid,
  read_at                 timestamptz,
  status                  text NOT NULL DEFAULT 'created' CHECK (status IN ('created','dispatched','read','expired')),
  CHECK (status <> 'read' OR read_at IS NOT NULL)
);
CREATE INDEX notifications_recipient_idx ON notification.notifications (recipient_user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notification.notifications (recipient_user_id, organization_context_id) WHERE read_at IS NULL;
COMMENT ON TABLE notification.notifications IS '52 Notification — one per recipient; template text lives in the UI dictionary';

CREATE TABLE notification.push_device_tokens (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  user_id         uuid NOT NULL,
  platform        text NOT NULL CHECK (platform IN ('ios','android','web')),
  token_encrypted bytea NOT NULL,                                -- 52 `token`, encrypted at rest
  token_hash      core.hash NOT NULL UNIQUE,
  app_version     text CHECK (char_length(app_version) <= 20),
  locale          core.locale,
  last_seen_at    timestamptz,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked'))
);
CREATE INDEX push_device_tokens_user_idx ON notification.push_device_tokens (user_id) WHERE status = 'active';
COMMENT ON TABLE notification.push_device_tokens IS '52 PushDeviceToken';

CREATE TABLE notification.notification_deliveries (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  notification_id      uuid NOT NULL REFERENCES notification.notifications (id),
  channel              core.notification_channel NOT NULL,
  push_device_token_id uuid REFERENCES notification.push_device_tokens (id),
  status               text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','failed','suppressed')),
  suppressed_reason    text CHECK (suppressed_reason IN ('preference','no_destination','digest')),
  provider_message_id  text CHECK (char_length(provider_message_id) <= 200),
  attempt_count        integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error           text CHECK (char_length(last_error) <= 500),
  sent_at              timestamptz,
  delivered_at         timestamptz,
  CHECK (channel <> 'push' OR push_device_token_id IS NOT NULL),
  CHECK (status <> 'suppressed' OR suppressed_reason IS NOT NULL)
);
CREATE INDEX notification_deliveries_idx ON notification.notification_deliveries (notification_id);
CREATE INDEX notification_deliveries_queue_idx ON notification.notification_deliveries (created_at) WHERE status = 'queued';
COMMENT ON TABLE notification.notification_deliveries IS '52 NotificationDelivery';

CREATE TABLE notification.notification_preferences (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  user_id   uuid NOT NULL,
  channel   core.notification_channel NOT NULL,
  category  core.notification_category NOT NULL,
  enabled   boolean NOT NULL,
  frequency text NOT NULL DEFAULT 'immediate' CHECK (frequency IN ('immediate','daily_digest','weekly_digest')),
  UNIQUE (user_id, channel, category)
);
COMMENT ON TABLE notification.notification_preferences IS '52 NotificationPreference — critical alerts are always delivered in-app';

\echo '== 18. admin (WP15)'

-- =============================================================================
-- 18. admin — reports, moderation, flags, four-eyes, assisted onboarding,
--     retention (WP15)
-- =============================================================================
CREATE SCHEMA admin;
COMMENT ON SCHEMA admin IS 'Module admin (WP15): reports, moderation, feature flags, four-eyes changes, assist sessions, retention';

CREATE TABLE admin.moderation_cases (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  case_type          core.report_target_type NOT NULL,
  target_entity_type text NOT NULL CHECK (char_length(target_entity_type) BETWEEN 1 AND 60),
  target_entity_id   uuid NOT NULL,
  source             text NOT NULL CHECK (source IN ('user_report','ai_flag','system_rule','admin')),
  reason             core.moderation_reason NOT NULL,
  severity           text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  ai_risk_score      core.score,
  ai_flag_insight_id uuid,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','action_taken','dismissed','escalated')),
  assigned_to        uuid,
  resolution         text CHECK (char_length(resolution) <= 1000),
  resolved_at        timestamptz,
  CHECK (status NOT IN ('action_taken','dismissed') OR (resolution IS NOT NULL AND resolved_at IS NOT NULL)),
  CHECK (source <> 'ai_flag' OR ai_flag_insight_id IS NOT NULL)
);
CREATE INDEX moderation_cases_queue_idx ON admin.moderation_cases (status, severity, created_at);
CREATE INDEX moderation_cases_target_idx ON admin.moderation_cases (target_entity_type, target_entity_id);
COMMENT ON TABLE admin.moderation_cases IS '52 ModerationCase — AI flags only open cases; humans decide';

CREATE TABLE admin.content_reports (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  reporter_user_id   uuid NOT NULL,
  target_type        core.report_target_type NOT NULL,
  target_id          uuid NOT NULL,
  reason             core.moderation_reason NOT NULL,
  details            text CHECK (char_length(details) <= 2000),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','triaged','resolved','dismissed')),
  moderation_case_id uuid REFERENCES admin.moderation_cases (id),
  CHECK (status <> 'triaged' OR moderation_case_id IS NOT NULL)
);
CREATE UNIQUE INDEX content_reports_open_uq ON admin.content_reports (reporter_user_id, target_type, target_id) WHERE status = 'open';
CREATE INDEX content_reports_queue_idx ON admin.content_reports (status, created_at);
COMMENT ON TABLE admin.content_reports IS '52 ContentReport — includes wrong location / closed business and AI output';

CREATE TABLE admin.moderation_actions (
  id                 uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  moderation_case_id uuid REFERENCES admin.moderation_cases (id),
  target_entity_type text NOT NULL CHECK (char_length(target_entity_type) BETWEEN 1 AND 60),
  target_entity_id   uuid NOT NULL,
  action_type        text NOT NULL CHECK (action_type IN ('approve','hide','remove','restore','request_changes','warn_user',
                       'suspend_account','reactivate_account','verify_organization','reject_verification','merge_duplicate',
                       'revoke_badge','apply_trust_penalty','confirm_review_approval','reject_review_approval',
                       'request_evidence','correct_location','assist_onboarding')),
  reason             text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  params             jsonb CHECK (params IS NULL OR jsonb_typeof(params) = 'object'),
  actor_user_id      uuid NOT NULL
);
CREATE INDEX moderation_actions_case_idx ON admin.moderation_actions (moderation_case_id, created_at);
CREATE INDEX moderation_actions_target_idx ON admin.moderation_actions (target_entity_type, target_entity_id);
COMMENT ON TABLE admin.moderation_actions IS '52 ModerationAction — append-only; every action has a reason and an AuditLog entry';

CREATE TABLE admin.feature_flags (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  key         text NOT NULL CHECK (key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$' AND char_length(key) <= 80),
  description text CHECK (char_length(description) <= 500),
  flag_type   text NOT NULL CHECK (flag_type IN ('release','beta','ai_feature','kill_switch')),
  enabled     boolean NOT NULL,
  targeting   jsonb CHECK (targeting IS NULL OR jsonb_typeof(targeting) = 'object'),
  environment core.environment NOT NULL,
  UNIQUE (key, environment)
);
COMMENT ON TABLE admin.feature_flags IS '52 FeatureFlag — cached in Redis; ai.automation.kill_switch overrides every ai_feature flag';

CREATE TABLE admin.pending_admin_changes (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  op_id              text NOT NULL CHECK (op_id ~ '^[a-z_]+\.[a-z_]+$'),
  target_entity_type text NOT NULL CHECK (char_length(target_entity_type) BETWEEN 1 AND 60),
  target_entity_id   uuid NOT NULL,
  request_payload    jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  summary            text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 1000),
  reason             text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  requested_by       uuid NOT NULL,
  required_role      text NOT NULL CHECK (required_role IN ('platform_admin','platform_moderator')),
  decided_by         uuid,
  decision_reason    text CHECK (char_length(decision_reason) BETWEEN 3 AND 500),
  decided_at         timestamptz,
  expires_at         timestamptz NOT NULL DEFAULT now() + interval '72 hours',
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  CONSTRAINT pending_admin_changes_four_eyes CHECK (decided_by IS DISTINCT FROM requested_by),
  CHECK (status NOT IN ('approved','rejected') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL))
);
CREATE INDEX pending_admin_changes_queue_idx ON admin.pending_admin_changes (status, expires_at);
COMMENT ON TABLE admin.pending_admin_changes IS '52 PendingAdminChange — four-eyes (40 SEC-ADM-6)';

CREATE TABLE admin.assist_sessions (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  organization_id uuid NOT NULL,
  flow_type       text NOT NULL CHECK (flow_type IN ('provider','vendor','fleet')),
  staff_user_id   uuid NOT NULL,
  reason          text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  started_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '4 hours',
  ended_at        timestamptz,
  end_reason      text CHECK (char_length(end_reason) BETWEEN 3 AND 500),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','expired')),
  CHECK (expires_at <= started_at + interval '4 hours'),
  CHECK (status <> 'ended' OR (ended_at IS NOT NULL AND end_reason IS NOT NULL))
);
CREATE UNIQUE INDEX assist_sessions_active_uq ON admin.assist_sessions (organization_id) WHERE status = 'active';
COMMENT ON TABLE admin.assist_sessions IS '52 AssistSession — staff-assisted onboarding, 4 h, fully audited';

CREATE TABLE admin.data_retention_policies (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  entity_type       text NOT NULL CHECK (char_length(entity_type) BETWEEN 1 AND 60),
  applies_to_status text CHECK (char_length(applies_to_status) BETWEEN 1 AND 40),
  retention_days    integer NOT NULL CHECK (retention_days BETWEEN 1 AND 36500),
  action            text NOT NULL CHECK (action IN ('delete','anonymize','archive')),
  legal_basis       text CHECK (char_length(legal_basis) <= 300),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  UNIQUE NULLS NOT DISTINCT (entity_type, applies_to_status)
);
COMMENT ON TABLE admin.data_retention_policies IS '52 DataRetentionPolicy (MVP §14)';

\echo '== 19. analytics (WP16, primary database part)'

-- =============================================================================
-- 19. analytics — audit log and pseudonym keys (primary database). Product
--     analytics events live in the separate analytics database (§22).
-- =============================================================================
CREATE SCHEMA analytics;
COMMENT ON SCHEMA analytics IS 'Module analytics (WP16): append-only audit log, analytics pseudonym keys';

CREATE TABLE analytics.audit_logs (
  id                     uuid NOT NULL DEFAULT core.uuid_v7(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  actor_type             text NOT NULL CHECK (actor_type IN ('user','platform_staff','system','mcp_client')),
  actor_id               uuid NOT NULL,
  organization_id        uuid,
  action                 text NOT NULL CHECK (action ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$' AND char_length(action) <= 80),
  entity_type            text NOT NULL CHECK (char_length(entity_type) BETWEEN 1 AND 60),
  entity_id              uuid NOT NULL,
  previous_state_summary text CHECK (char_length(previous_state_summary) <= 2000),
  new_state_summary      text CHECK (char_length(new_state_summary) <= 2000),
  reason                 text CHECK (char_length(reason) <= 500),
  access_purpose         text CHECK (access_purpose ~ '^(case|dispute|dsr|verification|approval):[0-9a-f-]{36}$'),
  request_id             text CHECK (char_length(request_id) <= 64),
  PRIMARY KEY (id, created_at),
  CHECK (action <> 'pii.read' OR access_purpose IS NOT NULL)
) PARTITION BY RANGE (created_at);
CREATE TABLE analytics.audit_logs_default PARTITION OF analytics.audit_logs DEFAULT;
CREATE INDEX audit_logs_entity_idx ON analytics.audit_logs (entity_type, entity_id, created_at);
CREATE INDEX audit_logs_actor_idx ON analytics.audit_logs (actor_id, created_at);
COMMENT ON TABLE analytics.audit_logs IS '52 AuditLog — append-only, monthly partitions';

-- Helper used by every module's `AUD` writer (backend/libs L15). SECURITY DEFINER:
-- the application roles may only INSERT audit entries; RETURNING would otherwise
-- need SELECT on the append-only table.
CREATE FUNCTION analytics.write_audit(p_action text, p_entity_type text, p_entity_id uuid,
                                      p_reason text DEFAULT NULL, p_previous text DEFAULT NULL, p_new text DEFAULT NULL,
                                      p_access_purpose text DEFAULT NULL)
RETURNS uuid
LANGUAGE sql VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  INSERT INTO analytics.audit_logs (actor_type, actor_id, organization_id, action, entity_type, entity_id,
                                    previous_state_summary, new_state_summary, reason, access_purpose, request_id)
  VALUES (CASE core.actor_type() WHEN 'staff' THEN 'platform_staff' WHEN 'user' THEN 'user' ELSE 'system' END,
          core.actor_id(), core.my_org(), p_action, p_entity_type, p_entity_id,
          left(p_previous, 2000), left(p_new, 2000), left(p_reason, 500), p_access_purpose, core.request_id())
  RETURNING id
$$;

CREATE TABLE analytics.actor_pseudonyms (
  user_id       uuid PRIMARY KEY,
  pseudonym_key bytea NOT NULL DEFAULT (uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()))
                  CHECK (octet_length(pseudonym_key) = 32),
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE analytics.actor_pseudonyms IS '52 ActorPseudonym — deleted on user deletion so past events become unlinkable';

\echo '== 20. ai_mcp (WP17, WP18)'

-- =============================================================================
-- 20. ai_mcp — MCP registry and access log, AI insights, suggestions,
--     approvals, evaluation, triage, skill heatmap, embeddings
-- =============================================================================
CREATE SCHEMA ai_mcp;
COMMENT ON SCHEMA ai_mcp IS 'AI/MCP platform (WP17, WP18): registry, access log, insights, approvals, triage, heatmap, embeddings';

-- Every element of a text array matches a pattern (used for MCP key lists).
CREATE FUNCTION core.all_match(a text[], pattern text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$ SELECT coalesce(bool_and(x ~ pattern), true) FROM unnest(a) x $$;

CREATE TABLE ai_mcp.mcp_clients (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  name                 text NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9_]{3,80}$'),
  client_type          text NOT NULL CHECK (client_type IN ('internal_assistant','matching_engine','moderation_assistant',
                         'analytics_engine','partner_agent_future')),
  allowed_scopes       text[] NOT NULL DEFAULT '{}' CHECK (core.all_match(allowed_scopes, '^(read|draft|approve|write):[a-z_.]+(:[a-z_]+)?$')),
  allowed_resources    text[] NOT NULL DEFAULT '{}' CHECK (core.all_match(allowed_resources, '^res:[a-z_.]+$')),
  allowed_tools        text[] NOT NULL DEFAULT '{}' CHECK (core.all_match(allowed_tools, '^tool:[a-z_.]+@[0-9]+(\.[0-9]+)*$')),
  rate_limit_policy    text NOT NULL CHECK (rate_limit_policy ~ '^[a-z0-9_.]{1,80}$'),
  geo_restrictions     core.country[] NOT NULL DEFAULT '{}',
  environment          core.environment NOT NULL,
  credential_reference text CHECK (char_length(credential_reference) <= 300),   -- secret-store key only
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  CONSTRAINT mcp_clients_mvp_reserved CHECK (client_type <> 'partner_agent_future')
);
COMMENT ON TABLE ai_mcp.mcp_clients IS '52 McpClient — scopes, resources and tools from 53';

CREATE TABLE ai_mcp.ai_insights (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  insight_type          core.insight_type NOT NULL,
  subject_entity_type   text NOT NULL CHECK (char_length(subject_entity_type) BETWEEN 1 AND 60),
  subject_entity_id     uuid NOT NULL,
  organization_id       uuid,
  owner_user_id         uuid,
  input_references      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(input_references) = 'array'),
  source_tool_key       text NOT NULL CHECK (source_tool_key ~ '^tool:[a-z_.]+$'),
  source_tool_version   text NOT NULL CHECK (char_length(source_tool_version) BETWEEN 1 AND 20),
  source_client_id      uuid REFERENCES ai_mcp.mcp_clients (id),
  prompt_key            text CHECK (char_length(prompt_key) <= 120),
  prompt_version        text CHECK (char_length(prompt_version) <= 20),
  model_version         text NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 60),
  locale                core.locale NOT NULL,
  confidence_score      core.score,
  summary               text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  structured_payload    jsonb,
  evidence_references   jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence_references) = 'array'),
  safety_flags          text[] NOT NULL DEFAULT '{}' CHECK (safety_flags <@ ARRAY['safety_critical','legal_sensitive','privacy_sensitive']),
  visibility            text NOT NULL CHECK (visibility IN ('internal','owner_only','public_after_approval')),
  human_approval_status core.human_approval_status NOT NULL DEFAULT 'not_required',
  expires_at            timestamptz,
  CHECK (insight_type NOT IN ('capability_suggestion','badge_eligibility') OR jsonb_array_length(evidence_references) > 0),
  CHECK (visibility = 'internal' OR organization_id IS NOT NULL OR owner_user_id IS NOT NULL)
);
CREATE INDEX ai_insights_subject_idx ON ai_mcp.ai_insights (subject_entity_type, subject_entity_id, created_at DESC);
CREATE INDEX ai_insights_org_idx ON ai_mcp.ai_insights (organization_id, created_at DESC) WHERE organization_id IS NOT NULL;
CREATE INDEX ai_insights_owner_idx ON ai_mcp.ai_insights (owner_user_id, created_at DESC) WHERE owner_user_id IS NOT NULL;
COMMENT ON TABLE ai_mcp.ai_insights IS '52 AiInsight — every AI output; never mixed into source data';

CREATE TABLE ai_mcp.mcp_access_logs (
  id                   uuid NOT NULL DEFAULT core.uuid_v7(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  mcp_client_id        uuid NOT NULL REFERENCES ai_mcp.mcp_clients (id),
  principal_type       text NOT NULL CHECK (principal_type IN ('user','organization','system')),
  principal_id         uuid NOT NULL,
  organization_id      uuid,
  operation_type       text NOT NULL CHECK (operation_type IN ('resource_read','tool_invoke')),
  resource_or_tool_key text NOT NULL CHECK (resource_or_tool_key ~ '^(res|tool):[a-z_.]+$'),
  tool_version         text CHECK (char_length(tool_version) <= 20),
  risk_level           core.mcp_risk_level NOT NULL,
  context_resources    text[] NOT NULL DEFAULT '{}',
  context_entity_type  text CHECK (char_length(context_entity_type) <= 60),
  context_entity_id    uuid,
  consent_reference_id uuid,
  redactions_applied   text[] NOT NULL DEFAULT '{}',
  policy_decision      text NOT NULL CHECK (policy_decision IN ('allowed','denied','consent_required','approval_required','rate_limited','error')),
  approval_request_id  uuid,
  output_insight_id    uuid,
  model_version        text CHECK (char_length(model_version) <= 60),
  result_status        text NOT NULL CHECK (result_status IN ('success','failure','partial')),
  latency_ms           integer CHECK (latency_ms BETWEEN 0 AND 600000),
  request_id           text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 64),
  PRIMARY KEY (id, created_at),
  CHECK (operation_type <> 'tool_invoke' OR tool_version IS NOT NULL)
) PARTITION BY RANGE (created_at);
CREATE TABLE ai_mcp.mcp_access_logs_default PARTITION OF ai_mcp.mcp_access_logs DEFAULT;
CREATE INDEX mcp_access_logs_client_idx ON ai_mcp.mcp_access_logs (mcp_client_id, created_at);
CREATE INDEX mcp_access_logs_principal_idx ON ai_mcp.mcp_access_logs (principal_id, created_at);
COMMENT ON TABLE ai_mcp.mcp_access_logs IS '52 McpAccessLog — append-only, monthly partitions';

CREATE TABLE ai_mcp.ai_suggestions (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  insight_id         uuid NOT NULL REFERENCES ai_mcp.ai_insights (id),
  target_entity_type text NOT NULL CHECK (char_length(target_entity_type) BETWEEN 1 AND 60),
  target_entity_id   uuid NOT NULL,
  organization_id    uuid,
  owner_user_id      uuid,
  suggestion_text    text NOT NULL CHECK (char_length(suggestion_text) BETWEEN 1 AND 2000),
  suggested_action   text NOT NULL CHECK (suggested_action IN ('add','update','remove','publish_draft','confirm','review')),
  proposed_payload   jsonb,
  edited_payload     jsonb,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','accepted_with_edits','rejected','expired')),
  decided_by         uuid,
  decided_at         timestamptz,
  CHECK (organization_id IS NOT NULL OR owner_user_id IS NOT NULL),
  CHECK (status IN ('pending','expired') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'accepted_with_edits' OR edited_payload IS NOT NULL)
);
CREATE INDEX ai_suggestions_org_idx ON ai_mcp.ai_suggestions (organization_id, status) WHERE organization_id IS NOT NULL;
CREATE INDEX ai_suggestions_owner_idx ON ai_mcp.ai_suggestions (owner_user_id, status) WHERE owner_user_id IS NOT NULL;
COMMENT ON TABLE ai_mcp.ai_suggestions IS '52 AiSuggestion — a human accepts, edits or rejects';

CREATE TABLE ai_mcp.approval_requests (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  requested_by_client_id uuid REFERENCES ai_mcp.mcp_clients (id),
  requested_by_user_id   uuid,
  action_type            text NOT NULL CHECK (action_type IN ('publish_review_response','publish_showcase','approve_capability',
                           'confirm_fitment','apply_inventory_normalization','publish_profile_change','send_appointment_request',
                           'upgrade_capability_level','moderate_content','admin_action')),
  subject_entity_type    text NOT NULL CHECK (char_length(subject_entity_type) BETWEEN 1 AND 60),
  subject_entity_id      uuid NOT NULL,
  organization_id        uuid,
  owner_user_id          uuid,
  risk_level             core.mcp_risk_level NOT NULL,
  summary                text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 1000),
  insight_id             uuid REFERENCES ai_mcp.ai_insights (id),
  payload_reference      text CHECK (char_length(payload_reference) <= 200),
  approver_role          core.role_key NOT NULL,
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  decision_reason        text CHECK (char_length(decision_reason) <= 500),
  decided_by             uuid,
  decided_at             timestamptz,
  CHECK (status IN ('pending','expired') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT approval_requests_no_self_approval CHECK (decided_by IS DISTINCT FROM requested_by_user_id),
  CHECK (organization_id IS NOT NULL OR owner_user_id IS NOT NULL OR approver_role LIKE 'platform\_%')
);
CREATE INDEX approval_requests_org_idx ON ai_mcp.approval_requests (organization_id, status) WHERE organization_id IS NOT NULL;
COMMENT ON TABLE ai_mcp.approval_requests IS '52 ApprovalRequest — human approval for AI drafts and sensitive actions';

CREATE TABLE ai_mcp.ai_evaluation_records (
  id            uuid PRIMARY KEY DEFAULT core.uuid_v7(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  insight_id    uuid NOT NULL REFERENCES ai_mcp.ai_insights (id),
  feedback_type text NOT NULL CHECK (feedback_type IN ('accepted','accepted_with_edits','rejected','corrected','moderator_override',
                  'hallucination_report','match_selected','match_ignored','rating')),
  rating        smallint CHECK (rating BETWEEN 1 AND 5),
  edit_ratio    numeric(4,3) CHECK (edit_ratio BETWEEN 0 AND 1),
  comment       text CHECK (char_length(comment) <= 1000),
  actor_user_id uuid,
  CHECK (feedback_type <> 'rating' OR rating IS NOT NULL)
);
CREATE INDEX ai_evaluation_records_insight_idx ON ai_mcp.ai_evaluation_records (insight_id);
CREATE INDEX ai_evaluation_records_type_idx ON ai_mcp.ai_evaluation_records (feedback_type, created_at);
COMMENT ON TABLE ai_mcp.ai_evaluation_records IS '52 AiEvaluationRecord — append-only feedback for the evaluation layer';

CREATE TABLE ai_mcp.triage_sessions (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  user_id                     uuid NOT NULL,
  organization_id             uuid,
  vehicle_id                  uuid NOT NULL,
  issue_id                    uuid,
  locale                      core.locale NOT NULL,
  turns                       jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(turns) = 'array' AND jsonb_array_length(turns) <= 40),
  symptom_node_ids            uuid[] NOT NULL DEFAULT '{}',
  likely_system_node_ids      uuid[] NOT NULL DEFAULT '{}',
  urgency_level               core.urgency_level,
  safety_critical             boolean NOT NULL DEFAULT false,
  recommended_service_node_id uuid,
  result_insight_id           uuid REFERENCES ai_mcp.ai_insights (id),
  match_session_id            uuid,
  appointment_draft_id        uuid,
  status                      text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','abandoned','escalated_safety')),
  CHECK (status <> 'escalated_safety' OR safety_critical)
);
CREATE INDEX triage_sessions_user_idx ON ai_mcp.triage_sessions (user_id, created_at DESC);
COMMENT ON TABLE ai_mcp.triage_sessions IS '52 TriageSession — Help Me; optional for search and appointments';

CREATE TABLE ai_mcp.skill_heatmap_entries (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  provider_organization_id uuid NOT NULL,
  scope_type               text NOT NULL CHECK (scope_type IN ('brand','model','series','service_system','service_task')),
  taxonomy_node_id         uuid NOT NULL,
  score                    numeric(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  confidence               text NOT NULL CHECK (confidence IN ('low','moderate','high')),
  classification           text NOT NULL CHECK (classification IN ('strong','emerging','weak','opportunity')),
  trend                    text CHECK (trend IN ('rising','stable','declining')),
  rating_trend             numeric(4,2),
  repeat_customer_count    integer CHECK (repeat_customer_count >= 0),
  local_demand_score       numeric(5,2) CHECK (local_demand_score BETWEEN 0 AND 100),
  evidence_summary         text CHECK (char_length(evidence_summary) <= 1000),
  insight_id               uuid NOT NULL REFERENCES ai_mcp.ai_insights (id),
  generated_at             timestamptz NOT NULL DEFAULT now(),
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','hidden'))
);
CREATE UNIQUE INDEX skill_heatmap_entries_active_uq ON ai_mcp.skill_heatmap_entries (provider_organization_id, scope_type, taxonomy_node_id)
  WHERE status = 'active';
COMMENT ON TABLE ai_mcp.skill_heatmap_entries IS '52 SkillHeatmapEntry — private to the provider, needs provider_analytics_ai_use';

CREATE TABLE ai_mcp.embeddings (
  id uuid PRIMARY KEY DEFAULT core.uuid_v7(), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid DEFAULT core.actor_id(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz, deletion_reason text CHECK (char_length(deletion_reason) <= 500),
  entity_type     text NOT NULL CHECK (entity_type IN ('provider_profile','inventory_item','review','question','post',
                    'portfolio_item','taxonomy_node','vehicle_issue')),
  entity_id       uuid NOT NULL,
  organization_id uuid,
  locale          core.locale NOT NULL,
  embedding_model text NOT NULL CHECK (char_length(embedding_model) BETWEEN 1 AND 80),
  dimensions      integer NOT NULL CHECK (dimensions BETWEEN 1 AND 4096),
  embedding       ext.vector NOT NULL,                          -- 52 `vector`
  content_hash    core.hash NOT NULL,
  CHECK (ext.vector_dims(embedding) = dimensions),
  CHECK (entity_type <> 'inventory_item' OR organization_id IS NOT NULL),
  UNIQUE (entity_type, entity_id, locale, embedding_model)
);
-- HNSW index for the default 1536-dimension model; add one per model dimension.
CREATE INDEX embeddings_hnsw_1536 ON ai_mcp.embeddings
  USING hnsw ((embedding::ext.vector(1536)) ext.vector_cosine_ops) WHERE dimensions = 1536;
CREATE INDEX embeddings_tenant_idx ON ai_mcp.embeddings (organization_id, entity_type) WHERE organization_id IS NOT NULL;
COMMENT ON TABLE ai_mcp.embeddings IS '52 Embedding — org-private vectors are queried only inside their tenant';

-- Monthly partitions of the two partitioned logs (the scheduler keeps 3 months ahead).
SELECT core.ensure_monthly_partitions('analytics.audit_logs', 3) AS audit_partitions,
       core.ensure_monthly_partitions('ai_mcp.mcp_access_logs', 3) AS mcp_log_partitions \gset

\echo '== 21. Security: triggers, row-level security, grants'

-- =============================================================================
-- 21. Security inside the database server
--
--   21.1 generic triggers (touch, append-only)
--   21.2 row-level security: enabled on every module table; `system` and
--        `staff` contexts; tenant policies per table (40 SEC-AZ-3)
--   21.3 grants per role (least privilege), default privileges
--
-- Tenant predicates use the transaction-local context set by core.set_context:
--   core.me()      — the authenticated user
--   core.my_org()  — the organization of the request path ({org})
-- Public read policies expose only published or approved rows; column-level
-- secrecy (exact coordinates, trade prices, internal notes, AI flags) is
-- enforced by the API's allowlist projections (40 SEC-AZ-5, SEC-OUT-1).
-- =============================================================================

-- ------------------------------------------------------------ 21.1 triggers
DO $gen$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.oid, n.nspname, c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('core','identity','organization','billing','taxonomy','vehicle','inventory','discovery',
                         'trust','appointment','fleet','community','media','notification','admin','analytics','ai_mcp')
       AND c.relkind IN ('r','p') AND NOT c.relispartition
  LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attname = 'updated_at' AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attname = 'version' AND NOT a.attisdropped) THEN
      EXECUTE format('CREATE TRIGGER zz_touch BEFORE UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION core.tg_touch()',
                     t.nspname, t.relname);
    END IF;
    IF t.nspname <> 'core' OR t.relname IN ('domain_event_outbox','background_jobs') THEN
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.nspname, t.relname);
      EXECUTE format('CREATE POLICY system_all ON %I.%I FOR ALL USING (core.is_system()) WITH CHECK (core.is_system())',
                     t.nspname, t.relname);
      EXECUTE format('CREATE POLICY staff_all ON %I.%I FOR ALL USING (core.is_staff()) WITH CHECK (core.is_staff())',
                     t.nspname, t.relname);
    END IF;
  END LOOP;
END
$gen$;

-- Append-only tables: no UPDATE, DELETE or TRUNCATE for anyone but the owner.
DO $ao$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vehicle.vehicle_status_history','appointment.appointment_status_history',
                           'admin.moderation_actions','analytics.audit_logs','ai_mcp.mcp_access_logs',
                           'ai_mcp.ai_evaluation_records']
  LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION core.tg_append_only()', t);
    EXECUTE format('CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION core.tg_append_only()', t);
  END LOOP;
END
$ao$;

-- ----------------------------------------------------- 21.2 tenant policies
-- core -------------------------------------------------------------------------
CREATE POLICY write_any ON core.domain_event_outbox FOR INSERT WITH CHECK (true);
CREATE POLICY owner_all ON core.background_jobs FOR ALL
  USING (owner_user_id = core.me() OR organization_id = core.my_org())
  WITH CHECK (owner_user_id = core.me() OR organization_id = core.my_org());

-- identity ---------------------------------------------------------------------
CREATE POLICY self_read ON identity.user_accounts FOR SELECT USING (id = core.me());
CREATE POLICY self_update ON identity.user_accounts FOR UPDATE USING (id = core.me()) WITH CHECK (id = core.me());
CREATE POLICY org_members_read ON identity.user_accounts FOR SELECT USING (
  core.my_org() IS NOT NULL AND EXISTS (
    SELECT 1 FROM identity.role_memberships m
     WHERE m.user_id = user_accounts.id AND m.organization_id = core.my_org() AND m.status <> 'removed'));
CREATE POLICY self_all ON identity.authentication_methods FOR ALL USING (user_id = core.me()) WITH CHECK (user_id = core.me());
CREATE POLICY self_all ON identity.verification_tokens FOR ALL USING (user_id = core.me()) WITH CHECK (user_id = core.me());
CREATE POLICY self_all ON identity.user_preferences FOR ALL USING (user_id = core.me()) WITH CHECK (user_id = core.me());
CREATE POLICY self_or_org ON identity.role_memberships FOR ALL
  USING (user_id = core.me() OR organization_id = core.my_org())
  WITH CHECK (user_id = core.me() OR organization_id = core.my_org());
CREATE POLICY subject_all ON identity.consent_records FOR ALL
  USING ((subject_type = 'user' AND subject_id = core.me()) OR (subject_type = 'organization' AND subject_id = core.my_org()))
  WITH CHECK ((subject_type = 'user' AND subject_id = core.me()) OR (subject_type = 'organization' AND subject_id = core.my_org()));
CREATE POLICY grantee_read ON identity.consent_records FOR SELECT
  USING (granted_to_type = 'organization' AND granted_to_id = core.my_org());
CREATE POLICY party_all ON identity.consent_requests FOR ALL
  USING (subject_user_id = core.me() OR requested_by_organization_id = core.my_org())
  WITH CHECK (subject_user_id = core.me() OR requested_by_organization_id = core.my_org());
CREATE POLICY self_all ON identity.data_subject_requests FOR ALL USING (user_id = core.me()) WITH CHECK (user_id = core.me());
CREATE POLICY self_all ON identity.onboarding_progress FOR ALL USING (user_id = core.me()) WITH CHECK (user_id = core.me());

-- organization -----------------------------------------------------------------
-- org.create: the application generates the id, switches the context to it,
-- then inserts (no row of another organization can be created).
CREATE POLICY member_all ON organization.organizations FOR ALL USING (id = core.my_org()) WITH CHECK (id = core.my_org());
CREATE POLICY create_draft ON organization.organizations FOR INSERT
  WITH CHECK (core.me() IS NOT NULL AND id = core.my_org() AND status = 'draft');
CREATE POLICY public_read ON organization.organizations FOR SELECT USING (status = 'active' AND deleted_at IS NULL);

CREATE POLICY member_all ON organization.organization_locations FOR ALL
  USING (organization_id = core.my_org()) WITH CHECK (organization_id = core.my_org());
CREATE POLICY public_read ON organization.organization_locations FOR SELECT
  USING (status = 'active' AND deleted_at IS NULL);
CREATE POLICY member_all ON organization.organization_verifications FOR ALL
  USING (organization_id = core.my_org()) WITH CHECK (organization_id = core.my_org());

CREATE POLICY member_all ON organization.provider_profiles FOR ALL
  USING (organization_id = core.my_org()) WITH CHECK (organization_id = core.my_org());
CREATE POLICY public_read ON organization.provider_profiles FOR SELECT USING (public_status = 'published');
CREATE POLICY member_all ON organization.vendor_profiles FOR ALL
  USING (organization_id = core.my_org()) WITH CHECK (organization_id = core.my_org());
CREATE POLICY public_read ON organization.vendor_profiles FOR SELECT USING (public_status = 'published');

CREATE POLICY member_all ON organization.provider_certifications FOR ALL
  USING (provider_organization_id = core.my_org()) WITH CHECK (provider_organization_id = core.my_org());
CREATE POLICY public_read ON organization.provider_certifications FOR SELECT
  USING (status = 'active' AND verification_status = 'verified');
CREATE POLICY member_all ON organization.provider_service_categories FOR ALL
  USING (provider_organization_id = core.my_org()) WITH CHECK (provider_organization_id = core.my_org());
CREATE POLICY public_read ON organization.provider_service_categories FOR SELECT
  USING (status = 'active' AND visibility = 'public');
CREATE POLICY member_all ON organization.provider_vehicle_coverage FOR ALL
  USING (provider_organization_id = core.my_org()) WITH CHECK (provider_organization_id = core.my_org());
CREATE POLICY public_read ON organization.provider_vehicle_coverage FOR SELECT USING (status = 'active');
CREATE POLICY member_all ON organization.provider_capabilities FOR ALL
  USING (provider_organization_id = core.my_org()) WITH CHECK (provider_organization_id = core.my_org());
CREATE POLICY public_read ON organization.provider_capabilities FOR SELECT
  USING (status = 'active' AND public_visibility AND confidence_level <> 'self_declared');
CREATE POLICY member_all ON organization.provider_capability_evidence FOR ALL
  USING (EXISTS (SELECT 1 FROM organization.provider_capabilities c
                  WHERE c.id = capability_id AND c.provider_organization_id = core.my_org()))
  WITH CHECK (EXISTS (SELECT 1 FROM organization.provider_capabilities c
                       WHERE c.id = capability_id AND c.provider_organization_id = core.my_org()));
CREATE POLICY member_all ON organization.provider_job_logs FOR ALL
  USING (provider_organization_id = core.my_org()) WITH CHECK (provider_organization_id = core.my_org());
CREATE POLICY member_all ON organization.provider_customer_notes FOR ALL
  USING (provider_organization_id = core.my_org()) WITH CHECK (provider_organization_id = core.my_org());
CREATE POLICY member_all ON organization.portfolio_items FOR ALL
  USING (provider_organization_id = core.my_org()) WITH CHECK (provider_organization_id = core.my_org());
CREATE POLICY public_read ON organization.portfolio_items FOR SELECT
  USING (status = 'published' AND visibility = 'public');
CREATE POLICY member_all ON organization.vendor_coverage FOR ALL
  USING (vendor_organization_id = core.my_org()) WITH CHECK (vendor_organization_id = core.my_org());
CREATE POLICY public_read ON organization.vendor_coverage FOR SELECT USING (status = 'active');

-- billing ----------------------------------------------------------------------
CREATE POLICY public_read ON billing.plans FOR SELECT USING (status = 'active');
CREATE POLICY public_read ON billing.entitlements FOR SELECT USING (true);
CREATE POLICY subscriber_read ON billing.subscriptions FOR SELECT
  USING ((subscriber_type = 'user' AND subscriber_id = core.me())
      OR (subscriber_type = 'organization' AND subscriber_id = core.my_org()));
-- org.create gives the new organization the default plan of its audience.
CREATE POLICY default_plan_insert ON billing.subscriptions FOR INSERT
  WITH CHECK (subscriber_type = 'organization' AND subscriber_id = core.my_org() AND status = 'active'
              AND EXISTS (SELECT 1 FROM billing.plans p WHERE p.id = plan_id AND p.is_default_for_audience));
CREATE POLICY member_all ON billing.subscription_change_requests FOR ALL
  USING (organization_id = core.my_org()) WITH CHECK (organization_id = core.my_org());

-- Serializes entitlement checks per subscriber (40 SEC-AZ-9).
CREATE FUNCTION billing.lock_subscriber(p_subscriber_type text, p_subscriber_id uuid) RETURNS void
LANGUAGE sql VOLATILE
SET search_path = pg_catalog
AS $$ SELECT pg_advisory_xact_lock(hashtextextended('billing.subscriber:' || p_subscriber_type || ':' || p_subscriber_id::text, 0)) $$;

-- taxonomy (public vocabulary) ------------------------------------------------
CREATE POLICY public_read ON taxonomy.taxonomy_nodes FOR SELECT USING (true);
CREATE POLICY public_read ON taxonomy.taxonomy_synonyms FOR SELECT USING (status = 'active');
CREATE POLICY public_read ON taxonomy.taxonomy_mappings FOR SELECT USING (status = 'active');

-- vehicle ----------------------------------------------------------------------
CREATE POLICY owner_all ON vehicle.vehicles FOR ALL
  USING ((owner_type = 'user' AND owner_id = core.me()) OR (owner_type = 'organization' AND owner_id = core.my_org()))
  WITH CHECK ((owner_type = 'user' AND owner_id = core.me()) OR (owner_type = 'organization' AND owner_id = core.my_org()));
-- Child rows are visible when the parent vehicle is visible (the sub-select is itself under RLS).
DO $veh$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vehicle_mileage_logs','vehicle_documents','vehicle_issues','vehicle_service_records',
                           'maintenance_reminders','vehicle_status_history']
  LOOP
    EXECUTE format($p$CREATE POLICY via_vehicle ON vehicle.%I FOR ALL
      USING (EXISTS (SELECT 1 FROM vehicle.vehicles v WHERE v.id = vehicle_id))
      WITH CHECK (EXISTS (SELECT 1 FROM vehicle.vehicles v WHERE v.id = vehicle_id))$p$, t);
  END LOOP;
END
$veh$;
CREATE POLICY via_record ON vehicle.service_record_evidence FOR ALL
  USING (EXISTS (SELECT 1 FROM vehicle.vehicle_service_records r WHERE r.id = service_record_id))
  WITH CHECK (EXISTS (SELECT 1 FROM vehicle.vehicle_service_records r WHERE r.id = service_record_id));
-- Providers see and log the service records they performed (consent checked by the API).
CREATE POLICY provider_read ON vehicle.vehicle_service_records FOR SELECT USING (provider_organization_id = core.my_org());
CREATE POLICY provider_insert ON vehicle.vehicle_service_records FOR INSERT
  WITH CHECK (provider_organization_id = core.my_org() AND created_by_type = 'organization'
              AND source_type IN ('provider_logged','appointment_completed'));
-- Documents explicitly shared with a provider.
CREATE POLICY shared_read ON vehicle.vehicle_documents FOR SELECT
  USING (visibility = 'shared_with_provider' AND status = 'active' AND shared_with_organization_id = core.my_org());

-- inventory --------------------------------------------------------------------
CREATE POLICY vendor_all ON inventory.inventory_items FOR ALL
  USING (vendor_organization_id = core.my_org()) WITH CHECK (vendor_organization_id = core.my_org());
CREATE POLICY public_read ON inventory.inventory_items FOR SELECT
  USING (status = 'active' AND visibility = 'public' AND deleted_at IS NULL);
CREATE POLICY trade_read ON inventory.inventory_items FOR SELECT
  USING (status = 'active' AND visibility = 'trade_only' AND deleted_at IS NULL AND core.my_org() IS NOT NULL
         AND EXISTS (SELECT 1 FROM inventory.vendor_trade_accounts t
                      WHERE t.vendor_organization_id = inventory_items.vendor_organization_id
                        AND t.trade_customer_organization_id = core.my_org() AND t.status = 'approved'));
CREATE POLICY vendor_all ON inventory.inventory_fitment FOR ALL
  USING (EXISTS (SELECT 1 FROM inventory.inventory_items i WHERE i.id = inventory_item_id AND i.vendor_organization_id = core.my_org()))
  WITH CHECK (EXISTS (SELECT 1 FROM inventory.inventory_items i WHERE i.id = inventory_item_id AND i.vendor_organization_id = core.my_org()));
CREATE POLICY public_read ON inventory.inventory_fitment FOR SELECT
  USING (status = 'active' AND EXISTS (SELECT 1 FROM inventory.inventory_items i WHERE i.id = inventory_item_id));
CREATE POLICY vendor_all ON inventory.vendor_trade_accounts FOR ALL
  USING (vendor_organization_id = core.my_org()) WITH CHECK (vendor_organization_id = core.my_org());
CREATE POLICY customer_read ON inventory.vendor_trade_accounts FOR SELECT USING (trade_customer_organization_id = core.my_org());
CREATE POLICY customer_request ON inventory.vendor_trade_accounts FOR INSERT
  WITH CHECK (trade_customer_organization_id = core.my_org() AND status = 'requested');
CREATE POLICY party_all ON inventory.stock_inquiries FOR ALL
  USING (vendor_organization_id = core.my_org() OR requester_organization_id = core.my_org()
         OR (requester_type = 'user' AND requester_user_id = core.me()))
  WITH CHECK (vendor_organization_id = core.my_org() OR requester_organization_id = core.my_org()
              OR (requester_type = 'user' AND requester_user_id = core.me()));
CREATE POLICY via_inquiry ON inventory.inquiry_messages FOR ALL
  USING (EXISTS (SELECT 1 FROM inventory.stock_inquiries q WHERE q.id = inquiry_id))
  WITH CHECK (EXISTS (SELECT 1 FROM inventory.stock_inquiries q WHERE q.id = inquiry_id));
CREATE POLICY vendor_all ON inventory.inventory_import_batches FOR ALL
  USING (vendor_organization_id = core.my_org()) WITH CHECK (vendor_organization_id = core.my_org());

-- discovery --------------------------------------------------------------------
CREATE POLICY requester_all ON discovery.match_sessions FOR ALL
  USING (requester_user_id = core.me() OR requester_organization_id = core.my_org()
         OR (requester_user_id IS NULL AND anonymous_key_hash = core.my_anon_key()))
  WITH CHECK (requester_user_id = core.me() OR requester_organization_id = core.my_org()
              OR (requester_user_id IS NULL AND anonymous_key_hash = core.my_anon_key()));
CREATE POLICY via_session ON discovery.match_results FOR ALL
  USING (EXISTS (SELECT 1 FROM discovery.match_sessions s WHERE s.id = match_session_id))
  WITH CHECK (EXISTS (SELECT 1 FROM discovery.match_sessions s WHERE s.id = match_session_id));

-- trust ------------------------------------------------------------------------
CREATE POLICY author_all ON trust.reviews FOR ALL USING (author_user_id = core.me()) WITH CHECK (author_user_id = core.me());
CREATE POLICY subject_read ON trust.reviews FOR SELECT USING (subject_organization_id = core.my_org());
CREATE POLICY subject_answer ON trust.reviews FOR UPDATE
  USING (subject_organization_id = core.my_org()) WITH CHECK (subject_organization_id = core.my_org());
CREATE POLICY public_read ON trust.reviews FOR SELECT USING (status = 'published');
CREATE POLICY via_review ON trust.review_sub_ratings FOR SELECT
  USING (EXISTS (SELECT 1 FROM trust.reviews r WHERE r.id = review_id));
CREATE POLICY author_all ON trust.review_sub_ratings FOR ALL
  USING (EXISTS (SELECT 1 FROM trust.reviews r WHERE r.id = review_id AND r.author_user_id = core.me()))
  WITH CHECK (EXISTS (SELECT 1 FROM trust.reviews r WHERE r.id = review_id AND r.author_user_id = core.me()));
CREATE POLICY via_review ON trust.review_tags FOR SELECT
  USING (EXISTS (SELECT 1 FROM trust.reviews r WHERE r.id = review_id));
CREATE POLICY author_all ON trust.review_tags FOR ALL
  USING (EXISTS (SELECT 1 FROM trust.reviews r WHERE r.id = review_id AND r.author_user_id = core.me()))
  WITH CHECK (EXISTS (SELECT 1 FROM trust.reviews r WHERE r.id = review_id AND r.author_user_id = core.me()));
CREATE POLICY org_all ON trust.review_responses FOR ALL
  USING (organization_id = core.my_org()) WITH CHECK (organization_id = core.my_org());
CREATE POLICY public_read ON trust.review_responses FOR SELECT
  USING (status = 'published' AND EXISTS (SELECT 1 FROM trust.reviews r WHERE r.id = review_id));
CREATE POLICY org_all ON trust.review_requests FOR ALL
  USING (subject_organization_id = core.my_org()) WITH CHECK (subject_organization_id = core.my_org());
CREATE POLICY invitee_all ON trust.review_requests FOR ALL
  USING (invited_user_id = core.me()) WITH CHECK (invited_user_id = core.me());
CREATE POLICY raiser_all ON trust.disputes FOR ALL
  USING (raised_by_user_id = core.me() OR raised_by_organization_id = core.my_org())
  WITH CHECK (raised_by_user_id = core.me() OR raised_by_organization_id = core.my_org());
CREATE POLICY subject_read ON trust.trust_signals FOR SELECT
  USING (subject_type = 'organization' AND subject_id = core.my_org()
         AND signal_type NOT IN ('risk_fraud_flag','review_authenticity_score'));
CREATE POLICY public_read ON trust.trust_signals FOR SELECT USING (is_public);
CREATE POLICY org_read ON trust.provider_badges FOR SELECT USING (provider_organization_id = core.my_org());
CREATE POLICY public_read ON trust.provider_badges FOR SELECT USING (status = 'active' AND visibility = 'public');

-- Opening a review invitation link is anonymous (40 review_invitations.open):
-- one atomic update by token hash, returning only what the landing page needs.
CREATE FUNCTION trust.open_invitation(p_token_hash bytea)
RETURNS TABLE (invitation_id uuid, subject_organization_id uuid, appointment_id uuid, service_record_id uuid,
               stock_inquiry_id uuid, provider_job_log_id uuid, invited_user_id uuid, expires_at timestamptz,
               business_confirmation_given boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  r trust.review_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM trust.review_requests q WHERE q.link_token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR r.status IN ('expired','cancelled','pending') OR r.expires_at < now() THEN
    RAISE EXCEPTION 'LINK_EXPIRED' USING ERRCODE = 'P0410';
  END IF;
  IF r.token_used_at IS NOT NULL OR r.status = 'converted' THEN
    RAISE EXCEPTION 'LINK_USED' USING ERRCODE = 'P0411';
  END IF;
  IF r.opened_at IS NULL THEN
    UPDATE trust.review_requests q SET opened_at = now(),
           status = CASE WHEN q.status IN ('sent','reminded') THEN 'opened' ELSE q.status END
     WHERE q.id = r.id;
    PERFORM core.publish_event('review.invitation.opened', 'review_request', r.id, '{}'::jsonb);
  END IF;
  RETURN QUERY SELECT r.id, r.subject_organization_id, r.appointment_id, r.service_record_id, r.stock_inquiry_id,
                      r.provider_job_log_id, r.invited_user_id, r.expires_at, r.business_confirmation_given;
END
$$;

-- appointment -------------------------------------------------------------------
CREATE POLICY party_all ON appointment.appointments FOR ALL
  USING (requester_user_id = core.me() OR requester_organization_id = core.my_org() OR provider_organization_id = core.my_org())
  WITH CHECK (requester_user_id = core.me() OR requester_organization_id = core.my_org() OR provider_organization_id = core.my_org());
DO $apt$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['appointment_time_windows','appointment_participants','pre_visit_reports','appointment_status_history']
  LOOP
    EXECUTE format($p$CREATE POLICY via_appointment ON appointment.%I FOR ALL
      USING (EXISTS (SELECT 1 FROM appointment.appointments a WHERE a.id = appointment_id))
      WITH CHECK (EXISTS (SELECT 1 FROM appointment.appointments a WHERE a.id = appointment_id))$p$, t);
  END LOOP;
END
$apt$;
-- Internal notes are visible to the provider only.
CREATE POLICY provider_all ON appointment.appointment_notes FOR ALL
  USING (EXISTS (SELECT 1 FROM appointment.appointments a WHERE a.id = appointment_id AND a.provider_organization_id = core.my_org()))
  WITH CHECK (EXISTS (SELECT 1 FROM appointment.appointments a WHERE a.id = appointment_id AND a.provider_organization_id = core.my_org()));
CREATE POLICY requester_visible ON appointment.appointment_notes FOR ALL
  USING (note_type = 'customer_visible' AND EXISTS (SELECT 1 FROM appointment.appointments a WHERE a.id = appointment_id))
  WITH CHECK (note_type = 'customer_visible' AND author_side = 'requester'
              AND EXISTS (SELECT 1 FROM appointment.appointments a WHERE a.id = appointment_id));
CREATE POLICY provider_all ON appointment.provider_availability_rules FOR ALL
  USING (provider_organization_id = core.my_org()) WITH CHECK (provider_organization_id = core.my_org());
CREATE POLICY public_read ON appointment.provider_availability_rules FOR SELECT USING (status = 'active');
CREATE POLICY provider_all ON appointment.provider_time_off FOR ALL
  USING (provider_organization_id = core.my_org()) WITH CHECK (provider_organization_id = core.my_org());
CREATE POLICY public_read ON appointment.provider_time_off FOR SELECT USING (status = 'active');

-- fleet --------------------------------------------------------------------------
CREATE POLICY fleet_all ON fleet.fleet_profiles FOR ALL
  USING (organization_id = core.my_org()) WITH CHECK (organization_id = core.my_org());
DO $flt$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fleet_vehicle_assignments','fleet_preferred_partners','fleet_approvals',
                           'fleet_import_batches','fleet_exports']
  LOOP
    EXECUTE format($p$CREATE POLICY fleet_all ON fleet.%I FOR ALL
      USING (fleet_organization_id = core.my_org()) WITH CHECK (fleet_organization_id = core.my_org())$p$, t);
  END LOOP;
END
$flt$;
CREATE POLICY driver_read ON fleet.fleet_vehicle_assignments FOR SELECT USING (driver_user_id = core.me());

-- community ----------------------------------------------------------------------
CREATE POLICY self_all ON community.follows FOR ALL USING (user_id = core.me()) WITH CHECK (user_id = core.me());
CREATE POLICY self_all ON community.favorites FOR ALL USING (user_id = core.me()) WITH CHECK (user_id = core.me());
CREATE POLICY self_all ON community.reactions FOR ALL USING (user_id = core.me()) WITH CHECK (user_id = core.me());
CREATE POLICY org_all ON community.posts FOR ALL
  USING (author_organization_id = core.my_org()) WITH CHECK (author_organization_id = core.my_org());
CREATE POLICY public_read ON community.posts FOR SELECT USING (status = 'published' AND visibility = 'public');
CREATE POLICY author_all ON community.comments FOR ALL USING (author_user_id = core.me()) WITH CHECK (author_user_id = core.me());
CREATE POLICY public_read ON community.comments FOR SELECT USING (status = 'active' AND moderation_status = 'approved');
CREATE POLICY author_all ON community.questions FOR ALL USING (author_user_id = core.me()) WITH CHECK (author_user_id = core.me());
CREATE POLICY public_read ON community.questions FOR SELECT USING (moderation_status = 'approved' AND status <> 'hidden');
CREATE POLICY author_all ON community.answers FOR ALL USING (author_user_id = core.me()) WITH CHECK (author_user_id = core.me());
CREATE POLICY public_read ON community.answers FOR SELECT USING (moderation_status = 'approved' AND status = 'active');

-- media --------------------------------------------------------------------------
CREATE POLICY owner_all ON media.media_assets FOR ALL
  USING ((owner_type = 'user' AND owner_id = core.me()) OR (owner_type = 'organization' AND owner_id = core.my_org()))
  WITH CHECK ((owner_type = 'user' AND owner_id = core.me()) OR (owner_type = 'organization' AND owner_id = core.my_org()));
CREATE POLICY public_read ON media.media_assets FOR SELECT USING (publicly_servable);
CREATE POLICY via_asset_read ON media.media_attachments FOR SELECT
  USING (status = 'active' AND EXISTS (SELECT 1 FROM media.media_assets a WHERE a.id = media_asset_id));
CREATE POLICY owner_all ON media.media_attachments FOR ALL
  USING (EXISTS (SELECT 1 FROM media.media_assets a WHERE a.id = media_asset_id
                  AND ((a.owner_type = 'user' AND a.owner_id = core.me())
                    OR (a.owner_type = 'organization' AND a.owner_id = core.my_org()))))
  WITH CHECK (EXISTS (SELECT 1 FROM media.media_assets a WHERE a.id = media_asset_id
                       AND ((a.owner_type = 'user' AND a.owner_id = core.me())
                         OR (a.owner_type = 'organization' AND a.owner_id = core.my_org()))));

-- notification -------------------------------------------------------------------
CREATE POLICY recipient_all ON notification.notifications FOR ALL
  USING (recipient_user_id = core.me()) WITH CHECK (recipient_user_id = core.me());
CREATE POLICY via_notification ON notification.notification_deliveries FOR SELECT
  USING (EXISTS (SELECT 1 FROM notification.notifications n WHERE n.id = notification_id));
CREATE POLICY self_all ON notification.notification_preferences FOR ALL USING (user_id = core.me()) WITH CHECK (user_id = core.me());
CREATE POLICY self_all ON notification.push_device_tokens FOR ALL USING (user_id = core.me()) WITH CHECK (user_id = core.me());

-- admin --------------------------------------------------------------------------
CREATE POLICY reporter_read ON admin.content_reports FOR SELECT USING (reporter_user_id = core.me());
CREATE POLICY reporter_insert ON admin.content_reports FOR INSERT
  WITH CHECK (reporter_user_id = core.me() AND status = 'open' AND moderation_case_id IS NULL);
CREATE POLICY read_all ON admin.feature_flags FOR SELECT USING (true);

-- analytics ------------------------------------------------------------------------
CREATE POLICY write_any ON analytics.audit_logs FOR INSERT WITH CHECK (true);

-- ai_mcp ---------------------------------------------------------------------------
CREATE POLICY owner_read ON ai_mcp.ai_insights FOR SELECT
  USING (visibility <> 'internal' AND (organization_id = core.my_org() OR (organization_id IS NULL AND owner_user_id = core.me())));
CREATE POLICY owner_update ON ai_mcp.ai_insights FOR UPDATE
  USING (visibility <> 'internal' AND (organization_id = core.my_org() OR (organization_id IS NULL AND owner_user_id = core.me())))
  WITH CHECK (visibility <> 'internal' AND (organization_id = core.my_org() OR (organization_id IS NULL AND owner_user_id = core.me())));
CREATE POLICY owner_rw ON ai_mcp.ai_suggestions FOR SELECT
  USING (organization_id = core.my_org() OR (organization_id IS NULL AND owner_user_id = core.me()));
CREATE POLICY owner_decide ON ai_mcp.ai_suggestions FOR UPDATE
  USING (organization_id = core.my_org() OR (organization_id IS NULL AND owner_user_id = core.me()))
  WITH CHECK (organization_id = core.my_org() OR (organization_id IS NULL AND owner_user_id = core.me()));
CREATE POLICY owner_rw ON ai_mcp.approval_requests FOR SELECT
  USING (organization_id = core.my_org() OR (organization_id IS NULL AND owner_user_id = core.me()));
CREATE POLICY owner_decide ON ai_mcp.approval_requests FOR UPDATE
  USING (organization_id = core.my_org() OR (organization_id IS NULL AND owner_user_id = core.me()))
  WITH CHECK (organization_id = core.my_org() OR (organization_id IS NULL AND owner_user_id = core.me()));
CREATE POLICY actor_insert ON ai_mcp.ai_evaluation_records FOR INSERT WITH CHECK (actor_user_id = core.me());
CREATE POLICY self_all ON ai_mcp.triage_sessions FOR ALL USING (user_id = core.me()) WITH CHECK (user_id = core.me());
CREATE POLICY provider_read ON ai_mcp.skill_heatmap_entries FOR SELECT USING (provider_organization_id = core.my_org());

-- Accepting an organization invitation (40 org.invitation_accept): the invitee
-- cannot see the invitation row before accepting, so the check runs here.
CREATE FUNCTION identity.accept_invitation(p_token_hash bytea)
RETURNS TABLE (membership_id uuid, organization_id uuid, role text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  m   identity.role_memberships%ROWTYPE;
  u   identity.user_accounts%ROWTYPE;
BEGIN
  IF core.me() IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO m FROM identity.role_memberships r WHERE r.invitation_token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR m.status <> 'invited' OR m.invitation_expires_at < now() THEN
    IF FOUND AND m.status = 'active' THEN
      RAISE EXCEPTION 'LINK_USED' USING ERRCODE = 'P0411';
    END IF;
    RAISE EXCEPTION 'LINK_EXPIRED' USING ERRCODE = 'P0410';
  END IF;
  SELECT * INTO u FROM identity.user_accounts a WHERE a.id = core.me();
  IF u.email IS DISTINCT FROM m.invited_email OR u.email_verified_at IS NULL THEN
    RAISE EXCEPTION 'LINK_RECIPIENT_MISMATCH' USING ERRCODE = 'P0403';
  END IF;
  UPDATE identity.role_memberships r
     SET user_id = u.id, status = 'active', joined_at = now(), invitation_token_hash = NULL
   WHERE r.id = m.id;
  PERFORM analytics.write_audit('membership.invitation_accepted', 'role_membership', m.id);
  RETURN QUERY SELECT m.id, m.organization_id, m.role::text;
END
$$;

-- ------------------------------------------------------------- 21.3 grants
REVOKE ALL ON ALL TABLES IN SCHEMA core, identity, organization, billing, taxonomy, vehicle, inventory, discovery,
  trust, appointment, fleet, community, media, notification, admin, analytics, ai_mcp FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA core, identity, organization, billing, taxonomy, vehicle, inventory, discovery,
  trust, appointment, fleet, community, media, notification, admin, analytics, ai_mcp FROM PUBLIC;
REVOKE ALL ON SCHEMA ext FROM PUBLIC;

GRANT USAGE ON SCHEMA core, ext, identity, organization, billing, taxonomy, vehicle, inventory, discovery,
  trust, appointment, fleet, community, media, notification, admin, analytics, ai_mcp TO carpal_app_base;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA core, identity, organization, billing, taxonomy, vehicle, inventory, discovery,
  trust, appointment, fleet, community, media, notification, admin, analytics, ai_mcp TO carpal_app_base;
REVOKE EXECUTE ON FUNCTION core.ensure_monthly_partitions(text, int) FROM carpal_app_base;
GRANT EXECUTE ON FUNCTION core.ensure_monthly_partitions(text, int) TO carpal_worker;

-- Public API and admin API: read and write (no DELETE: soft delete only), always under RLS.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA identity, organization, billing, taxonomy, vehicle, inventory,
  discovery, trust, appointment, fleet, community, media, notification, admin, ai_mcp TO carpal_api, carpal_admin_api;
GRANT SELECT ON core.schema_info TO carpal_app_base;
GRANT INSERT ON core.domain_event_outbox TO carpal_api, carpal_admin_api, carpal_auth, carpal_ai;
GRANT SELECT, INSERT, UPDATE ON core.background_jobs TO carpal_api, carpal_admin_api, carpal_ai;
GRANT INSERT ON analytics.audit_logs TO carpal_api, carpal_auth, carpal_ai;
GRANT SELECT, INSERT ON analytics.audit_logs TO carpal_admin_api;
GRANT DELETE ON community.reactions TO carpal_api;                 -- reactions.delete removes the row
-- The public API never reads pseudonym keys, MCP registry internals or access logs.
REVOKE ALL ON analytics.actor_pseudonyms FROM carpal_api, carpal_admin_api;
REVOKE INSERT, UPDATE ON ai_mcp.mcp_clients, ai_mcp.mcp_access_logs, ai_mcp.embeddings FROM carpal_api;

-- Auth server: identity only, plus audit and outbox.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA identity TO carpal_auth;
GRANT SELECT ON billing.plans TO carpal_auth;

-- Workers: everything, including DELETE for retention and anonymization.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, identity, organization, billing, taxonomy, vehicle,
  inventory, discovery, trust, appointment, fleet, community, media, notification, admin, analytics, ai_mcp TO carpal_worker;

-- MCP gateway and AI orchestration: their own schema; domain data only through module interfaces.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ai_mcp TO carpal_ai;
GRANT SELECT ON admin.feature_flags TO carpal_ai;

-- Append-only and history tables: insert and read only, for every role.
REVOKE UPDATE, DELETE, TRUNCATE ON vehicle.vehicle_status_history, appointment.appointment_status_history,
  admin.moderation_actions, analytics.audit_logs, ai_mcp.mcp_access_logs, ai_mcp.ai_evaluation_records
  FROM carpal_api, carpal_admin_api, carpal_worker, carpal_auth, carpal_ai;

-- Read-only reporting role: public vocabulary and plans only.
GRANT USAGE ON SCHEMA taxonomy, billing, core TO carpal_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA taxonomy TO carpal_readonly;
GRANT SELECT ON billing.plans, billing.entitlements TO carpal_readonly;
GRANT EXECUTE ON FUNCTION core.is_system(), core.is_staff(), core.me(), core.my_org() TO carpal_readonly;

-- Future objects created by migrations get the same defaults.
ALTER DEFAULT PRIVILEGES FOR ROLE carpal_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE carpal_owner GRANT EXECUTE ON FUNCTIONS TO carpal_app_base;
DO $dp$
DECLARE
  s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['identity','organization','billing','taxonomy','vehicle','inventory','discovery','trust',
                           'appointment','fleet','community','media','notification','admin','ai_mcp']
  LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE carpal_owner IN SCHEMA %I GRANT SELECT, INSERT, UPDATE ON TABLES TO carpal_api, carpal_admin_api', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE carpal_owner IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO carpal_worker', s);
  END LOOP;
END
$dp$;

-- Trigram indexes for vendor and admin text search (only when pg_trgm is installed).
DO $trgm$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX inventory_items_sku_trgm ON inventory.inventory_items USING gin (sku ext.gin_trgm_ops);
    CREATE INDEX inventory_items_normalized_trgm ON inventory.inventory_items USING gin (normalized_name ext.gin_trgm_ops);
    CREATE INDEX organizations_name_trgm ON organization.organizations USING gin (name ext.gin_trgm_ops);
    CREATE INDEX user_accounts_name_trgm ON identity.user_accounts USING gin (full_name ext.gin_trgm_ops);
    CREATE INDEX taxonomy_synonyms_term_trgm ON taxonomy.taxonomy_synonyms USING gin (term_normalized ext.gin_trgm_ops);
  END IF;
END
$trgm$;

\echo '== 22. Primary records'

-- =============================================================================
-- 22. Primary records (seeds). Run as carpal_owner, so row-level security does
--     not apply. Values marked "proposed" must be confirmed in WP0/WP3.
-- =============================================================================

-- ------------------------------------------------------------ 22.1 base users
-- The system actor authors system writes and these seeds. It has no
-- authentication method and can never sign in.
INSERT INTO identity.user_accounts (id, created_by, full_name, display_name, email, locale, timezone, status,
                                   email_verified_at, terms_version, privacy_policy_version)
VALUES (core.system_actor_id(), core.system_actor_id(), 'CarPal System', 'CarPal', 'system@carpal.internal',
        'en', 'UTC', 'active', now(), 'system', 'system');

-- Bootstrap platform admin. Starts as pending_verification without any
-- credential: the person completes sign-up through the password-reset link and
-- must register a hardware-bound WebAuthn passkey (staff rule, 40 SEC-AU-9).
INSERT INTO identity.user_accounts (created_by, full_name, display_name, email, locale, timezone, status,
                                   terms_version, privacy_policy_version)
VALUES (core.system_actor_id(), 'CarPal Platform Admin', 'Platform Admin', lower(:'admin_email'),
        'en', 'UTC', 'pending_verification', 'bootstrap', 'bootstrap');

INSERT INTO identity.role_memberships (created_by, user_id, role, status, joined_at)
SELECT core.system_actor_id(), u.id, 'platform_admin', 'active', now()
  FROM identity.user_accounts u WHERE u.email = lower(:'admin_email');

INSERT INTO analytics.audit_logs (actor_type, actor_id, action, entity_type, entity_id, new_state_summary, reason)
SELECT 'system', core.system_actor_id(), 'platform_role.bootstrap_granted', 'user_account', u.id,
       'platform_admin granted at installation', 'Initial installation (42.db_setup.sql)'
  FROM identity.user_accounts u WHERE u.email = lower(:'admin_email');

-- ----------------------------------------------------- 22.2 plans (MVP §5.12)
-- max_users and trial_days are proposed values (WP3).
INSERT INTO billing.plans (created_by, plan_key, audience, name_i18n_key, max_vehicles, max_users, trial_days, is_default_for_audience)
VALUES
  (core.system_actor_id(), 'individual_free', 'individual', 'plans.individual_free', 5,    1,    NULL, true),
  (core.system_actor_id(), 'fleet_20',        'fleet',      'plans.fleet_20',        20,   10,   30,   true),
  (core.system_actor_id(), 'fleet_50',        'fleet',      'plans.fleet_50',        50,   25,   30,   false),
  (core.system_actor_id(), 'fleet_100',       'fleet',      'plans.fleet_100',       100,  50,   30,   false),
  (core.system_actor_id(), 'fleet_custom',    'fleet',      'plans.fleet_custom',    NULL, NULL, NULL, false),
  (core.system_actor_id(), 'provider_basic',  'provider',   'plans.provider_basic',  0,    5,    NULL, true),
  (core.system_actor_id(), 'provider_pro',    'provider',   'plans.provider_pro',    0,    20,   30,   false),
  (core.system_actor_id(), 'vendor_basic',    'vendor',     'plans.vendor_basic',    0,    3,    NULL, true),
  (core.system_actor_id(), 'vendor_pro',      'vendor',     'plans.vendor_pro',      0,    10,   30,   false);

-- Entitlements: every key for every plan (proposed values except max_vehicles,
-- which MVP §5.12 fixes). NULL integer = unlimited; fleet_custom uses overrides.
INSERT INTO billing.entitlements (created_by, plan_id, entitlement_key, value_type, value)
SELECT core.system_actor_id(), p.id, e.key, e.vtype, e.val
  FROM billing.plans p
  JOIN (VALUES
    --  plan_key          key                                  type       value
    ('individual_free', 'max_vehicles',                       'integer', '5'),
    ('individual_free', 'max_fleet_users',                    'integer', '0'),
    ('individual_free', 'ai_tools_enabled',                   'boolean', 'true'),
    ('individual_free', 'ai_fleet_suggestions_enabled',       'boolean', 'false'),
    ('individual_free', 'max_inventory_items',                'integer', '0'),
    ('individual_free', 'inventory_bulk_import_enabled',      'boolean', 'false'),
    ('individual_free', 'appointment_capacity_tools_enabled', 'boolean', 'false'),
    ('individual_free', 'advanced_analytics_enabled',         'boolean', 'false'),
    ('individual_free', 'fleet_reports_enabled',              'boolean', 'false'),
    ('individual_free', 'fleet_approval_workflow_enabled',    'boolean', 'false'),
    ('individual_free', 'featured_placement_eligible',        'boolean', 'false'),
    ('individual_free', 'export_enabled',                     'boolean', 'false'),

    ('fleet_20',  'max_vehicles', 'integer', '20'),   ('fleet_20',  'max_fleet_users', 'integer', '10'),
    ('fleet_50',  'max_vehicles', 'integer', '50'),   ('fleet_50',  'max_fleet_users', 'integer', '25'),
    ('fleet_100', 'max_vehicles', 'integer', '100'),  ('fleet_100', 'max_fleet_users', 'integer', '50'),
    ('fleet_custom', 'max_vehicles', 'integer', NULL), ('fleet_custom', 'max_fleet_users', 'integer', NULL),
    ('fleet_20',  'ai_fleet_suggestions_enabled', 'boolean', 'false'),
    ('fleet_50',  'ai_fleet_suggestions_enabled', 'boolean', 'true'),
    ('fleet_100', 'ai_fleet_suggestions_enabled', 'boolean', 'true'),
    ('fleet_custom', 'ai_fleet_suggestions_enabled', 'boolean', 'true'),
    ('fleet_20',  'advanced_analytics_enabled', 'boolean', 'false'),
    ('fleet_50',  'advanced_analytics_enabled', 'boolean', 'false'),
    ('fleet_100', 'advanced_analytics_enabled', 'boolean', 'true'),
    ('fleet_custom', 'advanced_analytics_enabled', 'boolean', 'true'),

    ('provider_basic', 'max_vehicles', 'integer', '0'),  ('provider_pro', 'max_vehicles', 'integer', '0'),
    ('provider_basic', 'max_fleet_users', 'integer', '0'), ('provider_pro', 'max_fleet_users', 'integer', '0'),
    ('provider_basic', 'appointment_capacity_tools_enabled', 'boolean', 'false'),
    ('provider_pro',   'appointment_capacity_tools_enabled', 'boolean', 'true'),
    ('provider_basic', 'advanced_analytics_enabled', 'boolean', 'false'),
    ('provider_pro',   'advanced_analytics_enabled', 'boolean', 'true'),

    ('vendor_basic', 'max_vehicles', 'integer', '0'),    ('vendor_pro', 'max_vehicles', 'integer', '0'),
    ('vendor_basic', 'max_fleet_users', 'integer', '0'), ('vendor_pro', 'max_fleet_users', 'integer', '0'),
    ('vendor_basic', 'max_inventory_items', 'integer', '500'),
    ('vendor_pro',   'max_inventory_items', 'integer', '20000'),
    ('vendor_basic', 'inventory_bulk_import_enabled', 'boolean', 'false'),
    ('vendor_pro',   'inventory_bulk_import_enabled', 'boolean', 'true'),
    ('vendor_basic', 'advanced_analytics_enabled', 'boolean', 'false'),
    ('vendor_pro',   'advanced_analytics_enabled', 'boolean', 'true')
  ) AS e(plan_key, key, vtype, val) ON e.plan_key = p.plan_key;

-- Remaining keys with plan-family defaults (not listed above).
INSERT INTO billing.entitlements (created_by, plan_id, entitlement_key, value_type, value)
SELECT core.system_actor_id(), p.id, d.key, d.vtype,
       CASE
         WHEN d.key = 'ai_tools_enabled' THEN 'true'
         WHEN d.key IN ('fleet_reports_enabled','fleet_approval_workflow_enabled','export_enabled')
           THEN CASE WHEN p.audience = 'fleet' THEN 'true' ELSE 'false' END
         WHEN d.key = 'max_inventory_items' THEN '0'
         ELSE 'false'
       END
  FROM billing.plans p
  CROSS JOIN (VALUES
    ('ai_tools_enabled','boolean'), ('ai_fleet_suggestions_enabled','boolean'), ('max_inventory_items','integer'),
    ('inventory_bulk_import_enabled','boolean'), ('appointment_capacity_tools_enabled','boolean'),
    ('advanced_analytics_enabled','boolean'), ('fleet_reports_enabled','boolean'),
    ('fleet_approval_workflow_enabled','boolean'), ('featured_placement_eligible','boolean'), ('export_enabled','boolean')
  ) AS d(key, vtype)
 WHERE NOT EXISTS (SELECT 1 FROM billing.entitlements e WHERE e.plan_id = p.id AND e.entitlement_key = d.key);

-- Every user gets Individual Free (52 §6).
INSERT INTO billing.subscriptions (created_by, subscriber_type, subscriber_id, plan_id, status, billing_mode, assigned_by)
SELECT core.system_actor_id(), 'user', u.id, p.id, 'active', 'manual', core.system_actor_id()
  FROM identity.user_accounts u CROSS JOIN billing.plans p
 WHERE p.plan_key = 'individual_free';

-- ------------------------------------------------- 22.3 feature flags (52 §17)
-- AI feature flags are on in dev and off elsewhere until Stage 5; Should-have
-- community features start off; featured placements are off in the MVP.
INSERT INTO admin.feature_flags (created_by, key, description, flag_type, enabled, environment)
SELECT core.system_actor_id(), f.key, f.description, f.flag_type,
       CASE WHEN f.flag_type = 'ai_feature' THEN (:'env' = 'dev') ELSE f.enabled END, :'env'
  FROM (VALUES
    ('ai.automation.kill_switch',        'Stops every AI feature and AI write tool at once',         'kill_switch', false),
    ('ai.triage.enabled',                'Help Me triage',                                            'ai_feature',  true),
    ('ai.review_response.enabled',       'AI review response drafts',                                 'ai_feature',  true),
    ('skill_heatmap.visible',            'Provider skill heatmap',                                    'ai_feature',  true),
    ('vendor.ai_import.enabled',         'AI inventory normalization and fitment suggestions',        'ai_feature',  true),
    ('ai.vehicle_helper.enabled',        'AI vehicle field and maintenance suggestions',              'ai_feature',  true),
    ('ai.service_history.enabled',       'AI service history insights',                               'ai_feature',  true),
    ('ai.profile_helper.enabled',        'AI provider profile helper',                                'ai_feature',  true),
    ('ai.review_insights.enabled',       'AI review themes and insights',                             'ai_feature',  true),
    ('ai.showroom.enabled',              'AI showroom / before-after composer',                       'ai_feature',  true),
    ('ai.appointment.enabled',           'AI appointment suggestions',                                'ai_feature',  true),
    ('ai.inventory_gaps.enabled',        'AI inventory gap suggestions (Should-have)',                'ai_feature',  true),
    ('ai.fleet.enabled',                 'AI fleet suggestions',                                      'ai_feature',  true),
    ('search.semantic.enabled',          'Semantic search enhancer (pgvector)',                       'ai_feature',  true),
    ('map.enabled',                      'Map browsing and pins',                                     'release',     true),
    ('reviews.invitation_email.enabled', 'Review invitations by email (Should-have)',                 'release',     true),
    ('reviews.approval_path.enabled',    'Path 2 approval-based reviews',                             'release',     true),
    ('community.comments.enabled',       'Comments (Should-have)',                                    'release',     false),
    ('community.feed.enabled',           'Provider posts and feed (Should-have)',                     'release',     false),
    ('qna.enabled',                      'Questions and answers (Should-have)',                       'release',     false),
    ('mcp.external_clients.enabled',     'External MCP clients (post-MVP)',                           'release',     false),
    ('featured.enabled',                 'Featured placements — off in the MVP, never on the map',    'release',     false)
  ) AS f(key, description, flag_type, enabled);

-- ------------------------------------------ 22.4 retention policies (proposed)
-- Proposed values; legal review per launch region is required (41 backend plan §10).
INSERT INTO admin.data_retention_policies (created_by, entity_type, applies_to_status, retention_days, action, legal_basis)
VALUES
  (core.system_actor_id(), 'UserAccount',          'deleted',         30,   'anonymize', 'Deletion request (MVP §14)'),
  (core.system_actor_id(), 'VerificationToken',    NULL,              7,    'delete',    'Security tokens'),
  (core.system_actor_id(), 'DataSubjectRequest',   'completed',       1095, 'archive',   'Proof of compliance'),
  (core.system_actor_id(), 'Review',               'removed',         1095, 'archive',   'Removed reviews kept for audit (52 §11)'),
  (core.system_actor_id(), 'MediaAsset',           'removed',         30,   'delete',    'Data minimization'),
  (core.system_actor_id(), 'MediaAsset',           'pending_upload',  1,    'delete',    'Abandoned uploads'),
  (core.system_actor_id(), 'MatchSession',         NULL,              180,  'anonymize', 'Search analytics; query text minimized'),
  (core.system_actor_id(), 'TriageSession',        NULL,              365,  'delete',    'Help Me conversations minimized'),
  (core.system_actor_id(), 'Notification',         NULL,              180,  'delete',    'Operational messages'),
  (core.system_actor_id(), 'NotificationDelivery', NULL,              90,   'delete',    'Delivery tracking'),
  (core.system_actor_id(), 'InventoryImportBatch', NULL,              180,  'delete',    'Operational files'),
  (core.system_actor_id(), 'FleetExport',          NULL,              30,   'delete',    'Export files expire'),
  (core.system_actor_id(), 'BackgroundJob',        NULL,              30,   'delete',    'Operational records'),
  (core.system_actor_id(), 'DomainEventOutbox',    'published',       7,    'delete',    'Relayed events'),
  (core.system_actor_id(), 'McpAccessLog',         NULL,              730,  'delete',    'AI audit (MVP §13)'),
  (core.system_actor_id(), 'AuditLog',             NULL,              2555, 'archive',   'Administrative audit trail'),
  (core.system_actor_id(), 'AnalyticsEvent',       NULL,              730,  'delete',    'Pseudonymous product analytics');

-- ------------------------------------------------- 22.5 MCP clients (53 §19)
-- Credentials are secret-store keys, never secrets. Tool keys carry a version.
INSERT INTO ai_mcp.mcp_clients (created_by, name, client_type, allowed_scopes, allowed_resources, allowed_tools,
                                rate_limit_policy, environment, credential_reference)
SELECT core.system_actor_id(), c.name, c.client_type, c.scopes, c.resources,
       ARRAY(SELECT t || '@1' FROM unnest(c.tools) t), c.rate_policy, :'env', 'secret://mcp/' || c.name
  FROM (VALUES
    ('consumer_assistant', 'internal_assistant',
     ARRAY['read:user.profile_summary:self','read:vehicle.summary:owned','read:vehicle.service_history:owned',
           'read:provider.profile:public','draft:appointment.request:user_initiated'],
     ARRAY['res:user.profile_summary','res:user.preferences','res:user.vehicle_list','res:user.consent_status',
           'res:vehicle.summary','res:vehicle.details','res:vehicle.service_history','res:vehicle.active_issues',
           'res:vehicle.maintenance_plan','res:vehicle.consent_status','res:taxonomy.symptoms','res:taxonomy.service_systems',
           'res:taxonomy.service_tasks','res:taxonomy.part_categories','res:geo.location_summary','res:geo.nearby_providers',
           'res:geo.nearby_vendors','res:geo.map_pins','res:provider.profile_summary','res:provider.capabilities',
           'res:provider.review_summary','res:match.provider_candidates','res:match.explanation','res:search.providers',
           'res:search.vendors','res:search.parts','res:search.showcases','res:search.qna'],
     ARRAY['tool:search.interpret_query','tool:search.providers','tool:search.vendors','tool:search.places','tool:search.parts',
           'tool:triage.start','tool:triage.ask_question','tool:triage.classify_symptom','tool:triage.create_summary',
           'tool:triage.safety_check','tool:match.provider_to_need','tool:match.explain','tool:match.suggest_alternatives',
           'tool:vehicle.extract_fields','tool:vehicle.suggest_maintenance','tool:vehicle.summarize_history',
           'tool:vehicle.create_service_record_draft','tool:appointment.check_availability','tool:appointment.suggest_duration',
           'tool:appointment.draft_request','tool:appointment.create_pre_visit_report','tool:qna.classify_question',
           'tool:qna.suggest_provider'],
     'mcp.user'),
    ('provider_assistant', 'internal_assistant',
     ARRAY['read:provider.analytics:self_organization','draft:review.response:self_organization',
           'approve:profile.suggestion:provider_admin'],
     ARRAY['res:provider.profile_summary','res:provider.profile_details','res:provider.locations','res:provider.services',
           'res:provider.capabilities','res:provider.capability_evidence','res:provider.skill_heatmap',
           'res:provider.portfolio_summary','res:provider.availability','res:provider.review_summary',
           'res:provider.review_themes','res:provider.analytics_summary','res:provider.profile_gaps','res:review.detail',
           'res:review.list','res:appointment.summary','res:appointment.details','res:appointment.pre_visit_report',
           'res:taxonomy.service_systems','res:taxonomy.service_tasks','res:taxonomy.vehicle.brands','res:taxonomy.vehicle.models'],
     ARRAY['tool:profile.suggest_capabilities','tool:profile.suggest_missing_models','tool:profile.generate_summary',
           'tool:skill.generate_heatmap','tool:skill.suggest_focus','tool:portfolio.group_media','tool:portfolio.generate_caption',
           'tool:portfolio.suggest_tags','tool:portfolio.redaction_check','tool:review.classify','tool:review.summarize',
           'tool:review.draft_response','tool:review.request_review','tool:appointment.suggest_response',
           'tool:appointment.suggest_duration','tool:community.draft_provider_answer'],
     'mcp.org'),
    ('vendor_assistant', 'internal_assistant',
     ARRAY['read:inventory.items:vendor_self','draft:inquiry.response:vendor_self'],
     ARRAY['res:vendor.profile_summary','res:vendor.profile_details','res:vendor.inventory_list','res:inventory.item_summary',
           'res:inventory.item_details','res:inventory.fitment','res:inventory.quality_score','res:vendor.inquiries_summary',
           'res:vendor.catalog_gaps','res:taxonomy.part_categories','res:taxonomy.vehicle.brands','res:taxonomy.vehicle.models',
           'res:taxonomy.vehicle.series'],
     ARRAY['tool:inventory.normalize_item','tool:inventory.classify_category','tool:inventory.suggest_fitment',
           'tool:inventory.detect_duplicates','tool:inventory.validate_import','tool:inventory.suggest_catalog_gaps',
           'tool:inquiry.draft_response','tool:review.draft_response','tool:review.summarize'],
     'mcp.org'),
    ('fleet_assistant', 'internal_assistant',
     ARRAY['read:fleet.vehicles:self_organization','read:fleet.costs:self_organization','draft:fleet.approval:fleet_manager'],
     ARRAY['res:fleet.organization_summary','res:fleet.vehicle_list','res:fleet.vehicle_summary','res:fleet.driver_list',
           'res:fleet.maintenance_board','res:fleet.approvals','res:fleet.cost_summary','res:fleet.preferred_providers',
           'res:vehicle.summary','res:vehicle.service_history','res:vehicle.active_issues','res:provider.profile_summary',
           'res:provider.capabilities','res:match.provider_candidates'],
     ARRAY['tool:fleet.summarize_vehicle_health','tool:fleet.suggest_provider','tool:fleet.draft_approval_recommendation',
           'tool:fleet.create_issue_report','tool:fleet.generate_cost_report','tool:match.provider_to_need','tool:match.explain',
           'tool:triage.safety_check','tool:appointment.draft_request'],
     'mcp.org'),
    ('matching_engine', 'matching_engine',
     ARRAY['read:provider.profile:public','read:vehicle.summary:consented'],
     ARRAY['res:provider.profile_summary','res:provider.capabilities','res:provider.review_summary','res:provider.availability',
           'res:trust.badges','res:geo.nearby_providers','res:geo.nearby_vendors','res:geo.map_pins','res:vehicle.summary',
           'res:vehicle.active_issues','res:match.provider_candidates','res:search.providers','res:search.vendors','res:search.parts'],
     ARRAY['tool:search.interpret_query','tool:search.providers','tool:search.vendors','tool:search.places','tool:search.parts',
           'tool:match.provider_to_need','tool:match.explain','tool:match.suggest_alternatives','tool:triage.safety_check'],
     'mcp.system'),
    ('moderation_assistant', 'moderation_assistant',
     ARRAY['read:moderation.queue:staff','read:review.approval_queue:staff_redacted'],
     ARRAY['res:moderation.queue','res:moderation.case','res:review.detail','res:review.verification','res:review.approval_queue',
           'res:trust.signals','res:post.details','res:qna.question','res:qna.answers','res:community.engagement'],
     ARRAY['tool:moderation.classify_content','tool:moderation.prioritize_queue','tool:moderation.suggest_action',
           'tool:review.flag_risk','tool:review.classify','tool:fraud.detect_review_pattern','tool:community.moderate_content',
           'tool:portfolio.redaction_check'],
     'mcp.staff'),
    ('admin_copilot', 'internal_assistant',
     ARRAY['read:audit.log:staff','read:mcp.client_registry:staff'],
     ARRAY['res:audit.log','res:mcp.client_registry','res:feature.flags','res:plans.entitlements','res:ai.evaluation_summary',
           'res:ai.policy','res:moderation.queue','res:taxonomy.synonyms'],
     ARRAY['tool:taxonomy.suggest_synonym','tool:moderation.prioritize_queue'],
     'mcp.staff'),
    ('ai_pipelines', 'analytics_engine',
     ARRAY['read:review.detail:system','read:inventory.items:vendor_scoped','read:provider.analytics:consented'],
     ARRAY['res:review.detail','res:review.list','res:provider.capabilities','res:provider.capability_evidence',
           'res:inventory.item_details','res:inventory.fitment','res:vehicle.summary','res:vehicle.service_history',
           'res:taxonomy.synonyms','res:taxonomy.symptoms','res:taxonomy.service_systems'],
     ARRAY['tool:review.classify','tool:review.flag_risk','tool:fraud.detect_review_pattern','tool:skill.generate_heatmap',
           'tool:inventory.normalize_item','tool:inventory.suggest_fitment','tool:inventory.detect_duplicates',
           'tool:vehicle.suggest_maintenance','tool:vehicle.summarize_history','tool:search.interpret_query',
           'tool:taxonomy.suggest_synonym','tool:appointment.create_pre_visit_report','tool:qna.classify_question'],
     'mcp.pipeline')
  ) AS c(name, client_type, scopes, resources, tools, rate_policy);

-- --------------------------------------------- 22.6 taxonomy catalog (WP4)
-- Generated from 44.taxonomy catalog.json (catalog 1.0.0). Do not edit by hand:
-- change the catalog and regenerate this section. Nodes are inserted parents first;
-- parents, synonyms and mappings are resolved by (type, slug). The counts are
-- checked at the end so a missing parent or a typo stops the setup.

-- Fuel types
INSERT INTO taxonomy.taxonomy_nodes (created_by, type, name_translations, slug, regions, attributes, sort_order)
SELECT core.system_actor_id(), 'fuel_type', jsonb_build_object('en', v.en, 'fa', v.fa), v.slug, v.regions::core.country[], v.attrs::jsonb, v.sort
  FROM (VALUES
    ('petrol', 'Petrol', 'بنزین', '{}', '{"powertrain": "petrol"}', 1),
    ('diesel', 'Diesel', 'دیزل', '{}', '{"powertrain": "diesel"}', 2),
    ('hybrid', 'Hybrid', 'هیبرید', '{}', '{"powertrain": "hybrid"}', 3),
    ('plug-in-hybrid', 'Plug-in hybrid', 'هیبرید شارژی', '{}', '{"powertrain": "plug_in_hybrid"}', 4),
    ('electric', 'Electric', 'برقی', '{}', '{"powertrain": "electric"}', 5),
    ('mild-hybrid', 'Mild hybrid', 'هیبرید سبک', '{}', '{"powertrain": "hybrid"}', 6),
    ('petrol-cng', 'Petrol and CNG (bi-fuel)', 'دوگانه‌سوز (بنزین و CNG)', '{}', '{"powertrain": "petrol"}', 7),
    ('petrol-lpg', 'Petrol and LPG (bi-fuel)', 'دوگانه‌سوز (بنزین و LPG)', '{}', '{"powertrain": "petrol"}', 8)
  ) AS v(slug, en, fa, regions, attrs, sort);

-- Engine types (shared engine families, no parent)
INSERT INTO taxonomy.taxonomy_nodes (created_by, type, name_translations, slug, regions, attributes, sort_order)
SELECT core.system_actor_id(), 'engine_type', jsonb_build_object('en', v.en, 'fa', v.fa), v.slug, v.regions::core.country[], v.attrs::jsonb, v.sort
  FROM (VALUES
    ('psa-tu3', 'TU3 1.4', 'TU3 (1.4 لیتری)', '{}', '{"engine_code": "TU3", "displacement_cc": 1360}', 1),
    ('psa-tu5', 'TU5 1.6', 'TU5 (1.6 لیتری)', '{}', '{"engine_code": "TU5", "displacement_cc": 1587}', 2),
    ('psa-xu7', 'XU7 1.8', 'XU7 (1.8 لیتری)', '{}', '{"engine_code": "XU7", "displacement_cc": 1761}', 3),
    ('ikco-ef7', 'EF7 1.65 (national engine)', 'EF7 (موتور ملی 1.65 لیتری)', '{IR}', '{"engine_code": "EF7", "displacement_cc": 1645}', 4),
    ('ikco-ec5', 'EC5 1.6', 'EC5 (1.6 لیتری)', '{IR}', '{"engine_code": "EC5"}', 5),
    ('saipa-m15', 'M15 1.5', 'M15 (1.5 لیتری)', '{IR}', '{"engine_code": "M15"}', 6),
    ('kia-b3', 'B3 1.3 (Pride)', 'B3 (1.3 لیتری، پراید)', '{}', '{"engine_code": "B3", "displacement_cc": 1323}', 7),
    ('hyundai-g4fc', 'Gamma 1.6 (G4FC)', 'گاما 1.6 (G4FC)', '{}', '{"engine_code": "G4FC", "displacement_cc": 1591}', 8),
    ('toyota-1zr-fe', '1ZR-FE 1.6', '1ZR-FE (1.6 لیتری)', '{}', '{"engine_code": "1ZR-FE", "displacement_cc": 1598}', 9),
    ('toyota-2zr-fe', '2ZR-FE 1.8', '2ZR-FE (1.8 لیتری)', '{}', '{"engine_code": "2ZR-FE", "displacement_cc": 1798}', 10),
    ('toyota-2ar-fe', '2AR-FE 2.5', '2AR-FE (2.5 لیتری)', '{}', '{"engine_code": "2AR-FE", "displacement_cc": 2494}', 11),
    ('bmw-n52', 'N52 3.0', 'N52 (3.0 لیتری)', '{}', '{"engine_code": "N52", "displacement_cc": 2996}', 12),
    ('bmw-n20', 'N20 2.0 turbo', 'N20 (2.0 لیتری توربو)', '{}', '{"engine_code": "N20", "displacement_cc": 1997}', 13),
    ('bmw-b48', 'B48 2.0 turbo', 'B48 (2.0 لیتری توربو)', '{}', '{"engine_code": "B48", "displacement_cc": 1998}', 14),
    ('bmw-s55', 'S55 3.0 twin-turbo (M)', 'S55 (3.0 لیتری توئین‌توربو، M)', '{}', '{"engine_code": "S55", "displacement_cc": 2979, "performance_variant": true}', 15),
    ('mercedes-m274', 'M274 2.0 turbo', 'M274 (2.0 لیتری توربو)', '{}', '{"engine_code": "M274", "displacement_cc": 1991}', 16),
    ('vw-ea888', 'EA888 turbo petrol', 'EA888 (بنزینی توربو)', '{}', '{"engine_code": "EA888"}', 17),
    ('vw-ea211', 'EA211 petrol', 'EA211 (بنزینی)', '{}', '{"engine_code": "EA211"}', 18)
  ) AS v(slug, en, fa, regions, attrs, sort);

-- Vehicle brands
INSERT INTO taxonomy.taxonomy_nodes (created_by, type, name_translations, slug, regions, attributes, sort_order)
SELECT core.system_actor_id(), 'vehicle_brand', jsonb_build_object('en', v.en, 'fa', v.fa), v.slug, v.regions::core.country[], v.attrs::jsonb, v.sort
  FROM (VALUES
    ('iran-khodro', 'Iran Khodro (IKCO)', 'ایران خودرو', '{IR}', NULL, 1),
    ('saipa', 'Saipa', 'سایپا', '{IR}', NULL, 2),
    ('zamyad', 'Zamyad', 'زامیاد', '{IR}', NULL, 3),
    ('mvm', 'MVM', 'ام‌وی‌ام', '{IR}', NULL, 4),
    ('kmc', 'KMC', 'کی‌ام‌سی', '{IR}', NULL, 5),
    ('peugeot', 'Peugeot', 'پژو', '{}', NULL, 6),
    ('renault', 'Renault', 'رنو', '{}', NULL, 7),
    ('kia', 'Kia', 'کیا', '{}', NULL, 8),
    ('hyundai', 'Hyundai', 'هیوندای', '{}', NULL, 9),
    ('toyota', 'Toyota', 'تویوتا', '{}', NULL, 10),
    ('nissan', 'Nissan', 'نیسان', '{}', NULL, 11),
    ('mitsubishi', 'Mitsubishi', 'میتسوبیشی', '{}', NULL, 12),
    ('suzuki', 'Suzuki', 'سوزوکی', '{}', NULL, 13),
    ('mazda', 'Mazda', 'مزدا', '{}', NULL, 14),
    ('chery', 'Chery', 'چری', '{}', NULL, 15),
    ('jac', 'JAC', 'جک', '{}', NULL, 16),
    ('dongfeng', 'Dongfeng', 'دانگ‌فنگ', '{}', NULL, 17),
    ('brilliance', 'Brilliance', 'برلیانس', '{}', NULL, 18),
    ('lifan', 'Lifan', 'لیفان', '{}', NULL, 19),
    ('bmw', 'BMW', 'بی‌ام‌و', '{}', NULL, 20),
    ('mercedes-benz', 'Mercedes-Benz', 'مرسدس بنز', '{}', NULL, 21),
    ('volkswagen', 'Volkswagen', 'فولکس‌واگن', '{}', NULL, 22),
    ('ford', 'Ford', 'فورد', '{}', NULL, 23),
    ('tesla', 'Tesla', 'تسلا', '{}', NULL, 24),
    ('honda', 'Honda', 'هوندا', '{}', NULL, 25),
    ('audi', 'Audi', 'آئودی', '{}', NULL, 26)
  ) AS v(slug, en, fa, regions, attrs, sort);

-- Vehicle models
INSERT INTO taxonomy.taxonomy_nodes (created_by, type, parent_id, name_translations, slug, regions, attributes, sort_order)
SELECT core.system_actor_id(), 'vehicle_model', p.id, jsonb_build_object('en', v.en, 'fa', v.fa), v.slug, v.regions::core.country[], v.attrs::jsonb, v.sort
  FROM (VALUES
    ('iran-khodro', 'iran-khodro-samand', 'Samand', 'سمند', '{IR}', NULL, 1),
    ('iran-khodro', 'iran-khodro-soren', 'Soren', 'سورن', '{IR}', NULL, 2),
    ('iran-khodro', 'iran-khodro-dena', 'Dena', 'دنا', '{IR}', NULL, 3),
    ('iran-khodro', 'iran-khodro-runna', 'Runna', 'رانا', '{IR}', NULL, 4),
    ('iran-khodro', 'iran-khodro-tara', 'Tara', 'تارا', '{IR}', NULL, 5),
    ('iran-khodro', 'iran-khodro-paykan', 'Paykan', 'پیکان', '{IR}', NULL, 6),
    ('iran-khodro', 'iran-khodro-arisun', 'Arisun pickup', 'وانت آریسان', '{IR}', NULL, 7),
    ('saipa', 'saipa-pride', 'Pride', 'پراید', '{IR}', NULL, 1),
    ('saipa', 'saipa-tiba', 'Tiba', 'تیبا', '{IR}', NULL, 2),
    ('saipa', 'saipa-saina', 'Saina', 'ساینا', '{IR}', NULL, 3),
    ('saipa', 'saipa-quick', 'Quick', 'کوییک', '{IR}', NULL, 4),
    ('saipa', 'saipa-shahin', 'Shahin', 'شاهین', '{IR}', NULL, 5),
    ('zamyad', 'zamyad-z24', 'Z24 pickup', 'وانت زامیاد Z24', '{IR}', NULL, 1),
    ('mvm', 'mvm-110', 'MVM 110', 'ام‌وی‌ام 110', '{IR}', NULL, 1),
    ('mvm', 'mvm-315', 'MVM 315', 'ام‌وی‌ام 315', '{IR}', NULL, 2),
    ('mvm', 'mvm-x22', 'MVM X22', 'ام‌وی‌ام X22', '{IR}', NULL, 3),
    ('mvm', 'mvm-x33', 'MVM X33', 'ام‌وی‌ام X33', '{IR}', NULL, 4),
    ('kmc', 'kmc-j7', 'KMC J7', 'کی‌ام‌سی J7', '{IR}', NULL, 1),
    ('kmc', 'kmc-t8', 'KMC T8 pickup', 'پیکاپ کی‌ام‌سی T8', '{IR}', NULL, 2),
    ('peugeot', 'peugeot-206', '206', '206', '{}', NULL, 1),
    ('peugeot', 'peugeot-207', '207', '207', '{}', NULL, 2),
    ('peugeot', 'peugeot-405', '405', '405', '{}', NULL, 3),
    ('peugeot', 'peugeot-pars', 'Pars (Persia)', 'پارس', '{IR}', NULL, 4),
    ('peugeot', 'peugeot-2008', '2008', '2008', '{}', NULL, 5),
    ('renault', 'renault-logan', 'Logan (Tondar 90)', 'تندر 90 (لوگان)', '{}', NULL, 1),
    ('renault', 'renault-sandero', 'Sandero', 'ساندرو', '{}', NULL, 2),
    ('renault', 'renault-megane', 'Megane', 'مگان', '{}', NULL, 3),
    ('renault', 'renault-duster', 'Duster', 'داستر', '{}', NULL, 4),
    ('kia', 'kia-rio', 'Rio', 'ریو', '{}', NULL, 1),
    ('kia', 'kia-cerato', 'Cerato', 'سراتو', '{}', NULL, 2),
    ('kia', 'kia-optima', 'Optima', 'اپتیما', '{}', NULL, 3),
    ('kia', 'kia-sportage', 'Sportage', 'اسپورتیج', '{}', NULL, 4),
    ('kia', 'kia-sorento', 'Sorento', 'سورنتو', '{}', NULL, 5),
    ('hyundai', 'hyundai-accent', 'Accent', 'اکسنت', '{}', NULL, 1),
    ('hyundai', 'hyundai-elantra', 'Elantra', 'النترا', '{}', NULL, 2),
    ('hyundai', 'hyundai-sonata', 'Sonata', 'سوناتا', '{}', NULL, 3),
    ('hyundai', 'hyundai-azera', 'Azera (Grandeur)', 'آزرا (گرنجور)', '{}', NULL, 4),
    ('hyundai', 'hyundai-tucson', 'Tucson', 'توسان', '{}', NULL, 5),
    ('hyundai', 'hyundai-santa-fe', 'Santa Fe', 'سانتافه', '{}', NULL, 6),
    ('toyota', 'toyota-corolla', 'Corolla', 'کرولا', '{}', NULL, 1),
    ('toyota', 'toyota-camry', 'Camry', 'کمری', '{}', NULL, 2),
    ('toyota', 'toyota-yaris', 'Yaris', 'یاریس', '{}', NULL, 3),
    ('toyota', 'toyota-rav4', 'RAV4', 'راو4', '{}', NULL, 4),
    ('toyota', 'toyota-prius', 'Prius', 'پریوس', '{}', NULL, 5),
    ('toyota', 'toyota-land-cruiser', 'Land Cruiser', 'لندکروز', '{}', NULL, 6),
    ('toyota', 'toyota-hilux', 'Hilux', 'هایلوکس', '{}', NULL, 7),
    ('nissan', 'nissan-maxima', 'Maxima', 'ماکسیما', '{}', NULL, 1),
    ('nissan', 'nissan-qashqai', 'Qashqai', 'قشقایی', '{}', NULL, 2),
    ('nissan', 'nissan-x-trail', 'X-Trail', 'ایکس‌تریل', '{}', NULL, 3),
    ('nissan', 'nissan-patrol', 'Patrol', 'پاترول', '{}', NULL, 4),
    ('mitsubishi', 'mitsubishi-pajero', 'Pajero', 'پاجرو', '{}', NULL, 1),
    ('mitsubishi', 'mitsubishi-lancer', 'Lancer', 'لنسر', '{}', NULL, 2),
    ('mitsubishi', 'mitsubishi-asx', 'ASX', 'ASX', '{}', NULL, 3),
    ('suzuki', 'suzuki-grand-vitara', 'Grand Vitara', 'گرند ویتارا', '{}', NULL, 1),
    ('mazda', 'mazda-3', 'Mazda3', 'مزدا 3', '{}', NULL, 1),
    ('mazda', 'mazda-cx-5', 'CX-5', 'CX-5', '{}', NULL, 2),
    ('chery', 'chery-tiggo-5', 'Tiggo 5', 'تیگو 5', '{}', NULL, 1),
    ('chery', 'chery-tiggo-7', 'Tiggo 7', 'تیگو 7', '{}', NULL, 2),
    ('chery', 'chery-tiggo-8', 'Tiggo 8', 'تیگو 8', '{}', NULL, 3),
    ('chery', 'chery-arrizo-5', 'Arrizo 5', 'آریزو 5', '{}', NULL, 4),
    ('jac', 'jac-j5', 'J5', 'J5', '{}', NULL, 1),
    ('jac', 'jac-s5', 'S5', 'S5', '{}', NULL, 2),
    ('dongfeng', 'dongfeng-h30-cross', 'H30 Cross', 'H30 کراس', '{}', NULL, 1),
    ('dongfeng', 'dongfeng-ax7', 'AX7', 'AX7', '{}', NULL, 2),
    ('brilliance', 'brilliance-h320', 'H320', 'H320', '{}', NULL, 1),
    ('brilliance', 'brilliance-h330', 'H330', 'H330', '{}', NULL, 2),
    ('brilliance', 'brilliance-v5', 'V5', 'V5', '{}', NULL, 3),
    ('lifan', 'lifan-x60', 'X60', 'X60', '{}', NULL, 1),
    ('lifan', 'lifan-620', '620', '620', '{}', NULL, 2),
    ('bmw', 'bmw-3-series', '3 Series', 'سری 3', '{}', NULL, 1),
    ('bmw', 'bmw-5-series', '5 Series', 'سری 5', '{}', NULL, 2),
    ('bmw', 'bmw-x5', 'X5', 'X5', '{}', NULL, 3),
    ('mercedes-benz', 'mercedes-benz-c-class', 'C-Class', 'کلاس C', '{}', NULL, 1),
    ('mercedes-benz', 'mercedes-benz-e-class', 'E-Class', 'کلاس E', '{}', NULL, 2),
    ('mercedes-benz', 'mercedes-benz-sprinter', 'Sprinter', 'اسپرینتر', '{}', NULL, 3),
    ('volkswagen', 'volkswagen-golf', 'Golf', 'گلف', '{}', NULL, 1),
    ('volkswagen', 'volkswagen-passat', 'Passat', 'پاسات', '{}', NULL, 2),
    ('volkswagen', 'volkswagen-transporter', 'Transporter', 'ترانسپورتر', '{}', NULL, 3),
    ('ford', 'ford-transit', 'Transit', 'ترانزیت', '{}', NULL, 1),
    ('ford', 'ford-focus', 'Focus', 'فوکوس', '{}', NULL, 2),
    ('ford', 'ford-f-150', 'F-150', 'F-150', '{}', NULL, 3),
    ('tesla', 'tesla-model-3', 'Model 3', 'مدل 3', '{}', NULL, 1),
    ('tesla', 'tesla-model-y', 'Model Y', 'مدل Y', '{}', NULL, 2),
    ('tesla', 'tesla-model-s', 'Model S', 'مدل S', '{}', NULL, 3),
    ('honda', 'honda-civic', 'Civic', 'سیویک', '{}', NULL, 1),
    ('honda', 'honda-accord', 'Accord', 'آکورد', '{}', NULL, 2),
    ('honda', 'honda-cr-v', 'CR-V', 'CR-V', '{}', NULL, 3),
    ('audi', 'audi-a4', 'A4', 'A4', '{}', NULL, 1),
    ('audi', 'audi-a6', 'A6', 'A6', '{}', NULL, 2),
    ('audi', 'audi-q5', 'Q5', 'Q5', '{}', NULL, 3)
  ) AS v(parent_slug, slug, en, fa, regions, attrs, sort)
  JOIN taxonomy.taxonomy_nodes p ON p.type = 'vehicle_brand' AND p.slug = v.parent_slug;

-- Vehicle series / generations
INSERT INTO taxonomy.taxonomy_nodes (created_by, type, parent_id, name_translations, slug, regions, attributes, sort_order)
SELECT core.system_actor_id(), 'vehicle_series', p.id, jsonb_build_object('en', v.en, 'fa', v.fa), v.slug, v.regions::core.country[], v.attrs::jsonb, v.sort
  FROM (VALUES
    ('iran-khodro-dena', 'iran-khodro-dena-base', 'Dena', 'دنا معمولی', '{IR}', NULL, 1),
    ('iran-khodro-dena', 'iran-khodro-dena-plus', 'Dena Plus', 'دنا پلاس', '{IR}', NULL, 2),
    ('iran-khodro-dena', 'iran-khodro-dena-plus-turbo', 'Dena Plus Turbo', 'دنا پلاس توربو', '{IR}', NULL, 3),
    ('saipa-pride', 'saipa-pride-111', 'Pride 111', 'پراید 111', '{IR}', NULL, 1),
    ('saipa-pride', 'saipa-pride-131', 'Pride 131', 'پراید 131', '{IR}', NULL, 2),
    ('saipa-pride', 'saipa-pride-132', 'Pride 132', 'پراید 132', '{IR}', NULL, 3),
    ('saipa-pride', 'saipa-pride-141', 'Pride 141', 'پراید 141', '{IR}', NULL, 4),
    ('saipa-pride', 'saipa-pride-151', 'Pride 151 pickup', 'وانت پراید 151', '{IR}', NULL, 5),
    ('saipa-tiba', 'saipa-tiba-sedan', 'Tiba sedan', 'تیبا صندوق‌دار', '{IR}', NULL, 1),
    ('saipa-tiba', 'saipa-tiba-2', 'Tiba 2 hatchback', 'تیبا 2 هاچ‌بک', '{IR}', NULL, 2),
    ('peugeot-206', 'peugeot-206-hatchback', '206 hatchback', '206 هاچ‌بک', '{}', '{"production_start_year": 1998}', 1),
    ('peugeot-206', 'peugeot-206-sd', '206 SD sedan', '206 صندوق‌دار (SD)', '{IR}', NULL, 2),
    ('kia-cerato', 'kia-cerato-td', 'TD', 'TD', '{}', '{"production_start_year": 2008, "production_end_year": 2013}', 1),
    ('kia-cerato', 'kia-cerato-yd', 'YD', 'YD', '{}', '{"production_start_year": 2012, "production_end_year": 2018}', 2),
    ('kia-cerato', 'kia-cerato-bd', 'BD', 'BD', '{}', '{"production_start_year": 2018}', 3),
    ('hyundai-elantra', 'hyundai-elantra-md', 'MD', 'MD', '{}', '{"production_start_year": 2010, "production_end_year": 2015}', 1),
    ('hyundai-elantra', 'hyundai-elantra-ad', 'AD', 'AD', '{}', '{"production_start_year": 2015, "production_end_year": 2020}', 2),
    ('hyundai-elantra', 'hyundai-elantra-cn7', 'CN7', 'CN7', '{}', '{"production_start_year": 2020}', 3),
    ('toyota-corolla', 'toyota-corolla-e140', 'E140/E150', 'E140/E150', '{}', '{"production_start_year": 2006, "production_end_year": 2013}', 1),
    ('toyota-corolla', 'toyota-corolla-e170', 'E170', 'E170', '{}', '{"production_start_year": 2013, "production_end_year": 2019}', 2),
    ('toyota-corolla', 'toyota-corolla-e210', 'E210 (TNGA)', 'E210 (TNGA)', '{}', '{"production_start_year": 2018}', 3),
    ('bmw-3-series', 'bmw-3-series-e46', 'E46', 'E46', '{}', '{"production_start_year": 1997, "production_end_year": 2006}', 1),
    ('bmw-3-series', 'bmw-3-series-e90', 'E90', 'E90', '{}', '{"production_start_year": 2005, "production_end_year": 2012}', 2),
    ('bmw-3-series', 'bmw-3-series-f30', 'F30', 'F30', '{}', '{"production_start_year": 2011, "production_end_year": 2019}', 3),
    ('bmw-3-series', 'bmw-3-series-g20', 'G20', 'G20', '{}', '{"production_start_year": 2018}', 4),
    ('bmw-5-series', 'bmw-5-series-e60', 'E60', 'E60', '{}', '{"production_start_year": 2003, "production_end_year": 2010}', 1),
    ('bmw-5-series', 'bmw-5-series-f10', 'F10', 'F10', '{}', '{"production_start_year": 2009, "production_end_year": 2017}', 2),
    ('bmw-5-series', 'bmw-5-series-g30', 'G30', 'G30', '{}', '{"production_start_year": 2016, "production_end_year": 2023}', 3),
    ('bmw-x5', 'bmw-x5-e70', 'E70', 'E70', '{}', '{"production_start_year": 2006, "production_end_year": 2013}', 1),
    ('bmw-x5', 'bmw-x5-f15', 'F15', 'F15', '{}', '{"production_start_year": 2013, "production_end_year": 2018}', 2),
    ('bmw-x5', 'bmw-x5-g05', 'G05', 'G05', '{}', '{"production_start_year": 2018}', 3),
    ('mercedes-benz-c-class', 'mercedes-benz-c-class-w204', 'W204', 'W204', '{}', '{"production_start_year": 2007, "production_end_year": 2014}', 1),
    ('mercedes-benz-c-class', 'mercedes-benz-c-class-w205', 'W205', 'W205', '{}', '{"production_start_year": 2014, "production_end_year": 2021}', 2),
    ('mercedes-benz-c-class', 'mercedes-benz-c-class-w206', 'W206', 'W206', '{}', '{"production_start_year": 2021}', 3),
    ('mercedes-benz-e-class', 'mercedes-benz-e-class-w212', 'W212', 'W212', '{}', '{"production_start_year": 2009, "production_end_year": 2016}', 1),
    ('mercedes-benz-e-class', 'mercedes-benz-e-class-w213', 'W213', 'W213', '{}', '{"production_start_year": 2016, "production_end_year": 2023}', 2),
    ('volkswagen-golf', 'volkswagen-golf-mk6', 'Mk6', 'Mk6', '{}', '{"production_start_year": 2008, "production_end_year": 2012}', 1),
    ('volkswagen-golf', 'volkswagen-golf-mk7', 'Mk7', 'Mk7', '{}', '{"production_start_year": 2012, "production_end_year": 2020}', 2),
    ('volkswagen-golf', 'volkswagen-golf-mk8', 'Mk8', 'Mk8', '{}', '{"production_start_year": 2019}', 3)
  ) AS v(parent_slug, slug, en, fa, regions, attrs, sort)
  JOIN taxonomy.taxonomy_nodes p ON p.type = 'vehicle_model' AND p.slug = v.parent_slug;

-- Service systems
INSERT INTO taxonomy.taxonomy_nodes (created_by, type, name_translations, description_translations, slug, regions, attributes, sort_order)
SELECT core.system_actor_id(), 'service_system', jsonb_build_object('en', v.en, 'fa', v.fa), jsonb_build_object('en', v.den, 'fa', v.dfa), v.slug, v.regions::core.country[], v.attrs::jsonb, v.sort
  FROM (VALUES
    ('engine', 'Engine', 'موتور', 'Engine mechanics: timing, head, gaskets, mounts, belts, turbo, ignition and rebuilds.', 'مکانیک موتور: تایم، سرسیلندر، واشرها، دسته موتور، تسمه‌ها، توربو، جرقه و تعمیر اساسی.', '{}', NULL, 1),
    ('transmission', 'Transmission', 'گیربکس', 'Manual, automatic, CVT and dual-clutch gearboxes, clutch and gear shift.', 'گیربکس دستی، اتوماتیک، CVT و دوکلاچه، کلاچ و دسته دنده.', '{}', NULL, 2),
    ('brakes', 'Brakes', 'ترمز', 'Pads, discs, drums, calipers, hydraulics, ABS and handbrake.', 'لنت، دیسک، کاسه چرخ، کالیپر، مدار هیدرولیک، ABS و ترمز دستی.', '{}', NULL, 3),
    ('suspension', 'Suspension', 'سیستم تعلیق', 'Shock absorbers, springs, control arms, bushings, ball joints and wheel bearings.', 'کمک‌فنر، فنر، طبق، بوش، سیبک و بلبرینگ چرخ.', '{}', NULL, 4),
    ('steering', 'Steering', 'فرمان', 'Steering rack, power and electric steering, tie rods and steering fluid.', 'جعبه فرمان، فرمان هیدرولیک و برقی، میل و سیبک فرمان و روغن فرمان.', '{}', NULL, 5),
    ('electrical', 'Electrical', 'برق خودرو', '12-volt system: battery, charging, starting, wiring, lighting and power windows.', 'سیستم 12 ولت: باتری، شارژ، استارت، سیم‌کشی، چراغ‌ها و شیشه‌بالابر.', '{}', NULL, 6),
    ('cooling', 'Cooling system', 'سیستم خنک‌کننده', 'Radiator, water pump, thermostat, fans, hoses and coolant.', 'رادیاتور، واترپمپ، ترموستات، فن، شیلنگ‌ها و ضدیخ.', '{}', NULL, 7),
    ('air-conditioning', 'Air conditioning', 'کولر و تهویه', 'AC, heater, blower and climate control.', 'کولر، بخاری، فن داخل و کنترل تهویه.', '{}', NULL, 8),
    ('exhaust', 'Exhaust', 'اگزوز', 'Exhaust pipes, muffler, catalytic converter, oxygen sensors and emissions.', 'لوله اگزوز، منبع اگزوز، کاتالیست، سنسور اکسیژن و آلایندگی.', '{}', NULL, 9),
    ('fuel-system', 'Fuel system', 'سیستم سوخت‌رسانی', 'Fuel pump, injectors, throttle body, filters, tank and lines (petrol and diesel).', 'پمپ بنزین، انژکتور، دریچه گاز، فیلتر، باک و لوله‌ها (بنزینی و دیزلی).', '{}', NULL, 10),
    ('tires-wheels', 'Tires and wheels', 'لاستیک و رینگ', 'Tires, rims, alignment, balancing, puncture repair and tire pressure sensors.', 'لاستیک، رینگ، تنظیم فرمان، بالانس، پنچرگیری و سنسور فشار باد.', '{}', NULL, 11),
    ('body-paint', 'Body and paint', 'بدنه و رنگ', 'Accident repair, dents, paint, rust, bumpers, panels and chassis straightening.', 'تعمیر تصادفی، صافکاری، نقاشی، زنگ‌زدگی، سپر، قطعات بدنه و شاسی‌کشی.', '{}', NULL, 12),
    ('glass', 'Glass', 'شیشه', 'Windshield, side and rear windows, mirrors.', 'شیشه جلو، شیشه‌های بغل و عقب و آینه‌ها.', '{}', NULL, 13),
    ('diagnostics', 'Diagnostics', 'عیب‌یابی', 'Fault finding, diagnostic scans, inspections and pre-purchase checks.', 'عیب‌یابی، دیاگ، بازدید فنی و کارشناسی خرید خودرو.', '{}', NULL, 14),
    ('ev-hybrid-system', 'EV and hybrid system', 'سیستم برقی و هیبریدی', 'High-voltage battery, electric motor, inverter and charging. Needs high-voltage qualified staff.', 'باتری ولتاژ بالا، موتور الکتریکی، اینورتر و شارژ. نیازمند کارکنان دارای صلاحیت ولتاژ بالا.', '{}', NULL, 15),
    ('maintenance', 'Routine maintenance', 'سرویس دوره‌ای', 'Scheduled service: oil, filters, fluids, spark plugs, wipers and seasonal checks.', 'سرویس دوره‌ای: روغن، فیلترها، مایعات، شمع، برف‌پاک‌کن و بازدید فصلی.', '{}', NULL, 16),
    ('drivetrain', 'Drivetrain and axles', 'انتقال قدرت (پلوس، گاردان، دیفرانسیل)', 'CV joints and axles, driveshaft, differential and 4WD/AWD systems.', 'پلوس و سرپلوس، گاردان، دیفرانسیل و سیستم چهارچرخ‌محرک.', '{}', NULL, 17),
    ('electronics', 'Electronics and ECU', 'الکترونیک و ای‌سی‌یو', 'ECU and control modules, instrument cluster, infotainment, cameras and sensors.', 'ای‌سی‌یو و یونیت‌ها، صفحه آمپر، پخش و مالتی‌مدیا، دوربین و سنسورها.', '{}', NULL, 18),
    ('safety-systems', 'Airbags and safety systems', 'کیسه هوا و سیستم‌های ایمنی', 'Airbags, seat belts and driver-assistance (ADAS) calibration.', 'کیسه هوا، کمربند ایمنی و کالیبره کردن سامانه‌های کمک‌راننده (ADAS).', '{}', NULL, 19),
    ('cng-lpg-system', 'Gas fuel system (CNG/LPG)', 'سیستم گازسوز (CNG/LPG)', 'Bi-fuel conversion, gas cylinders, regulators, gas injectors and inspections.', 'دوگانه‌سوز کردن، مخزن گاز، رگلاتور، انژکتور گاز و بازرسی‌ها.', '{}', NULL, 20),
    ('locks-security', 'Locks, keys and alarms', 'قفل، سوئیچ و دزدگیر', 'Keys and remotes, immobilizer, central locking and alarms.', 'سوئیچ و ریموت، ایموبلایزر، قفل مرکزی و دزدگیر.', '{}', NULL, 21),
    ('interior', 'Interior and upholstery', 'تودوزی و داخل کابین', 'Seats, upholstery, headliner, dashboard and interior trim.', 'صندلی، تودوزی، سقف، داشبورد و تزئینات داخلی.', '{}', NULL, 22),
    ('detailing', 'Detailing and car wash', 'دیتیلینگ و کارواش', 'Washing, interior detailing, polishing, ceramic coating and paint protection.', 'شستشو، صفرشویی داخل، پولیش، پوشش سرامیک و محافظ رنگ.', '{}', NULL, 23),
    ('roadside-assistance', 'Roadside assistance and towing', 'امداد خودرو و یدک‌کش', 'Towing, jump start, roadside tire change, fuel delivery and mobile mechanics.', 'یدک‌کشی، باتری به باتری، تعویض لاستیک در محل، رساندن سوخت و مکانیک سیار.', '{}', NULL, 24)
  ) AS v(slug, en, fa, den, dfa, regions, attrs, sort);

-- Service tasks
INSERT INTO taxonomy.taxonomy_nodes (created_by, type, parent_id, name_translations, slug, regions, attributes, sort_order)
SELECT core.system_actor_id(), 'service_task', p.id, jsonb_build_object('en', v.en, 'fa', v.fa), v.slug, v.regions::core.country[], v.attrs::jsonb, v.sort
  FROM (VALUES
    ('engine', 'timing-belt', 'Timing belt replacement', 'تعویض تسمه تایم', '{}', NULL, 1),
    ('engine', 'engine-rebuild', 'Engine rebuild', 'تعمیر اساسی موتور (اورهال)', '{}', NULL, 2),
    ('engine', 'cylinder-head-repair', 'Cylinder head repair', 'تعمیر سرسیلندر', '{}', NULL, 3),
    ('engine', 'head-gasket-replacement', 'Head gasket replacement', 'تعویض واشر سرسیلندر', '{}', NULL, 4),
    ('engine', 'engine-oil-leak-repair', 'Engine oil leak repair', 'رفع نشتی روغن موتور', '{}', NULL, 5),
    ('engine', 'engine-mount-replacement', 'Engine mount replacement', 'تعویض دسته موتور', '{}', NULL, 6),
    ('engine', 'accessory-belt-replacement', 'Accessory belt replacement', 'تعویض تسمه دینام', '{}', NULL, 7),
    ('engine', 'turbo-repair', 'Turbocharger repair', 'تعمیر توربوشارژر', '{}', NULL, 8),
    ('engine', 'ignition-coil-replacement', 'Ignition coil replacement', 'تعویض کوئل', '{}', NULL, 9),
    ('engine', 'engine-tune-up', 'Engine tune-up', 'تنظیم موتور', '{}', NULL, 10),
    ('engine', 'engine-replacement', 'Engine replacement', 'تعویض موتور', '{}', NULL, 11),
    ('transmission', 'clutch-replacement', 'Clutch replacement', 'تعویض کلاچ', '{}', NULL, 1),
    ('transmission', 'manual-gearbox-repair', 'Manual gearbox repair', 'تعمیر گیربکس دستی', '{}', NULL, 2),
    ('transmission', 'automatic-transmission-repair', 'Automatic transmission repair', 'تعمیر گیربکس اتوماتیک', '{}', NULL, 3),
    ('transmission', 'transmission-fluid-change', 'Transmission fluid change', 'تعویض روغن گیربکس', '{}', NULL, 4),
    ('transmission', 'cvt-repair', 'CVT repair', 'تعمیر گیربکس CVT', '{}', NULL, 5),
    ('transmission', 'dual-clutch-repair', 'Dual-clutch (DSG) repair', 'تعمیر گیربکس دوکلاچه (DSG)', '{}', NULL, 6),
    ('transmission', 'shift-linkage-repair', 'Gear shift cable and linkage repair', 'تعمیر سیم دنده و اهرم‌بندی', '{}', NULL, 7),
    ('brakes', 'brake-pad-replacement', 'Brake pad replacement', 'تعویض لنت ترمز', '{}', NULL, 1),
    ('brakes', 'brake-disc-replacement', 'Brake disc replacement', 'تعویض دیسک ترمز', '{}', NULL, 2),
    ('brakes', 'brake-disc-resurfacing', 'Brake disc resurfacing', 'تراش دیسک ترمز', '{}', NULL, 3),
    ('brakes', 'brake-shoe-replacement', 'Brake shoe and drum service', 'تعویض لنت کفشکی و سرویس کاسه چرخ', '{}', NULL, 4),
    ('brakes', 'brake-fluid-change', 'Brake fluid change', 'تعویض روغن ترمز', '{}', NULL, 5),
    ('brakes', 'brake-caliper-repair', 'Brake caliper repair', 'تعمیر کالیپر ترمز', '{}', NULL, 6),
    ('brakes', 'abs-repair', 'ABS repair', 'تعمیر سیستم ABS', '{}', NULL, 7),
    ('brakes', 'handbrake-adjustment', 'Handbrake adjustment', 'تنظیم ترمز دستی', '{}', NULL, 8),
    ('brakes', 'brake-master-booster-repair', 'Master cylinder and booster repair', 'تعمیر پمپ ترمز و بوستر', '{}', NULL, 9),
    ('brakes', 'brake-inspection', 'Brake inspection', 'بازدید ترمز', '{}', NULL, 10),
    ('suspension', 'suspension-repair', 'Suspension repair', 'تعمیر جلوبندی و تعلیق', '{}', NULL, 1),
    ('suspension', 'shock-absorber-replacement', 'Shock absorber replacement', 'تعویض کمک‌فنر', '{}', NULL, 2),
    ('suspension', 'control-arm-replacement', 'Control arm and bushing replacement', 'تعویض طبق و بوش', '{}', NULL, 3),
    ('suspension', 'ball-joint-replacement', 'Ball joint replacement', 'تعویض سیبک', '{}', NULL, 4),
    ('suspension', 'sway-bar-link-replacement', 'Sway bar link replacement', 'تعویض میل موج‌گیر', '{}', NULL, 5),
    ('suspension', 'wheel-bearing-replacement', 'Wheel bearing replacement', 'تعویض بلبرینگ چرخ', '{}', NULL, 6),
    ('suspension', 'spring-replacement', 'Coil spring replacement', 'تعویض فنر', '{}', NULL, 7),
    ('suspension', 'strut-mount-replacement', 'Strut mount replacement', 'تعویض توپی سر کمک', '{}', NULL, 8),
    ('suspension', 'air-suspension-repair', 'Air suspension repair', 'تعمیر تعلیق بادی', '{}', NULL, 9),
    ('steering', 'power-steering-repair', 'Power steering repair', 'تعمیر فرمان هیدرولیک', '{}', NULL, 1),
    ('steering', 'electric-power-steering-repair', 'Electric power steering repair', 'تعمیر فرمان برقی', '{}', NULL, 2),
    ('steering', 'steering-rack-repair', 'Steering rack repair', 'تعمیر جعبه فرمان', '{}', NULL, 3),
    ('steering', 'tie-rod-replacement', 'Tie rod replacement', 'تعویض میل و سیبک فرمان', '{}', NULL, 4),
    ('steering', 'power-steering-fluid-service', 'Power steering fluid service', 'تعویض روغن هیدرولیک فرمان', '{}', NULL, 5),
    ('electrical', 'battery-replacement', 'Battery replacement', 'تعویض باتری', '{}', NULL, 1),
    ('electrical', 'alternator-repair', 'Alternator repair', 'تعمیر یا تعویض دینام', '{}', NULL, 2),
    ('electrical', 'starter-repair', 'Starter motor repair', 'تعمیر استارت', '{}', NULL, 3),
    ('electrical', 'wiring-repair', 'Wiring repair', 'سیم‌کشی و رفع اتصالی', '{}', NULL, 4),
    ('electrical', 'lighting-repair', 'Lighting repair', 'تعمیر و تعویض چراغ‌ها', '{}', NULL, 5),
    ('electrical', 'power-window-repair', 'Power window repair', 'تعمیر شیشه‌بالابر برقی', '{}', NULL, 6),
    ('electrical', 'battery-drain-diagnosis', 'Battery drain diagnosis', 'عیب‌یابی خالی شدن باتری', '{}', NULL, 7),
    ('cooling', 'radiator-repair', 'Radiator repair', 'تعمیر یا تعویض رادیاتور', '{}', NULL, 1),
    ('cooling', 'water-pump-replacement', 'Water pump replacement', 'تعویض واترپمپ', '{}', NULL, 2),
    ('cooling', 'thermostat-replacement', 'Thermostat replacement', 'تعویض ترموستات', '{}', NULL, 3),
    ('cooling', 'coolant-flush', 'Coolant flush', 'تعویض و شستشوی ضدیخ', '{}', NULL, 4),
    ('cooling', 'cooling-fan-repair', 'Radiator fan repair', 'تعمیر فن رادیاتور', '{}', NULL, 5),
    ('cooling', 'hose-replacement', 'Coolant hose replacement', 'تعویض شیلنگ‌های آب', '{}', NULL, 6),
    ('cooling', 'overheating-diagnosis', 'Overheating diagnosis', 'عیب‌یابی جوش آوردن موتور', '{}', NULL, 7),
    ('air-conditioning', 'ac-recharge', 'AC gas recharge', 'شارژ گاز کولر', '{}', NULL, 1),
    ('air-conditioning', 'ac-compressor-repair', 'AC compressor repair', 'تعمیر کمپرسور کولر', '{}', NULL, 2),
    ('air-conditioning', 'ac-leak-repair', 'AC leak repair', 'رفع نشتی کولر', '{}', NULL, 3),
    ('air-conditioning', 'heater-repair', 'Heater repair', 'تعمیر بخاری', '{}', NULL, 4),
    ('air-conditioning', 'cabin-blower-repair', 'Blower fan repair', 'تعمیر فن بخاری', '{}', NULL, 5),
    ('air-conditioning', 'climate-control-repair', 'Climate control repair', 'تعمیر کنترل کولر و بخاری', '{}', NULL, 6),
    ('air-conditioning', 'condenser-evaporator-replacement', 'Condenser or evaporator replacement', 'تعویض کندانسور یا اواپراتور', '{}', NULL, 7),
    ('exhaust', 'exhaust-repair', 'Exhaust repair', 'تعمیر اگزوز', '{}', NULL, 1),
    ('exhaust', 'catalytic-converter-replacement', 'Catalytic converter replacement', 'تعویض کاتالیست', '{}', NULL, 2),
    ('exhaust', 'muffler-replacement', 'Muffler replacement', 'تعویض منبع اگزوز', '{}', NULL, 3),
    ('exhaust', 'oxygen-sensor-replacement', 'Oxygen sensor replacement', 'تعویض سنسور اکسیژن', '{}', NULL, 4),
    ('exhaust', 'dpf-cleaning', 'Diesel particulate filter cleaning', 'تمیزکاری فیلتر دوده (DPF)', '{}', NULL, 5),
    ('exhaust', 'emissions-repair', 'Emissions repair', 'رفع نقص آلایندگی', '{}', NULL, 6),
    ('fuel-system', 'injector-cleaning', 'Fuel injector cleaning', 'شستشوی انژکتور', '{}', NULL, 1),
    ('fuel-system', 'fuel-pump-replacement', 'Fuel pump replacement', 'تعویض پمپ بنزین', '{}', NULL, 2),
    ('fuel-system', 'fuel-filter-replacement', 'Fuel filter replacement', 'تعویض فیلتر بنزین', '{}', NULL, 3),
    ('fuel-system', 'throttle-body-cleaning', 'Throttle body cleaning', 'شستشوی دریچه گاز', '{}', NULL, 4),
    ('fuel-system', 'fuel-leak-repair', 'Fuel leak repair', 'رفع نشتی سوخت', '{}', NULL, 5),
    ('fuel-system', 'diesel-injection-repair', 'Diesel injection repair', 'تعمیر سیستم انژکتور دیزل', '{}', NULL, 6),
    ('tires-wheels', 'wheel-alignment', 'Wheel alignment', 'تنظیم فرمان (میزان فرمان)', '{}', NULL, 1),
    ('tires-wheels', 'tire-replacement', 'Tire replacement', 'تعویض لاستیک', '{}', NULL, 2),
    ('tires-wheels', 'wheel-balancing', 'Wheel balancing', 'بالانس چرخ', '{}', NULL, 3),
    ('tires-wheels', 'tire-repair', 'Puncture repair', 'پنچرگیری', '{}', NULL, 4),
    ('tires-wheels', 'tire-rotation', 'Tire rotation', 'جابجایی لاستیک‌ها', '{}', NULL, 5),
    ('tires-wheels', 'rim-repair', 'Rim repair', 'تعمیر و صافکاری رینگ', '{}', NULL, 6),
    ('tires-wheels', 'tpms-service', 'Tire pressure sensor service', 'سرویس سنسور فشار باد', '{}', NULL, 7),
    ('tires-wheels', 'seasonal-tire-change', 'Seasonal tire change', 'تعویض لاستیک فصلی', '{}', NULL, 8),
    ('body-paint', 'dent-repair', 'Dent repair', 'صافکاری', '{}', NULL, 1),
    ('body-paint', 'painting', 'Painting', 'نقاشی', '{}', NULL, 2),
    ('body-paint', 'accident-repair', 'Accident repair', 'تعمیر خودروی تصادفی', '{}', NULL, 3),
    ('body-paint', 'paintless-dent-repair', 'Paintless dent repair', 'صافکاری بدون رنگ (PDR)', '{}', NULL, 4),
    ('body-paint', 'bumper-repair', 'Bumper repair', 'تعمیر سپر', '{}', NULL, 5),
    ('body-paint', 'rust-repair', 'Rust repair', 'رفع زنگ‌زدگی بدنه', '{}', NULL, 6),
    ('body-paint', 'chassis-straightening', 'Chassis straightening', 'شاسی‌کشی', '{}', NULL, 7),
    ('body-paint', 'panel-replacement', 'Body panel replacement', 'تعویض قطعات بدنه', '{}', NULL, 8),
    ('glass', 'windshield-replacement', 'Windshield replacement', 'تعویض شیشه جلو', '{}', NULL, 1),
    ('glass', 'windshield-chip-repair', 'Windshield chip repair', 'ترمیم ترک و خراش شیشه', '{}', NULL, 2),
    ('glass', 'side-window-replacement', 'Side or rear window replacement', 'تعویض شیشه بغل یا عقب', '{}', NULL, 3),
    ('glass', 'mirror-replacement', 'Mirror replacement', 'تعویض آینه', '{}', NULL, 4),
    ('diagnostics', 'engine-diagnostics', 'Engine diagnostics', 'عیب‌یابی موتور (دیاگ)', '{}', NULL, 1),
    ('diagnostics', 'general-inspection', 'General inspection', 'بازدید فنی کلی', '{}', NULL, 2),
    ('diagnostics', 'pre-purchase-inspection', 'Pre-purchase inspection', 'کارشناسی خرید خودرو', '{}', NULL, 3),
    ('diagnostics', 'diagnostic-scan', 'Full diagnostic scan', 'دیاگ کامل خودرو', '{}', NULL, 4),
    ('diagnostics', 'electrical-diagnostics', 'Electrical fault diagnosis', 'عیب‌یابی برق خودرو', '{}', NULL, 5),
    ('diagnostics', 'noise-vibration-diagnosis', 'Noise and vibration diagnosis', 'عیب‌یابی صدا و لرزش', '{}', NULL, 6),
    ('diagnostics', 'technical-inspection-prep', 'Roadworthiness test preparation', 'آماده‌سازی برای معاینه فنی', '{}', NULL, 7),
    ('ev-hybrid-system', 'hv-battery-diagnostics', 'High-voltage battery diagnostics', 'عیب‌یابی باتری ولتاژ بالا', '{}', NULL, 1),
    ('ev-hybrid-system', 'hv-battery-repair', 'High-voltage battery repair', 'تعمیر باتری ولتاژ بالا', '{}', NULL, 2),
    ('ev-hybrid-system', 'hybrid-system-service', 'Hybrid system service', 'سرویس سیستم هیبریدی', '{}', NULL, 3),
    ('ev-hybrid-system', 'ev-charger-repair', 'Onboard charger and charge port repair', 'تعمیر شارژر داخلی و درگاه شارژ', '{}', NULL, 4),
    ('ev-hybrid-system', 'electric-motor-repair', 'Electric drive motor repair', 'تعمیر موتور الکتریکی', '{}', NULL, 5),
    ('ev-hybrid-system', 'home-charger-installation', 'Home charger installation', 'نصب شارژر خانگی', '{}', NULL, 6),
    ('maintenance', 'oil-change', 'Oil change', 'تعویض روغن', '{}', NULL, 1),
    ('maintenance', 'periodic-service', 'Scheduled maintenance service', 'سرویس دوره‌ای طبق دفترچه', '{}', NULL, 2),
    ('maintenance', 'filter-replacement', 'Filter replacement', 'تعویض فیلترها', '{}', NULL, 3),
    ('maintenance', 'fluid-top-up', 'Fluid check and top-up', 'بازدید و تکمیل مایعات', '{}', NULL, 4),
    ('maintenance', 'spark-plug-replacement', 'Spark plug replacement', 'تعویض شمع', '{}', NULL, 5),
    ('maintenance', 'wiper-replacement', 'Wiper blade replacement', 'تعویض تیغه برف‌پاک‌کن', '{}', NULL, 6),
    ('maintenance', 'seasonal-check', 'Seasonal check', 'بازدید فصلی', '{}', NULL, 7),
    ('drivetrain', 'cv-joint-replacement', 'CV joint and axle replacement', 'تعویض پلوس و سرپلوس', '{}', NULL, 1),
    ('drivetrain', 'driveshaft-repair', 'Driveshaft repair', 'تعمیر گاردان', '{}', NULL, 2),
    ('drivetrain', 'differential-repair', 'Differential repair', 'تعمیر دیفرانسیل', '{}', NULL, 3),
    ('drivetrain', 'awd-system-repair', '4WD and AWD system repair', 'تعمیر سیستم چهارچرخ‌محرک', '{}', NULL, 4),
    ('electronics', 'ecu-repair', 'ECU repair', 'تعمیر ای‌سی‌یو', '{}', NULL, 1),
    ('electronics', 'ecu-programming', 'ECU programming', 'برنامه‌ریزی ای‌سی‌یو', '{}', NULL, 2),
    ('electronics', 'instrument-cluster-repair', 'Instrument cluster repair', 'تعمیر صفحه آمپر', '{}', NULL, 3),
    ('electronics', 'infotainment-repair', 'Infotainment and audio repair', 'تعمیر سیستم صوتی و مالتی‌مدیا', '{}', NULL, 4),
    ('electronics', 'accessory-electronics-installation', 'Accessory electronics installation', 'نصب لوازم جانبی الکترونیکی', '{}', NULL, 5),
    ('electronics', 'parking-sensor-installation', 'Parking sensor and camera installation', 'نصب سنسور و دوربین دنده‌عقب', '{}', NULL, 6),
    ('safety-systems', 'airbag-repair', 'Airbag system repair', 'تعمیر سیستم کیسه هوا', '{}', NULL, 1),
    ('safety-systems', 'seatbelt-repair', 'Seat belt repair', 'تعمیر کمربند ایمنی', '{}', NULL, 2),
    ('safety-systems', 'adas-calibration', 'ADAS camera and radar calibration', 'کالیبره کردن سامانه‌های کمک‌راننده (ADAS)', '{}', NULL, 3),
    ('cng-lpg-system', 'cng-conversion', 'CNG conversion', 'دوگانه‌سوز کردن (نصب CNG)', '{}', NULL, 1),
    ('cng-lpg-system', 'gas-system-repair', 'CNG/LPG system repair', 'تعمیر سیستم گازسوز', '{}', NULL, 2),
    ('cng-lpg-system', 'gas-cylinder-inspection', 'Gas cylinder inspection', 'بازرسی و تست مخزن گاز', '{}', NULL, 3),
    ('cng-lpg-system', 'gas-regulator-service', 'Gas regulator service', 'سرویس رگلاتور گاز', '{}', NULL, 4),
    ('locks-security', 'key-programming', 'Key and remote programming', 'ساخت و برنامه‌ریزی سوئیچ و ریموت', '{}', NULL, 1),
    ('locks-security', 'lockout-service', 'Lockout service', 'باز کردن درب قفل‌شده', '{}', NULL, 2),
    ('locks-security', 'alarm-installation', 'Alarm and immobilizer installation', 'نصب دزدگیر و ایموبلایزر', '{}', NULL, 3),
    ('locks-security', 'central-locking-repair', 'Central locking repair', 'تعمیر قفل مرکزی', '{}', NULL, 4),
    ('interior', 'upholstery-repair', 'Upholstery repair', 'تعمیر تودوزی', '{}', NULL, 1),
    ('interior', 'seat-cover-installation', 'Seat cover installation', 'روکش صندلی', '{}', NULL, 2),
    ('interior', 'headliner-repair', 'Headliner repair', 'تعمیر تودوزی سقف', '{}', NULL, 3),
    ('interior', 'dashboard-repair', 'Dashboard repair', 'تعمیر داشبورد', '{}', NULL, 4),
    ('interior', 'seat-repair', 'Seat mechanism repair', 'تعمیر مکانیزم صندلی', '{}', NULL, 5),
    ('detailing', 'car-wash', 'Car wash', 'کارواش', '{}', NULL, 1),
    ('detailing', 'interior-detailing', 'Interior detailing', 'صفرشویی داخل خودرو', '{}', NULL, 2),
    ('detailing', 'paint-correction', 'Paint correction and polishing', 'پولیش و اصلاح رنگ', '{}', NULL, 3),
    ('detailing', 'ceramic-coating', 'Ceramic coating', 'پوشش سرامیک', '{}', NULL, 4),
    ('detailing', 'paint-protection-film', 'Paint protection film', 'نصب کاور محافظ رنگ (PPF)', '{}', NULL, 5),
    ('detailing', 'headlight-restoration', 'Headlight restoration', 'پولیش چراغ جلو', '{}', NULL, 6),
    ('detailing', 'engine-bay-cleaning', 'Engine bay cleaning', 'موتورشویی', '{}', NULL, 7),
    ('roadside-assistance', 'towing', 'Towing', 'یدک‌کشی', '{}', NULL, 1),
    ('roadside-assistance', 'jump-start', 'Jump start', 'باتری به باتری', '{}', NULL, 2),
    ('roadside-assistance', 'mobile-tire-service', 'Roadside tire change', 'تعویض لاستیک در محل', '{}', NULL, 3),
    ('roadside-assistance', 'fuel-delivery', 'Fuel delivery', 'رساندن سوخت', '{}', NULL, 4),
    ('roadside-assistance', 'mobile-mechanic', 'Mobile mechanic visit', 'اعزام مکانیک سیار', '{}', NULL, 5)
  ) AS v(parent_slug, slug, en, fa, regions, attrs, sort)
  JOIN taxonomy.taxonomy_nodes p ON p.type = 'service_system' AND p.slug = v.parent_slug;

-- Part categories
INSERT INTO taxonomy.taxonomy_nodes (created_by, type, name_translations, slug, regions, attributes, sort_order)
SELECT core.system_actor_id(), 'part_category', jsonb_build_object('en', v.en, 'fa', v.fa), v.slug, v.regions::core.country[], v.attrs::jsonb, v.sort
  FROM (VALUES
    ('brake-parts', 'Brake parts', 'قطعات ترمز', '{}', '{"position_applicable": true}', 1),
    ('filters', 'Filters', 'فیلتر', '{}', '{"position_applicable": false}', 2),
    ('engine-parts', 'Engine parts', 'قطعات موتور', '{}', '{"position_applicable": false}', 3),
    ('suspension-parts', 'Suspension parts', 'قطعات جلوبندی و تعلیق', '{}', '{"position_applicable": true}', 4),
    ('electrical-parts', 'Electrical parts', 'قطعات برقی', '{}', '{"position_applicable": false}', 5),
    ('batteries', 'Batteries', 'باتری', '{}', '{"position_applicable": false}', 6),
    ('tires', 'Tires', 'لاستیک', '{}', '{"position_applicable": true}', 7),
    ('lighting', 'Lighting', 'چراغ', '{}', '{"position_applicable": true}', 8),
    ('body-parts', 'Body parts', 'قطعات بدنه', '{}', '{"position_applicable": true}', 9),
    ('fluids-oils', 'Oils and fluids', 'روغن و مایعات', '{}', '{"position_applicable": false}', 10),
    ('cooling-parts', 'Cooling parts', 'قطعات خنک‌کننده', '{}', '{"position_applicable": false}', 11),
    ('transmission-parts', 'Transmission parts', 'قطعات گیربکس', '{}', '{"position_applicable": false}', 12),
    ('steering-parts', 'Steering parts', 'قطعات فرمان', '{}', '{"position_applicable": true}', 13),
    ('wheels-rims', 'Wheels and rims', 'رینگ و چرخ', '{}', '{"position_applicable": true}', 14),
    ('glass-mirrors', 'Glass and mirrors', 'شیشه و آینه', '{}', '{"position_applicable": true}', 15),
    ('drivetrain-parts', 'Drivetrain parts', 'قطعات انتقال قدرت', '{}', '{"position_applicable": true}', 16),
    ('exhaust-parts', 'Exhaust parts', 'قطعات اگزوز', '{}', '{"position_applicable": false}', 17),
    ('fuel-system-parts', 'Fuel system parts', 'قطعات سوخت‌رسانی', '{}', '{"position_applicable": false}', 18),
    ('cng-lpg-parts', 'CNG and LPG parts', 'قطعات گازسوز', '{}', '{"position_applicable": false}', 19),
    ('ignition-parts', 'Ignition parts', 'قطعات جرقه', '{}', '{"position_applicable": false}', 20),
    ('sensors', 'Sensors', 'سنسورها', '{}', '{"position_applicable": true}', 21),
    ('electronics', 'Electronics', 'قطعات الکترونیکی', '{}', '{"position_applicable": false}', 22),
    ('ac-heating-parts', 'AC and heating parts', 'قطعات کولر و بخاری', '{}', '{"position_applicable": false}', 23),
    ('ev-hybrid-parts', 'EV and hybrid parts', 'قطعات خودروی برقی و هیبریدی', '{}', '{"position_applicable": false}', 24),
    ('safety-parts', 'Safety parts', 'قطعات ایمنی', '{}', '{"position_applicable": true}', 25),
    ('interior-parts', 'Interior parts', 'قطعات داخلی', '{}', '{"position_applicable": false}', 26),
    ('accessories', 'Accessories', 'لوازم جانبی', '{}', '{"position_applicable": false}', 27)
  ) AS v(slug, en, fa, regions, attrs, sort);

-- Part subcategories
INSERT INTO taxonomy.taxonomy_nodes (created_by, type, parent_id, name_translations, slug, regions, attributes, sort_order)
SELECT core.system_actor_id(), 'part_category', p.id, jsonb_build_object('en', v.en, 'fa', v.fa), v.slug, v.regions::core.country[], v.attrs::jsonb, v.sort
  FROM (VALUES
    ('brake-parts', 'brake-pads', 'Brake pads', 'لنت ترمز', '{}', '{"position_applicable": true}', 1),
    ('brake-parts', 'brake-discs', 'Brake discs', 'دیسک ترمز', '{}', '{"position_applicable": true}', 2),
    ('brake-parts', 'brake-shoes', 'Brake shoes', 'لنت کفشکی', '{}', '{"position_applicable": true}', 3),
    ('brake-parts', 'brake-drums', 'Brake drums', 'کاسه چرخ', '{}', '{"position_applicable": true}', 4),
    ('brake-parts', 'brake-calipers', 'Brake calipers', 'کالیپر ترمز', '{}', '{"position_applicable": true}', 5),
    ('brake-parts', 'brake-hoses-lines', 'Brake hoses and lines', 'شیلنگ و لوله ترمز', '{}', '{"position_applicable": true}', 6),
    ('brake-parts', 'brake-master-cylinders', 'Brake master cylinders', 'پمپ ترمز (سیلندر اصلی)', '{}', '{"position_applicable": false}', 7),
    ('brake-parts', 'brake-boosters', 'Brake boosters', 'بوستر ترمز', '{}', '{"position_applicable": false}', 8),
    ('brake-parts', 'abs-sensors-modules', 'ABS sensors and modules', 'سنسور و یونیت ABS', '{}', '{"position_applicable": true}', 9),
    ('brake-parts', 'handbrake-cables', 'Handbrake cables', 'سیم ترمز دستی', '{}', '{"position_applicable": true}', 10),
    ('filters', 'oil-filters', 'Oil filters', 'فیلتر روغن', '{}', '{"position_applicable": false}', 1),
    ('filters', 'air-filters', 'Air filters', 'فیلتر هوا', '{}', '{"position_applicable": false}', 2),
    ('filters', 'cabin-filters', 'Cabin filters', 'فیلتر کابین', '{}', '{"position_applicable": false}', 3),
    ('filters', 'fuel-filters', 'Fuel filters', 'فیلتر سوخت', '{}', '{"position_applicable": false}', 4),
    ('engine-parts', 'timing-belt-kits', 'Timing belts and chains', 'تسمه و زنجیر تایم', '{}', '{"position_applicable": false}', 1),
    ('engine-parts', 'accessory-belts', 'Accessory belts', 'تسمه دینام', '{}', '{"position_applicable": false}', 2),
    ('engine-parts', 'gaskets-seals', 'Gaskets and seals', 'واشر و کاسه‌نمد', '{}', '{"position_applicable": false}', 3),
    ('engine-parts', 'pistons-rings', 'Pistons and rings', 'پیستون و رینگ', '{}', '{"position_applicable": false}', 4),
    ('engine-parts', 'engine-mounts', 'Engine mounts', 'دسته موتور', '{}', '{"position_applicable": true}', 5),
    ('engine-parts', 'cylinder-heads', 'Cylinder heads', 'سرسیلندر', '{}', '{"position_applicable": false}', 6),
    ('engine-parts', 'oil-pumps', 'Oil pumps', 'اویل‌پمپ', '{}', '{"position_applicable": false}', 7),
    ('engine-parts', 'valves-camshafts', 'Valves and camshafts', 'سوپاپ و میل‌سوپاپ', '{}', '{"position_applicable": false}', 8),
    ('engine-parts', 'turbochargers', 'Turbochargers', 'توربوشارژر', '{}', '{"position_applicable": false}', 9),
    ('suspension-parts', 'shock-absorbers', 'Shock absorbers and struts', 'کمک‌فنر', '{}', '{"position_applicable": true}', 1),
    ('suspension-parts', 'control-arms', 'Control arms', 'طبق', '{}', '{"position_applicable": true}', 2),
    ('suspension-parts', 'ball-joints', 'Ball joints', 'سیبک', '{}', '{"position_applicable": true}', 3),
    ('suspension-parts', 'bushings', 'Bushings', 'بوش', '{}', '{"position_applicable": true}', 4),
    ('suspension-parts', 'springs', 'Coil springs', 'فنر لول', '{}', '{"position_applicable": true}', 5),
    ('suspension-parts', 'sway-bar-links', 'Sway bar links', 'میل موج‌گیر', '{}', '{"position_applicable": true}', 6),
    ('suspension-parts', 'wheel-bearings-hubs', 'Wheel bearings and hubs', 'بلبرینگ و توپی چرخ', '{}', '{"position_applicable": true}', 7),
    ('suspension-parts', 'strut-mounts', 'Strut mounts', 'توپی سر کمک', '{}', '{"position_applicable": true}', 8),
    ('suspension-parts', 'air-suspension-parts', 'Air suspension parts', 'قطعات تعلیق بادی', '{}', '{"position_applicable": true}', 9),
    ('electrical-parts', 'alternators', 'Alternators', 'دینام', '{}', '{"position_applicable": false}', 1),
    ('electrical-parts', 'starters', 'Starter motors', 'استارت', '{}', '{"position_applicable": false}', 2),
    ('electrical-parts', 'wiring-harnesses', 'Wiring harnesses', 'دسته‌سیم', '{}', '{"position_applicable": false}', 3),
    ('electrical-parts', 'fuses-relays', 'Fuses and relays', 'فیوز و رله', '{}', '{"position_applicable": false}', 4),
    ('electrical-parts', 'switches', 'Switches', 'کلیدهای برقی', '{}', '{"position_applicable": false}', 5),
    ('electrical-parts', 'power-window-motors', 'Window regulators and motors', 'موتور و مکانیزم شیشه‌بالابر', '{}', '{"position_applicable": true}', 6),
    ('electrical-parts', 'door-lock-actuators', 'Door lock actuators', 'موتور قفل درب', '{}', '{"position_applicable": true}', 7),
    ('electrical-parts', 'horns', 'Horns', 'بوق', '{}', '{"position_applicable": false}', 8),
    ('tires', 'car-tires', 'Car tires', 'لاستیک سواری', '{}', '{"position_applicable": true}', 1),
    ('tires', 'suv-tires', 'SUV and 4x4 tires', 'لاستیک شاسی‌بلند', '{}', '{"position_applicable": true}', 2),
    ('tires', 'van-light-truck-tires', 'Van and light truck tires', 'لاستیک وانت و ون', '{}', '{"position_applicable": true}', 3),
    ('tires', 'winter-tires', 'Winter tires', 'لاستیک زمستانی', '{}', '{"position_applicable": true}', 4),
    ('lighting', 'headlights', 'Headlights', 'چراغ جلو', '{}', '{"position_applicable": true}', 1),
    ('lighting', 'tail-lights', 'Tail lights', 'چراغ عقب', '{}', '{"position_applicable": true}', 2),
    ('lighting', 'fog-lights', 'Fog lights', 'چراغ مه‌شکن', '{}', '{"position_applicable": true}', 3),
    ('lighting', 'indicators', 'Indicators and side lights', 'چراغ راهنما', '{}', '{"position_applicable": true}', 4),
    ('lighting', 'bulbs', 'Bulbs', 'لامپ', '{}', '{"position_applicable": false}', 5),
    ('body-parts', 'bumpers', 'Bumpers', 'سپر', '{}', '{"position_applicable": true}', 1),
    ('body-parts', 'fenders', 'Fenders', 'گلگیر', '{}', '{"position_applicable": true}', 2),
    ('body-parts', 'hoods', 'Hoods', 'کاپوت', '{}', '{"position_applicable": false}', 3),
    ('body-parts', 'doors', 'Doors', 'درب', '{}', '{"position_applicable": true}', 4),
    ('body-parts', 'body-panels', 'Body panels', 'ورق و قطعات بدنه', '{}', '{"position_applicable": true}', 5),
    ('body-parts', 'grilles', 'Grilles', 'جلوپنجره', '{}', '{"position_applicable": false}', 6),
    ('body-parts', 'trunk-lids', 'Trunk lids and tailgates', 'درب صندوق', '{}', '{"position_applicable": false}', 7),
    ('body-parts', 'body-trim', 'Trim and mouldings', 'زه و تزئینات بدنه', '{}', '{"position_applicable": true}', 8),
    ('body-parts', 'door-handles', 'Door handles', 'دستگیره درب', '{}', '{"position_applicable": true}', 9),
    ('fluids-oils', 'engine-oils', 'Engine oils', 'روغن موتور', '{}', '{"position_applicable": false}', 1),
    ('fluids-oils', 'transmission-fluids', 'Transmission fluids', 'روغن گیربکس', '{}', '{"position_applicable": false}', 2),
    ('fluids-oils', 'brake-fluids', 'Brake fluids', 'روغن ترمز', '{}', '{"position_applicable": false}', 3),
    ('fluids-oils', 'coolants', 'Coolants and antifreeze', 'ضدیخ و مایع خنک‌کننده', '{}', '{"position_applicable": false}', 4),
    ('fluids-oils', 'power-steering-fluids', 'Power steering fluids', 'روغن هیدرولیک فرمان', '{}', '{"position_applicable": false}', 5),
    ('fluids-oils', 'ac-refrigerants', 'AC refrigerants', 'گاز کولر', '{}', '{"position_applicable": false}', 6),
    ('fluids-oils', 'greases-additives', 'Greases and additives', 'گریس و مکمل‌ها', '{}', '{"position_applicable": false}', 7),
    ('cooling-parts', 'radiators', 'Radiators', 'رادیاتور', '{}', '{"position_applicable": false}', 1),
    ('cooling-parts', 'water-pumps', 'Water pumps', 'واترپمپ', '{}', '{"position_applicable": false}', 2),
    ('cooling-parts', 'thermostats', 'Thermostats', 'ترموستات', '{}', '{"position_applicable": false}', 3),
    ('cooling-parts', 'cooling-fans', 'Cooling fans', 'فن رادیاتور', '{}', '{"position_applicable": false}', 4),
    ('cooling-parts', 'coolant-hoses', 'Coolant hoses', 'شیلنگ آب', '{}', '{"position_applicable": false}', 5),
    ('cooling-parts', 'expansion-tanks', 'Expansion tanks', 'منبع انبساط آب', '{}', '{"position_applicable": false}', 6),
    ('transmission-parts', 'clutch-kits', 'Clutch kits', 'دیسک و صفحه کلاچ', '{}', '{"position_applicable": false}', 1),
    ('transmission-parts', 'flywheels', 'Flywheels', 'فلایویل', '{}', '{"position_applicable": false}', 2),
    ('transmission-parts', 'gearbox-components', 'Gearbox components', 'قطعات داخلی گیربکس', '{}', '{"position_applicable": false}', 3),
    ('transmission-parts', 'shift-cables', 'Shift and clutch cables', 'سیم دنده و سیم کلاچ', '{}', '{"position_applicable": false}', 4),
    ('transmission-parts', 'transmission-mounts', 'Transmission mounts', 'دسته گیربکس', '{}', '{"position_applicable": false}', 5),
    ('steering-parts', 'steering-racks', 'Steering racks', 'جعبه فرمان', '{}', '{"position_applicable": false}', 1),
    ('steering-parts', 'tie-rods', 'Tie rods and ends', 'میل و سیبک فرمان', '{}', '{"position_applicable": true}', 2),
    ('steering-parts', 'power-steering-pumps', 'Power steering pumps', 'پمپ هیدرولیک فرمان', '{}', '{"position_applicable": false}', 3),
    ('wheels-rims', 'alloy-wheels', 'Alloy wheels', 'رینگ آلومینیومی', '{}', '{"position_applicable": true}', 1),
    ('wheels-rims', 'steel-wheels', 'Steel wheels', 'رینگ فولادی', '{}', '{"position_applicable": true}', 2),
    ('wheels-rims', 'wheel-nuts-bolts', 'Wheel nuts and bolts', 'پیچ و مهره چرخ', '{}', '{"position_applicable": false}', 3),
    ('wheels-rims', 'wheel-covers', 'Wheel covers', 'قالپاق', '{}', '{"position_applicable": false}', 4),
    ('glass-mirrors', 'windshields', 'Windshields', 'شیشه جلو', '{}', '{"position_applicable": false}', 1),
    ('glass-mirrors', 'side-windows', 'Side windows', 'شیشه بغل', '{}', '{"position_applicable": true}', 2),
    ('glass-mirrors', 'rear-windows', 'Rear windows', 'شیشه عقب', '{}', '{"position_applicable": false}', 3),
    ('glass-mirrors', 'side-mirrors', 'Side mirrors', 'آینه بغل', '{}', '{"position_applicable": true}', 4),
    ('glass-mirrors', 'wiper-blades', 'Wiper blades', 'تیغه برف‌پاک‌کن', '{}', '{"position_applicable": true}', 5),
    ('glass-mirrors', 'washer-pumps', 'Washer pumps', 'پمپ شیشه‌شوی', '{}', '{"position_applicable": false}', 6),
    ('drivetrain-parts', 'cv-axles', 'CV axles and joints', 'پلوس و سرپلوس', '{}', '{"position_applicable": true}', 1),
    ('drivetrain-parts', 'cv-boots', 'CV boots', 'گردگیر پلوس', '{}', '{"position_applicable": true}', 2),
    ('drivetrain-parts', 'driveshafts', 'Driveshafts', 'گاردان', '{}', '{"position_applicable": false}', 3),
    ('drivetrain-parts', 'differential-parts', 'Differential parts', 'قطعات دیفرانسیل', '{}', '{"position_applicable": false}', 4),
    ('exhaust-parts', 'mufflers', 'Mufflers', 'منبع اگزوز', '{}', '{"position_applicable": false}', 1),
    ('exhaust-parts', 'catalytic-converters', 'Catalytic converters', 'کاتالیست', '{}', '{"position_applicable": false}', 2),
    ('exhaust-parts', 'exhaust-pipes-manifolds', 'Exhaust pipes and manifolds', 'لوله و منیفولد اگزوز', '{}', '{"position_applicable": false}', 3),
    ('exhaust-parts', 'dpf-filters', 'Diesel particulate filters', 'فیلتر دوده (DPF)', '{}', '{"position_applicable": false}', 4),
    ('fuel-system-parts', 'fuel-pumps', 'Fuel pumps', 'پمپ بنزین', '{}', '{"position_applicable": false}', 1),
    ('fuel-system-parts', 'fuel-injectors', 'Fuel injectors', 'انژکتور', '{}', '{"position_applicable": false}', 2),
    ('fuel-system-parts', 'throttle-bodies', 'Throttle bodies', 'دریچه گاز', '{}', '{"position_applicable": false}', 3),
    ('fuel-system-parts', 'fuel-tanks-lines', 'Fuel tanks and lines', 'باک و لوله‌های سوخت', '{}', '{"position_applicable": false}', 4),
    ('fuel-system-parts', 'fuel-pressure-regulators', 'Fuel pressure regulators', 'رگلاتور فشار سوخت', '{}', '{"position_applicable": false}', 5),
    ('cng-lpg-parts', 'gas-cylinders', 'Gas cylinders', 'مخزن گاز', '{}', '{"position_applicable": false}', 1),
    ('cng-lpg-parts', 'gas-regulators', 'Gas regulators', 'رگلاتور گاز', '{}', '{"position_applicable": false}', 2),
    ('cng-lpg-parts', 'gas-injectors', 'Gas injectors', 'انژکتور گاز', '{}', '{"position_applicable": false}', 3),
    ('cng-lpg-parts', 'gas-control-units', 'Gas control units', 'ای‌سی‌یو گاز', '{}', '{"position_applicable": false}', 4),
    ('cng-lpg-parts', 'gas-valves-lines', 'Gas valves and lines', 'شیر و لوله گاز', '{}', '{"position_applicable": false}', 5),
    ('ignition-parts', 'spark-plugs', 'Spark plugs', 'شمع', '{}', '{"position_applicable": false}', 1),
    ('ignition-parts', 'ignition-coils', 'Ignition coils', 'کوئل', '{}', '{"position_applicable": false}', 2),
    ('ignition-parts', 'ignition-leads', 'Ignition leads', 'وایر شمع', '{}', '{"position_applicable": false}', 3),
    ('ignition-parts', 'glow-plugs', 'Glow plugs', 'شمع گرمکن دیزل', '{}', '{"position_applicable": false}', 4),
    ('sensors', 'oxygen-sensors', 'Oxygen sensors', 'سنسور اکسیژن', '{}', '{"position_applicable": true}', 1),
    ('sensors', 'map-maf-sensors', 'MAP and MAF sensors', 'سنسور مپ و دبی هوا', '{}', '{"position_applicable": false}', 2),
    ('sensors', 'temperature-sensors', 'Temperature sensors', 'سنسور دما', '{}', '{"position_applicable": false}', 3),
    ('sensors', 'position-sensors', 'Crank and cam position sensors', 'سنسور میل‌لنگ و میل‌سوپاپ', '{}', '{"position_applicable": false}', 4),
    ('sensors', 'parking-sensors', 'Parking sensors', 'سنسور دنده‌عقب', '{}', '{"position_applicable": true}', 5),
    ('sensors', 'tpms-sensors', 'Tire pressure sensors', 'سنسور فشار باد لاستیک', '{}', '{"position_applicable": true}', 6),
    ('electronics', 'ecus-modules', 'ECUs and control modules', 'ای‌سی‌یو و یونیت‌ها', '{}', '{"position_applicable": false}', 1),
    ('electronics', 'instrument-clusters', 'Instrument clusters', 'صفحه آمپر', '{}', '{"position_applicable": false}', 2),
    ('electronics', 'infotainment-units', 'Infotainment and audio units', 'پخش و مالتی‌مدیا', '{}', '{"position_applicable": false}', 3),
    ('electronics', 'cameras-dashcams', 'Cameras and dashcams', 'دوربین خودرو', '{}', '{"position_applicable": false}', 4),
    ('electronics', 'keys-remotes', 'Keys and remotes', 'سوئیچ و ریموت', '{}', '{"position_applicable": false}', 5),
    ('electronics', 'alarms-immobilizers', 'Alarms and immobilizers', 'دزدگیر و ایموبلایزر', '{}', '{"position_applicable": false}', 6),
    ('ac-heating-parts', 'ac-compressors', 'AC compressors', 'کمپرسور کولر', '{}', '{"position_applicable": false}', 1),
    ('ac-heating-parts', 'condensers', 'Condensers', 'کندانسور', '{}', '{"position_applicable": false}', 2),
    ('ac-heating-parts', 'evaporators', 'Evaporators', 'اواپراتور', '{}', '{"position_applicable": false}', 3),
    ('ac-heating-parts', 'heater-cores', 'Heater cores', 'رادیاتور بخاری', '{}', '{"position_applicable": false}', 4),
    ('ac-heating-parts', 'blower-motors', 'Blower motors', 'موتور فن بخاری', '{}', '{"position_applicable": false}', 5),
    ('ac-heating-parts', 'ac-hoses-valves', 'AC hoses and valves', 'شیلنگ و شیر کولر', '{}', '{"position_applicable": false}', 6),
    ('ac-heating-parts', 'climate-control-units', 'Climate control units', 'کنترل کولر و بخاری', '{}', '{"position_applicable": false}', 7),
    ('ev-hybrid-parts', 'hv-battery-modules', 'High-voltage battery modules', 'ماژول باتری ولتاژ بالا', '{}', '{"position_applicable": false}', 1),
    ('ev-hybrid-parts', 'charging-ports-cables', 'Charging ports and cables', 'درگاه و کابل شارژ', '{}', '{"position_applicable": false}', 2),
    ('ev-hybrid-parts', 'inverters-converters', 'Inverters and converters', 'اینورتر و مبدل', '{}', '{"position_applicable": false}', 3),
    ('ev-hybrid-parts', 'ev-drive-motors', 'Electric drive motors', 'موتور الکتریکی محرک', '{}', '{"position_applicable": false}', 4),
    ('safety-parts', 'airbags', 'Airbags', 'کیسه هوا', '{}', '{"position_applicable": true}', 1),
    ('safety-parts', 'seat-belts', 'Seat belts', 'کمربند ایمنی', '{}', '{"position_applicable": true}', 2),
    ('safety-parts', 'airbag-sensors-modules', 'Airbag sensors and modules', 'سنسور و یونیت کیسه هوا', '{}', '{"position_applicable": false}', 3),
    ('interior-parts', 'seats-covers', 'Seats and seat covers', 'صندلی و روکش', '{}', '{"position_applicable": false}', 1),
    ('interior-parts', 'floor-mats', 'Floor mats', 'کفپوش', '{}', '{"position_applicable": false}', 2),
    ('interior-parts', 'dashboard-trim', 'Dashboard and interior trim', 'داشبورد و تزئینات داخلی', '{}', '{"position_applicable": false}', 3),
    ('interior-parts', 'steering-wheels', 'Steering wheels', 'غربیلک فرمان', '{}', '{"position_applicable": false}', 4),
    ('accessories', 'roof-racks', 'Roof racks and carriers', 'باربند', '{}', '{"position_applicable": false}', 1),
    ('accessories', 'towing-equipment', 'Towing equipment', 'قلاب و تجهیزات یدک‌کشی', '{}', '{"position_applicable": false}', 2),
    ('accessories', 'car-care', 'Car care products', 'محصولات نظافت و نگهداری خودرو', '{}', '{"position_applicable": false}', 3),
    ('accessories', 'emergency-kits', 'Emergency kits', 'کیت اضطراری خودرو', '{}', '{"position_applicable": false}', 4)
  ) AS v(parent_slug, slug, en, fa, regions, attrs, sort)
  JOIN taxonomy.taxonomy_nodes p ON p.type = 'part_category' AND p.slug = v.parent_slug;

-- Symptoms (safety_critical drives the shared safety keyword check, 52 §7)
INSERT INTO taxonomy.taxonomy_nodes (created_by, type, name_translations, slug, regions, attributes, sort_order)
SELECT core.system_actor_id(), 'symptom', jsonb_build_object('en', v.en, 'fa', v.fa), v.slug, v.regions::core.country[], v.attrs::jsonb, v.sort
  FROM (VALUES
    ('brake-problem', 'Brakes not working properly', 'مشکل ترمز', '{}', '{"safety_critical": true}', 1),
    ('steering-problem', 'Steering problem', 'مشکل فرمان', '{}', '{"safety_critical": true}', 2),
    ('smoke', 'Smoke from the car', 'دود از خودرو', '{}', '{"safety_critical": true}', 3),
    ('burning-smell', 'Burning smell', 'بوی سوختگی', '{}', '{"safety_critical": true}', 4),
    ('airbag-warning', 'Airbag warning light', 'چراغ هشدار کیسه هوا', '{}', '{"safety_critical": true}', 5),
    ('overheating', 'Engine overheating', 'جوش آوردن موتور', '{}', '{"safety_critical": true}', 6),
    ('loss-of-power', 'Sudden loss of power', 'افت ناگهانی قدرت', '{}', '{"safety_critical": true}', 7),
    ('no-start', 'Car will not start', 'خودرو روشن نمی‌شود', '{}', '{"safety_critical": false}', 8),
    ('check-engine-light', 'Check engine light', 'چراغ چک موتور', '{}', '{"safety_critical": false}', 9),
    ('strange-noise', 'Strange noise', 'صدای غیرعادی', '{}', '{"safety_critical": false}', 10),
    ('vibration', 'Vibration', 'لرزش', '{}', '{"safety_critical": false}', 11),
    ('fluid-leak', 'Fluid leak', 'نشتی مایعات', '{}', '{"safety_critical": false}', 12),
    ('ac-not-cooling', 'AC not cooling', 'کولر خنک نمی‌کند', '{}', '{"safety_critical": false}', 13),
    ('battery-drain', 'Battery keeps dying', 'خالی شدن باتری', '{}', '{"safety_critical": false}', 14),
    ('warning-light', 'Warning light on', 'روشن شدن چراغ هشدار', '{}', '{"safety_critical": false}', 15),
    ('unusual-smell', 'Unusual smell', 'بوی غیرعادی', '{}', '{"safety_critical": false}', 16),
    ('heater-or-ventilation-problem', 'Heater or ventilation problem', 'مشکل بخاری یا تهویه', '{}', '{"safety_critical": false}', 17),
    ('rough-running', 'Engine running rough', 'کار کردن نامنظم موتور', '{}', '{"safety_critical": false}', 18),
    ('high-fuel-consumption', 'High fuel consumption', 'مصرف سوخت بالا', '{}', '{"safety_critical": false}', 19),
    ('transmission-problem', 'Gearbox or clutch problem', 'مشکل گیربکس یا کلاچ', '{}', '{"safety_critical": false}', 20),
    ('electrical-problem', 'Electrical problem', 'مشکل برقی', '{}', '{"safety_critical": false}', 21),
    ('tire-problem', 'Tire problem', 'مشکل لاستیک', '{}', '{"safety_critical": false}', 22),
    ('body-damage', 'Body damage', 'آسیب بدنه', '{}', '{"safety_critical": false}', 23),
    ('door-lock-key-problem', 'Lock, key or alarm problem', 'مشکل قفل، سوئیچ یا دزدگیر', '{}', '{"safety_critical": false}', 24),
    ('ev-charging-problem', 'Charging or range problem', 'مشکل شارژ یا برد', '{}', '{"safety_critical": false}', 25),
    ('ride-handling-problem', 'Ride or handling problem', 'مشکل سواری یا فرمان‌پذیری', '{}', '{"safety_critical": false}', 26),
    ('glass-or-wiper-problem', 'Glass or wiper problem', 'مشکل شیشه یا برف‌پاک‌کن', '{}', '{"safety_critical": false}', 27)
  ) AS v(slug, en, fa, regions, attrs, sort);

-- Symptom details
INSERT INTO taxonomy.taxonomy_nodes (created_by, type, parent_id, name_translations, slug, regions, attributes, sort_order)
SELECT core.system_actor_id(), 'symptom', p.id, jsonb_build_object('en', v.en, 'fa', v.fa), v.slug, v.regions::core.country[], v.attrs::jsonb, v.sort
  FROM (VALUES
    ('brake-problem', 'soft-brake-pedal', 'Soft or sinking brake pedal', 'پدال ترمز نرم است یا تا ته می‌رود', '{}', '{"safety_critical": true}', 1),
    ('brake-problem', 'brake-grinding', 'Grinding when braking', 'صدای ساییدگی فلز هنگام ترمز', '{}', '{"safety_critical": true}', 2),
    ('brake-problem', 'brake-squeal', 'Squealing brakes', 'جیرجیر ترمز', '{}', '{"safety_critical": false}', 3),
    ('brake-problem', 'car-pulls-when-braking', 'Car pulls when braking', 'کشیدن خودرو به یک طرف هنگام ترمز', '{}', '{"safety_critical": true}', 4),
    ('brake-problem', 'brake-warning-light', 'Brake warning light', 'چراغ هشدار ترمز', '{}', '{"safety_critical": true}', 5),
    ('brake-problem', 'handbrake-not-holding', 'Handbrake does not hold', 'ترمز دستی نگه نمی‌دارد', '{}', '{"safety_critical": true}', 6),
    ('steering-problem', 'steering-loose', 'Loose steering', 'لقی فرمان', '{}', '{"safety_critical": true}', 1),
    ('steering-problem', 'steering-heavy', 'Steering suddenly heavy', 'سنگین شدن ناگهانی فرمان', '{}', '{"safety_critical": true}', 2),
    ('steering-problem', 'pulling-to-one-side', 'Pulling to one side', 'کشیدن خودرو به یک طرف', '{}', '{"safety_critical": false}', 3),
    ('steering-problem', 'steering-wheel-off-center', 'Steering wheel off-centre', 'کج بودن فرمان در مسیر مستقیم', '{}', '{"safety_critical": false}', 4),
    ('steering-problem', 'steering-noise', 'Noise when turning the wheel', 'صدا هنگام چرخاندن فرمان', '{}', '{"safety_critical": false}', 5),
    ('smoke', 'smoke-from-engine-bay', 'Smoke from under the hood', 'دود از زیر کاپوت', '{}', '{"safety_critical": true}', 1),
    ('smoke', 'white-exhaust-smoke', 'White exhaust smoke', 'دود سفید از اگزوز', '{}', '{"safety_critical": false}', 2),
    ('smoke', 'blue-exhaust-smoke', 'Blue exhaust smoke', 'دود آبی از اگزوز', '{}', '{"safety_critical": false}', 3),
    ('smoke', 'black-exhaust-smoke', 'Black exhaust smoke', 'دود سیاه از اگزوز', '{}', '{"safety_critical": false}', 4),
    ('burning-smell', 'electrical-burning-smell', 'Burning plastic or electrical smell', 'بوی سوختگی سیم یا پلاستیک', '{}', '{"safety_critical": true}', 1),
    ('burning-smell', 'burning-oil-smell', 'Burning oil smell', 'بوی روغن سوخته', '{}', '{"safety_critical": true}', 2),
    ('burning-smell', 'burning-rubber-smell', 'Burning rubber or clutch smell', 'بوی لاستیک یا کلاچ سوخته', '{}', '{"safety_critical": true}', 3),
    ('overheating', 'temperature-gauge-high', 'Temperature gauge high', 'بالا رفتن آمپر دما', '{}', '{"safety_critical": true}', 1),
    ('overheating', 'steam-from-hood', 'Steam from under the hood', 'بخار از زیر کاپوت', '{}', '{"safety_critical": true}', 2),
    ('overheating', 'coolant-loss', 'Losing coolant', 'کم شدن آب رادیاتور', '{}', '{"safety_critical": false}', 3),
    ('loss-of-power', 'stalling-while-driving', 'Engine stalls while driving', 'خاموش شدن موتور حین رانندگی', '{}', '{"safety_critical": true}', 1),
    ('loss-of-power', 'limp-mode', 'Reduced power mode', 'رفتن خودرو به حالت اضطراری (کاهش قدرت)', '{}', '{"safety_critical": true}', 2),
    ('loss-of-power', 'poor-acceleration', 'Poor acceleration', 'شتاب ضعیف', '{}', '{"safety_critical": false}', 3),
    ('no-start', 'engine-cranks-no-start', 'Engine cranks but will not start', 'استارت می‌خورد ولی روشن نمی‌شود', '{}', '{"safety_critical": false}', 1),
    ('no-start', 'no-crank-clicking', 'Clicking, engine does not crank', 'صدای تق‌تق و استارت نخوردن', '{}', '{"safety_critical": false}', 2),
    ('no-start', 'hard-starting', 'Hard to start', 'دیر روشن شدن', '{}', '{"safety_critical": false}', 3),
    ('no-start', 'starts-then-dies', 'Starts then dies', 'روشن می‌شود و خاموش می‌شود', '{}', '{"safety_critical": false}', 4),
    ('strange-noise', 'grinding-noise', 'Grinding noise', 'صدای ساییدگی', '{}', '{"safety_critical": false}', 1),
    ('strange-noise', 'squeaking-noise', 'Squeaking noise', 'صدای جیرجیر', '{}', '{"safety_critical": false}', 2),
    ('strange-noise', 'clunking-noise', 'Clunking over bumps', 'صدای تق‌تق در دست‌انداز', '{}', '{"safety_critical": false}', 3),
    ('strange-noise', 'knocking-engine-noise', 'Engine knocking', 'صدای ضربه از موتور', '{}', '{"safety_critical": false}', 4),
    ('strange-noise', 'whining-noise', 'Whining noise', 'صدای زوزه', '{}', '{"safety_critical": false}', 5),
    ('strange-noise', 'rattling-noise', 'Rattling noise', 'صدای جغجغه', '{}', '{"safety_critical": false}', 6),
    ('strange-noise', 'hissing-noise', 'Hissing noise', 'صدای فس‌فس', '{}', '{"safety_critical": false}', 7),
    ('strange-noise', 'clicking-when-turning', 'Clicking when turning', 'صدای تق‌تق هنگام پیچیدن', '{}', '{"safety_critical": false}', 8),
    ('strange-noise', 'humming-noise-at-speed', 'Humming that rises with speed', 'صدای وزوز که با سرعت بیشتر می‌شود', '{}', '{"safety_critical": false}', 9),
    ('strange-noise', 'loud-exhaust', 'Loud exhaust', 'صدای بلند اگزوز', '{}', '{"safety_critical": false}', 10),
    ('vibration', 'vibration-at-speed', 'Vibration at higher speed', 'لرزش در سرعت بالا', '{}', '{"safety_critical": false}', 1),
    ('vibration', 'vibration-when-braking', 'Vibration when braking', 'لرزش هنگام ترمز', '{}', '{"safety_critical": false}', 2),
    ('vibration', 'vibration-at-idle', 'Vibration at idle', 'لرزش در حالت درجا', '{}', '{"safety_critical": false}', 3),
    ('vibration', 'steering-wheel-shake', 'Steering wheel shake', 'لرزش فرمان', '{}', '{"safety_critical": false}', 4),
    ('fluid-leak', 'oil-leak', 'Oil leak', 'نشتی روغن', '{}', '{"safety_critical": false}', 1),
    ('fluid-leak', 'coolant-leak', 'Coolant leak', 'نشتی آب رادیاتور', '{}', '{"safety_critical": false}', 2),
    ('fluid-leak', 'brake-fluid-leak', 'Brake fluid leak', 'نشتی روغن ترمز', '{}', '{"safety_critical": true}', 3),
    ('fluid-leak', 'transmission-fluid-leak', 'Transmission fluid leak', 'نشتی روغن گیربکس', '{}', '{"safety_critical": false}', 4),
    ('fluid-leak', 'fuel-leak', 'Fuel leak', 'نشتی بنزین یا سوخت', '{}', '{"safety_critical": true}', 5),
    ('fluid-leak', 'power-steering-fluid-leak', 'Power steering fluid leak', 'نشتی روغن هیدرولیک فرمان', '{}', '{"safety_critical": false}', 6),
    ('fluid-leak', 'ac-water-drip', 'Water dripping under the car', 'چکه آب زیر خودرو', '{}', '{"safety_critical": false}', 7),
    ('warning-light', 'oil-pressure-light', 'Oil pressure warning light', 'چراغ هشدار فشار روغن', '{}', '{"safety_critical": true}', 1),
    ('warning-light', 'battery-warning-light', 'Battery or charging light', 'چراغ باتری (شارژ)', '{}', '{"safety_critical": false}', 2),
    ('warning-light', 'abs-warning-light', 'ABS warning light', 'چراغ هشدار ABS', '{}', '{"safety_critical": false}', 3),
    ('warning-light', 'tpms-warning-light', 'Tire pressure warning light', 'چراغ هشدار فشار باد لاستیک', '{}', '{"safety_critical": false}', 4),
    ('warning-light', 'ev-system-warning', 'EV or hybrid system warning', 'هشدار سیستم برقی یا هیبریدی', '{}', '{"safety_critical": true}', 5),
    ('unusual-smell', 'fuel-smell', 'Fuel smell', 'بوی بنزین', '{}', '{"safety_critical": true}', 1),
    ('unusual-smell', 'sweet-coolant-smell', 'Sweet smell (coolant)', 'بوی شیرین (ضدیخ)', '{}', '{"safety_critical": false}', 2),
    ('unusual-smell', 'rotten-egg-smell', 'Rotten egg smell', 'بوی تخم‌مرغ گندیده', '{}', '{"safety_critical": false}', 3),
    ('unusual-smell', 'musty-ac-smell', 'Musty smell from the vents', 'بوی نم از دریچه‌های کولر', '{}', '{"safety_critical": false}', 4),
    ('heater-or-ventilation-problem', 'heater-not-working', 'Heater not warming', 'بخاری گرم نمی‌کند', '{}', '{"safety_critical": false}', 1),
    ('heater-or-ventilation-problem', 'weak-airflow', 'Weak airflow from the vents', 'باد ضعیف دریچه‌ها', '{}', '{"safety_critical": false}', 2),
    ('heater-or-ventilation-problem', 'windows-fogging', 'Windows fog up', 'بخار گرفتن شیشه‌ها', '{}', '{"safety_critical": false}', 3),
    ('rough-running', 'rough-idle', 'Rough idle', 'درجای نامنظم موتور', '{}', '{"safety_critical": false}', 1),
    ('rough-running', 'engine-misfire', 'Engine misfire', 'ریپ زدن موتور', '{}', '{"safety_critical": false}', 2),
    ('transmission-problem', 'gear-slipping', 'Gears slipping', 'در رفتن دنده', '{}', '{"safety_critical": false}', 1),
    ('transmission-problem', 'hard-shifting', 'Hard to change gear', 'سخت جا رفتن دنده', '{}', '{"safety_critical": false}', 2),
    ('transmission-problem', 'clutch-slipping', 'Clutch slipping', 'بکسوات کلاچ', '{}', '{"safety_critical": false}', 3),
    ('transmission-problem', 'delayed-engagement', 'Delay before the gear engages', 'تأخیر در جا افتادن دنده', '{}', '{"safety_critical": false}', 4),
    ('electrical-problem', 'lights-not-working', 'Lights not working', 'چراغ‌ها کار نمی‌کنند', '{}', '{"safety_critical": false}', 1),
    ('electrical-problem', 'power-windows-not-working', 'Power windows not working', 'شیشه‌بالابر کار نمی‌کند', '{}', '{"safety_critical": false}', 2),
    ('electrical-problem', 'dashboard-dead', 'Dashboard gauges dead', 'صفحه آمپر کار نمی‌کند', '{}', '{"safety_critical": false}', 3),
    ('electrical-problem', 'flickering-lights', 'Flickering lights', 'سوسو زدن چراغ‌ها', '{}', '{"safety_critical": false}', 4),
    ('electrical-problem', 'horn-not-working', 'Horn not working', 'بوق کار نمی‌کند', '{}', '{"safety_critical": false}', 5),
    ('tire-problem', 'flat-tire', 'Flat tire', 'پنچری لاستیک', '{}', '{"safety_critical": false}', 1),
    ('tire-problem', 'uneven-tire-wear', 'Uneven tire wear', 'سایش نامنظم لاستیک', '{}', '{"safety_critical": false}', 2),
    ('tire-problem', 'low-tire-pressure', 'Tire keeps losing air', 'کم شدن باد لاستیک', '{}', '{"safety_critical": false}', 3),
    ('tire-problem', 'tire-bulge', 'Bulge on the tire sidewall', 'برآمدگی روی دیواره لاستیک', '{}', '{"safety_critical": true}', 4),
    ('body-damage', 'accident-damage', 'Accident damage', 'آسیب ناشی از تصادف', '{}', '{"safety_critical": false}', 1),
    ('body-damage', 'scratches-dents', 'Scratches and dents', 'خط و خش و فرورفتگی', '{}', '{"safety_critical": false}', 2),
    ('body-damage', 'rust', 'Rust', 'زنگ‌زدگی', '{}', '{"safety_critical": false}', 3),
    ('body-damage', 'water-leak-into-cabin', 'Water getting into the cabin', 'نفوذ آب به داخل کابین', '{}', '{"safety_critical": false}', 4),
    ('door-lock-key-problem', 'key-not-recognized', 'Key or remote not working', 'کار نکردن سوئیچ یا ریموت', '{}', '{"safety_critical": false}', 1),
    ('door-lock-key-problem', 'locked-out', 'Locked out of the car', 'قفل ماندن درب با سوئیچ داخل خودرو', '{}', '{"safety_critical": false}', 2),
    ('door-lock-key-problem', 'central-locking-fault', 'Central locking fault', 'خرابی قفل مرکزی', '{}', '{"safety_critical": false}', 3),
    ('door-lock-key-problem', 'alarm-false-triggering', 'Alarm goes off by itself', 'به صدا درآمدن بی‌دلیل دزدگیر', '{}', '{"safety_critical": false}', 4),
    ('ev-charging-problem', 'wont-charge', 'Will not charge', 'شارژ نمی‌شود', '{}', '{"safety_critical": false}', 1),
    ('ev-charging-problem', 'reduced-range', 'Reduced driving range', 'کاهش برد پیمایش', '{}', '{"safety_critical": false}', 2),
    ('ride-handling-problem', 'bouncy-ride', 'Bouncy ride', 'بالا و پایین رفتن زیاد خودرو', '{}', '{"safety_critical": false}', 1),
    ('ride-handling-problem', 'car-sits-low', 'One corner sits low', 'پایین نشستن یک گوشه خودرو', '{}', '{"safety_critical": false}', 2),
    ('ride-handling-problem', 'poor-handling', 'Unstable in corners', 'ناپایداری در پیچ', '{}', '{"safety_critical": false}', 3),
    ('glass-or-wiper-problem', 'windshield-crack', 'Cracked windshield', 'ترک شیشه جلو', '{}', '{"safety_critical": false}', 1),
    ('glass-or-wiper-problem', 'wiper-not-working', 'Wipers not working', 'برف‌پاک‌کن کار نمی‌کند', '{}', '{"safety_critical": false}', 2)
  ) AS v(parent_slug, slug, en, fa, regions, attrs, sort)
  JOIN taxonomy.taxonomy_nodes p ON p.type = 'symptom' AND p.slug = v.parent_slug;

-- Review tags
INSERT INTO taxonomy.taxonomy_nodes (created_by, type, name_translations, slug, regions, attributes, sort_order)
SELECT core.system_actor_id(), 'review_tag', jsonb_build_object('en', v.en, 'fa', v.fa), v.slug, v.regions::core.country[], v.attrs::jsonb, v.sort
  FROM (VALUES
    ('honest-pricing', 'Honest pricing', 'قیمت منصفانه', '{}', '{"sentiment": "positive", "applies_to": "both"}', 1),
    ('on-time', 'On time', 'به‌موقع', '{}', '{"sentiment": "positive", "applies_to": "both"}', 2),
    ('explained-clearly', 'Explained the work clearly', 'توضیح شفاف کار', '{}', '{"sentiment": "positive", "applies_to": "provider"}', 3),
    ('fixed-first-time', 'Fixed it the first time', 'رفع مشکل در بار اول', '{}', '{"sentiment": "positive", "applies_to": "provider"}', 4),
    ('clean-work', 'Clean work', 'کار تمیز', '{}', '{"sentiment": "positive", "applies_to": "provider"}', 5),
    ('correct-part', 'Correct part', 'قطعه درست', '{}', '{"sentiment": "positive", "applies_to": "vendor"}', 6),
    ('stock-as-listed', 'Stock as listed', 'موجودی مطابق اعلام', '{}', '{"sentiment": "positive", "applies_to": "vendor"}', 7),
    ('slow-service', 'Slow service', 'خدمات کند', '{}', '{"sentiment": "negative", "applies_to": "both"}', 8),
    ('price-above-estimate', 'Price higher than quoted', 'قیمت بیشتر از برآورد', '{}', '{"sentiment": "negative", "applies_to": "both"}', 9),
    ('poor-communication', 'Poor communication', 'ارتباط ضعیف', '{}', '{"sentiment": "negative", "applies_to": "both"}', 10),
    ('friendly-staff', 'Friendly and respectful', 'برخورد محترمانه', '{}', '{"sentiment": "positive", "applies_to": "both"}', 11),
    ('quick-response', 'Quick to respond', 'پاسخگویی سریع', '{}', '{"sentiment": "positive", "applies_to": "both"}', 12),
    ('clear-quote', 'Clear quote upfront', 'برآورد شفاف از قبل', '{}', '{"sentiment": "positive", "applies_to": "both"}', 13),
    ('warranty-honored', 'Honoured the warranty', 'پایبندی به گارانتی', '{}', '{"sentiment": "positive", "applies_to": "both"}', 14),
    ('knows-my-car', 'Knew my car well', 'تسلط به خودروی من', '{}', '{"sentiment": "positive", "applies_to": "provider"}', 15),
    ('showed-old-parts', 'Showed the replaced parts', 'نشان دادن قطعات تعویض‌شده', '{}', '{"sentiment": "positive", "applies_to": "provider"}', 16),
    ('kept-me-updated', 'Kept me updated', 'اطلاع‌رسانی مرتب از روند کار', '{}', '{"sentiment": "positive", "applies_to": "provider"}', 17),
    ('clean-workshop', 'Clean workshop', 'تعمیرگاه تمیز', '{}', '{"sentiment": "positive", "applies_to": "provider"}', 18),
    ('genuine-parts', 'Genuine parts as described', 'قطعه اصل مطابق توضیحات', '{}', '{"sentiment": "positive", "applies_to": "vendor"}', 19),
    ('fast-delivery', 'Fast delivery or pickup', 'تحویل سریع', '{}', '{"sentiment": "positive", "applies_to": "vendor"}', 20),
    ('good-packaging', 'Well packaged', 'بسته‌بندی مناسب', '{}', '{"sentiment": "positive", "applies_to": "vendor"}', 21),
    ('helpful-fitment-advice', 'Helpful fitment advice', 'راهنمایی درست برای انتخاب قطعه', '{}', '{"sentiment": "positive", "applies_to": "vendor"}', 22),
    ('busy-book-ahead', 'Busy, book ahead', 'شلوغ، از قبل نوبت بگیرید', '{}', '{"sentiment": "neutral", "applies_to": "provider"}', 23),
    ('limited-parking', 'Limited parking', 'پارکینگ محدود', '{}', '{"sentiment": "neutral", "applies_to": "both"}', 24),
    ('unfriendly-staff', 'Unfriendly staff', 'برخورد نامناسب', '{}', '{"sentiment": "negative", "applies_to": "both"}', 25),
    ('warranty-refused', 'Did not honour the warranty', 'عدم پایبندی به گارانتی', '{}', '{"sentiment": "negative", "applies_to": "both"}', 26),
    ('missed-appointment', 'Did not keep the appointment', 'عدم پایبندی به نوبت', '{}', '{"sentiment": "negative", "applies_to": "provider"}', 27),
    ('problem-not-fixed', 'Problem not fixed', 'مشکل رفع نشد', '{}', '{"sentiment": "negative", "applies_to": "provider"}', 28),
    ('unapproved-work', 'Work done without approval', 'انجام کار بدون اجازه', '{}', '{"sentiment": "negative", "applies_to": "provider"}', 29),
    ('car-returned-dirty', 'Car returned dirty', 'تحویل خودرو به‌صورت کثیف', '{}', '{"sentiment": "negative", "applies_to": "provider"}', 30),
    ('wrong-part', 'Wrong part supplied', 'قطعه اشتباه', '{}', '{"sentiment": "negative", "applies_to": "vendor"}', 31),
    ('stock-not-as-listed', 'Stock not as listed', 'موجودی مطابق اعلام نبود', '{}', '{"sentiment": "negative", "applies_to": "vendor"}', 32),
    ('part-quality-issue', 'Part quality problem', 'مشکل کیفیت قطعه', '{}', '{"sentiment": "negative", "applies_to": "vendor"}', 33),
    ('not-as-described', 'Part not as described', 'قطعه مطابق توضیحات نبود', '{}', '{"sentiment": "negative", "applies_to": "vendor"}', 34)
  ) AS v(slug, en, fa, regions, attrs, sort);

-- Amenities (52 ProviderProfile.amenity_node_ids)
INSERT INTO taxonomy.taxonomy_nodes (created_by, type, name_translations, slug, regions, attributes, sort_order)
SELECT core.system_actor_id(), 'amenity', jsonb_build_object('en', v.en, 'fa', v.fa), v.slug, v.regions::core.country[], v.attrs::jsonb, v.sort
  FROM (VALUES
    ('waiting-area', 'Waiting area', 'سالن انتظار', '{}', NULL, 1),
    ('loaner-car', 'Loaner car', 'خودروی جایگزین', '{}', NULL, 2),
    ('pickup-dropoff', 'Pickup and drop-off', 'تحویل و بازگرداندن خودرو', '{}', NULL, 3),
    ('towing-partner', 'Towing partner', 'همکاری با یدک‌کش', '{}', NULL, 4),
    ('ev-charging', 'EV charging', 'شارژ خودروی برقی', '{}', NULL, 5),
    ('wheelchair-access', 'Wheelchair access', 'دسترسی ویلچر', '{}', NULL, 6),
    ('free-wifi', 'Free Wi-Fi', 'اینترنت رایگان (وای‌فای)', '{}', NULL, 7),
    ('card-payment', 'Card payment', 'پرداخت با کارت', '{}', NULL, 8),
    ('customer-parking', 'Customer parking', 'پارکینگ مشتری', '{}', NULL, 9),
    ('after-hours-drop-off', 'After-hours key drop-off', 'تحویل خودرو خارج از ساعت کاری', '{}', NULL, 10),
    ('restroom', 'Restroom', 'سرویس بهداشتی', '{}', NULL, 11),
    ('prayer-room', 'Prayer room', 'نمازخانه', '{IR}', NULL, 12)
  ) AS v(slug, en, fa, regions, attrs, sort);

-- Synonyms, local terms and transliterations (Persian typed in Latin letters)
INSERT INTO taxonomy.taxonomy_synonyms (created_by, taxonomy_node_id, term, locale, synonym_type, script)
SELECT core.system_actor_id(), n.id, v.term, v.locale, v.kind, v.script
  FROM (VALUES
    ('symptom', 'brake-problem', 'ترمز نمی‌گیره', 'fa', 'local_term', NULL),
    ('symptom', 'brake-problem', 'tormoz nemigire', 'fa', 'transliteration', 'latin'),
    ('symptom', 'brake-problem', 'brake failure', 'en', 'synonym', NULL),
    ('symptom', 'steering-problem', 'فرمان سفت شده', 'fa', 'local_term', NULL),
    ('symptom', 'smoke', 'دود میده', 'fa', 'local_term', NULL),
    ('symptom', 'burning-smell', 'boo-ye sookhtegi', 'fa', 'transliteration', 'latin'),
    ('symptom', 'overheating', 'جوش آورده', 'fa', 'local_term', NULL),
    ('symptom', 'overheating', 'joosh avorde', 'fa', 'transliteration', 'latin'),
    ('symptom', 'overheating', 'overheat', 'en', 'abbreviation', NULL),
    ('symptom', 'check-engine-light', 'چراغ چک', 'fa', 'local_term', NULL),
    ('symptom', 'check-engine-light', 'CEL', 'en', 'abbreviation', NULL),
    ('part_category', 'brake-pads', 'lent tormoz', 'fa', 'transliteration', 'latin'),
    ('part_category', 'brake-pads', 'لنت', 'fa', 'local_term', NULL),
    ('service_task', 'oil-change', 'taviz roghan', 'fa', 'transliteration', 'latin'),
    ('service_task', 'engine-diagnostics', 'دیاگ', 'fa', 'abbreviation', NULL),
    ('service_task', 'wheel-alignment', 'tanzim farman', 'fa', 'transliteration', 'latin'),
    ('vehicle_brand', 'iran-khodro', 'IKCO', 'en', 'abbreviation', NULL),
    ('vehicle_brand', 'iran-khodro', 'ایرانخودرو', 'fa', 'misspelling', NULL),
    ('vehicle_brand', 'peugeot', 'pezho', 'fa', 'transliteration', 'latin'),
    ('vehicle_brand', 'peugeot', 'pejo', 'fa', 'transliteration', 'latin'),
    ('vehicle_brand', 'mercedes-benz', 'Mercedes', 'en', 'alias', NULL),
    ('vehicle_brand', 'mercedes-benz', 'Benz', 'en', 'alias', NULL),
    ('vehicle_brand', 'mercedes-benz', 'بنز', 'fa', 'local_term', NULL),
    ('vehicle_brand', 'volkswagen', 'VW', 'en', 'abbreviation', NULL),
    ('vehicle_brand', 'volkswagen', 'فولکس', 'fa', 'local_term', NULL),
    ('vehicle_brand', 'bmw', 'ب ام و', 'fa', 'misspelling', NULL),
    ('vehicle_brand', 'hyundai', 'هیوندا', 'fa', 'misspelling', NULL),
    ('vehicle_model', 'peugeot-pars', 'Persia', 'en', 'alias', NULL),
    ('vehicle_model', 'peugeot-pars', 'پرشیا', 'fa', 'alias', NULL),
    ('vehicle_model', 'peugeot-206', 'دویست و شش', 'fa', 'local_term', NULL),
    ('vehicle_model', 'peugeot-405', 'چهارصد و پنج', 'fa', 'local_term', NULL),
    ('vehicle_model', 'saipa-pride', 'peraid', 'fa', 'transliteration', 'latin'),
    ('vehicle_model', 'saipa-pride', 'paraid', 'fa', 'transliteration', 'latin'),
    ('vehicle_model', 'renault-logan', 'Tondar 90', 'en', 'alias', NULL),
    ('vehicle_model', 'renault-logan', 'L90', 'en', 'abbreviation', NULL),
    ('vehicle_model', 'renault-logan', 'ال90', 'fa', 'abbreviation', NULL),
    ('vehicle_model', 'renault-logan', 'تندر', 'fa', 'local_term', NULL),
    ('vehicle_model', 'zamyad-z24', 'وانت نیسان', 'fa', 'local_term', NULL),
    ('vehicle_model', 'zamyad-z24', 'Nissan Junior', 'en', 'alias', NULL),
    ('vehicle_model', 'hyundai-elantra', 'Avante', 'en', 'alias', NULL),
    ('vehicle_model', 'hyundai-elantra', 'آوانته', 'fa', 'alias', NULL),
    ('vehicle_model', 'hyundai-azera', 'Grandeur', 'en', 'alias', NULL),
    ('vehicle_model', 'toyota-land-cruiser', 'لندکروزر', 'fa', 'misspelling', NULL),
    ('vehicle_series', 'volkswagen-golf-mk7', 'Golf 7', 'en', 'alias', NULL),
    ('vehicle_series', 'volkswagen-golf-mk7', 'گلف 7', 'fa', 'alias', NULL),
    ('vehicle_series', 'volkswagen-golf-mk8', 'Golf 8', 'en', 'alias', NULL),
    ('vehicle_series', 'toyota-corolla-e210', 'TNGA', 'en', 'alias', NULL),
    ('engine_type', 'ikco-ef7', 'موتور ملی', 'fa', 'local_term', NULL),
    ('fuel_type', 'petrol', 'gasoline', 'en', 'synonym', NULL),
    ('fuel_type', 'petrol-cng', 'CNG', 'en', 'abbreviation', NULL),
    ('fuel_type', 'petrol-cng', 'دوگانه‌سوز', 'fa', 'local_term', NULL),
    ('fuel_type', 'petrol-cng', 'gazsooz', 'fa', 'transliteration', 'latin'),
    ('fuel_type', 'petrol-lpg', 'LPG', 'en', 'abbreviation', NULL),
    ('fuel_type', 'electric', 'EV', 'en', 'abbreviation', NULL),
    ('fuel_type', 'plug-in-hybrid', 'PHEV', 'en', 'abbreviation', NULL),
    ('fuel_type', 'diesel', 'گازوئیلی', 'fa', 'local_term', NULL),
    ('service_system', 'engine', 'motor', 'fa', 'transliteration', 'latin'),
    ('service_system', 'transmission', 'gearbox', 'en', 'synonym', NULL),
    ('service_system', 'transmission', 'girbox', 'fa', 'transliteration', 'latin'),
    ('service_system', 'brakes', 'tormoz', 'fa', 'transliteration', 'latin'),
    ('service_system', 'suspension', 'جلوبندی', 'fa', 'local_term', NULL),
    ('service_system', 'suspension', 'jolobandi', 'fa', 'transliteration', 'latin'),
    ('service_system', 'steering', 'farman', 'fa', 'transliteration', 'latin'),
    ('service_system', 'electrical', 'برقکاری', 'fa', 'local_term', NULL),
    ('service_system', 'electrical', 'barghkari', 'fa', 'transliteration', 'latin'),
    ('service_system', 'electrical', 'auto electrician', 'en', 'synonym', NULL),
    ('service_system', 'cooling', 'radiator', 'en', 'local_term', NULL),
    ('service_system', 'air-conditioning', 'AC', 'en', 'abbreviation', NULL),
    ('service_system', 'air-conditioning', 'A/C', 'en', 'abbreviation', NULL),
    ('service_system', 'air-conditioning', 'HVAC', 'en', 'abbreviation', NULL),
    ('service_system', 'air-conditioning', 'کولر', 'fa', 'local_term', NULL),
    ('service_system', 'air-conditioning', 'kooler', 'fa', 'transliteration', 'latin'),
    ('service_system', 'exhaust', 'egzoz', 'fa', 'transliteration', 'latin'),
    ('service_system', 'exhaust', 'اگزوزسازی', 'fa', 'local_term', NULL),
    ('service_system', 'tires-wheels', 'تایر', 'fa', 'local_term', NULL),
    ('service_system', 'tires-wheels', 'lastik', 'fa', 'transliteration', 'latin'),
    ('service_system', 'tires-wheels', 'tyres', 'en', 'misspelling', NULL),
    ('service_system', 'body-paint', 'bodywork', 'en', 'synonym', NULL),
    ('service_system', 'body-paint', 'body shop', 'en', 'synonym', NULL),
    ('service_system', 'body-paint', 'صافکاری و نقاشی', 'fa', 'local_term', NULL),
    ('service_system', 'body-paint', 'safkari naghashi', 'fa', 'transliteration', 'latin'),
    ('service_system', 'glass', 'auto glass', 'en', 'synonym', NULL),
    ('service_system', 'diagnostics', 'diagnosis', 'en', 'synonym', NULL),
    ('service_system', 'diagnostics', 'eyb yabi', 'fa', 'transliteration', 'latin'),
    ('service_system', 'ev-hybrid-system', 'EV', 'en', 'abbreviation', NULL),
    ('service_system', 'ev-hybrid-system', 'high voltage', 'en', 'synonym', NULL),
    ('service_system', 'maintenance', 'service', 'en', 'synonym', NULL),
    ('service_system', 'maintenance', 'سرویس', 'fa', 'local_term', NULL),
    ('service_system', 'maintenance', 'servis', 'fa', 'transliteration', 'latin'),
    ('service_system', 'drivetrain', 'driveline', 'en', 'synonym', NULL),
    ('service_system', 'drivetrain', 'گاردان', 'fa', 'local_term', NULL),
    ('service_system', 'electronics', 'ECU', 'en', 'abbreviation', NULL),
    ('service_system', 'electronics', 'ECM', 'en', 'abbreviation', NULL),
    ('service_system', 'electronics', 'ایسیو', 'fa', 'misspelling', NULL),
    ('service_system', 'safety-systems', 'SRS', 'en', 'abbreviation', NULL),
    ('service_system', 'safety-systems', 'airbag', 'en', 'synonym', NULL),
    ('service_system', 'safety-systems', 'ایربگ', 'fa', 'local_term', NULL),
    ('service_system', 'cng-lpg-system', 'CNG', 'en', 'abbreviation', NULL),
    ('service_system', 'cng-lpg-system', 'LPG', 'en', 'abbreviation', NULL),
    ('service_system', 'cng-lpg-system', 'گازسوز', 'fa', 'local_term', NULL),
    ('service_system', 'cng-lpg-system', 'dogane sooz', 'fa', 'transliteration', 'latin'),
    ('service_system', 'locks-security', 'locksmith', 'en', 'synonym', NULL),
    ('service_system', 'locks-security', 'دزدگیر', 'fa', 'local_term', NULL),
    ('service_system', 'interior', 'upholstery', 'en', 'synonym', NULL),
    ('service_system', 'interior', 'toodoozi', 'fa', 'transliteration', 'latin'),
    ('service_system', 'detailing', 'صفرشویی', 'fa', 'local_term', NULL),
    ('service_system', 'detailing', 'sefr shooei', 'fa', 'transliteration', 'latin'),
    ('service_system', 'detailing', 'valeting', 'en', 'synonym', NULL),
    ('service_system', 'roadside-assistance', 'breakdown service', 'en', 'synonym', NULL),
    ('service_system', 'roadside-assistance', 'امداد خودرو', 'fa', 'local_term', NULL),
    ('service_system', 'roadside-assistance', 'emdad khodro', 'fa', 'transliteration', 'latin'),
    ('service_task', 'oil-change', 'oil service', 'en', 'synonym', NULL),
    ('service_task', 'oil-change', 'lube', 'en', 'local_term', NULL),
    ('service_task', 'periodic-service', 'scheduled service', 'en', 'synonym', NULL),
    ('service_task', 'spark-plug-replacement', 'taviz sham', 'fa', 'transliteration', 'latin'),
    ('service_task', 'timing-belt', 'cam belt', 'en', 'synonym', NULL),
    ('service_task', 'timing-belt', 'tasme taym', 'fa', 'transliteration', 'latin'),
    ('service_task', 'engine-rebuild', 'overhaul', 'en', 'synonym', NULL),
    ('service_task', 'engine-rebuild', 'اورهال', 'fa', 'local_term', NULL),
    ('service_task', 'engine-rebuild', 'overhal', 'fa', 'transliteration', 'latin'),
    ('service_task', 'head-gasket-replacement', 'vasher sar silandr', 'fa', 'transliteration', 'latin'),
    ('service_task', 'engine-mount-replacement', 'daste motor', 'fa', 'transliteration', 'latin'),
    ('service_task', 'clutch-replacement', 'تعویض دیسک و صفحه', 'fa', 'local_term', NULL),
    ('service_task', 'clutch-replacement', 'disk o safhe', 'fa', 'transliteration', 'latin'),
    ('service_task', 'automatic-transmission-repair', 'گیربکس اتومات', 'fa', 'local_term', NULL),
    ('service_task', 'dual-clutch-repair', 'DSG', 'en', 'abbreviation', NULL),
    ('service_task', 'brake-pad-replacement', 'taviz lent', 'fa', 'transliteration', 'latin'),
    ('service_task', 'brake-disc-replacement', 'rotor replacement', 'en', 'synonym', NULL),
    ('service_task', 'brake-disc-resurfacing', 'rotor skimming', 'en', 'synonym', NULL),
    ('service_task', 'brake-disc-resurfacing', 'تراش دیسک', 'fa', 'local_term', NULL),
    ('service_task', 'shock-absorber-replacement', 'کمک', 'fa', 'local_term', NULL),
    ('service_task', 'shock-absorber-replacement', 'komak fanar', 'fa', 'transliteration', 'latin'),
    ('service_task', 'control-arm-replacement', 'tabagh', 'fa', 'transliteration', 'latin'),
    ('service_task', 'ball-joint-replacement', 'sibak', 'fa', 'transliteration', 'latin'),
    ('service_task', 'wheel-bearing-replacement', 'bolbering', 'fa', 'transliteration', 'latin'),
    ('service_task', 'steering-rack-repair', 'jabe farman', 'fa', 'transliteration', 'latin'),
    ('service_task', 'power-steering-repair', 'فرمان هیدرولیک', 'fa', 'local_term', NULL),
    ('service_task', 'alternator-repair', 'dinam', 'fa', 'transliteration', 'latin'),
    ('service_task', 'alternator-repair', 'generator', 'en', 'local_term', NULL),
    ('service_task', 'radiator-repair', 'رادیاتورسازی', 'fa', 'local_term', NULL),
    ('service_task', 'water-pump-replacement', 'vaterpomp', 'fa', 'transliteration', 'latin'),
    ('service_task', 'ac-recharge', 'شارژ کولر', 'fa', 'local_term', NULL),
    ('service_task', 'ac-recharge', 'sharj kooler', 'fa', 'transliteration', 'latin'),
    ('service_task', 'ac-recharge', 'AC regas', 'en', 'synonym', NULL),
    ('service_task', 'catalytic-converter-replacement', 'katalist', 'fa', 'transliteration', 'latin'),
    ('service_task', 'injector-cleaning', 'انژکتورشویی', 'fa', 'local_term', NULL),
    ('service_task', 'injector-cleaning', 'anzhektor', 'fa', 'transliteration', 'latin'),
    ('service_task', 'wheel-alignment', 'tracking', 'en', 'local_term', NULL),
    ('service_task', 'wheel-alignment', 'alignment', 'en', 'abbreviation', NULL),
    ('service_task', 'wheel-balancing', 'بالانس', 'fa', 'local_term', NULL),
    ('service_task', 'wheel-balancing', 'balans', 'fa', 'transliteration', 'latin'),
    ('service_task', 'tire-repair', 'flat tire repair', 'en', 'synonym', NULL),
    ('service_task', 'tire-repair', 'panchargiri', 'fa', 'transliteration', 'latin'),
    ('service_task', 'dent-repair', 'safkari', 'fa', 'transliteration', 'latin'),
    ('service_task', 'dent-repair', 'panel beating', 'en', 'local_term', NULL),
    ('service_task', 'painting', 'naghashi', 'fa', 'transliteration', 'latin'),
    ('service_task', 'painting', 'respray', 'en', 'synonym', NULL),
    ('service_task', 'accident-repair', 'collision repair', 'en', 'synonym', NULL),
    ('service_task', 'accident-repair', 'تعمیر تصادفی', 'fa', 'local_term', NULL),
    ('service_task', 'paintless-dent-repair', 'PDR', 'en', 'abbreviation', NULL),
    ('service_task', 'chassis-straightening', 'frame straightening', 'en', 'synonym', NULL),
    ('service_task', 'chassis-straightening', 'shasi keshi', 'fa', 'transliteration', 'latin'),
    ('service_task', 'engine-diagnostics', 'diag', 'fa', 'transliteration', 'latin'),
    ('service_task', 'diagnostic-scan', 'OBD scan', 'en', 'synonym', NULL),
    ('service_task', 'diagnostic-scan', 'code reading', 'en', 'synonym', NULL),
    ('service_task', 'pre-purchase-inspection', 'PPI', 'en', 'abbreviation', NULL),
    ('service_task', 'pre-purchase-inspection', 'کارشناسی', 'fa', 'local_term', NULL),
    ('service_task', 'pre-purchase-inspection', 'karshenasi', 'fa', 'transliteration', 'latin'),
    ('service_task', 'technical-inspection-prep', 'معاینه فنی', 'fa', 'local_term', NULL),
    ('service_task', 'technical-inspection-prep', 'MOT', 'en', 'local_term', NULL),
    ('service_task', 'cv-joint-replacement', 'polos', 'fa', 'transliteration', 'latin'),
    ('service_task', 'cv-joint-replacement', 'سرپلوس', 'fa', 'local_term', NULL),
    ('service_task', 'ecu-repair', 'ECM repair', 'en', 'synonym', NULL),
    ('service_task', 'ecu-repair', 'تعمیر ایسیو', 'fa', 'misspelling', NULL),
    ('service_task', 'cng-conversion', 'gas conversion', 'en', 'synonym', NULL),
    ('service_task', 'cng-conversion', 'دوگانه‌سوز کردن', 'fa', 'local_term', NULL),
    ('service_task', 'key-programming', 'سوئیچ‌سازی', 'fa', 'local_term', NULL),
    ('service_task', 'key-programming', 'soich sazi', 'fa', 'transliteration', 'latin'),
    ('service_task', 'paint-correction', 'polishing', 'en', 'synonym', NULL),
    ('service_task', 'paint-correction', 'پولیش', 'fa', 'local_term', NULL),
    ('service_task', 'paint-correction', 'polish', 'fa', 'transliteration', 'latin'),
    ('service_task', 'ceramic-coating', 'نانو سرامیک', 'fa', 'local_term', NULL),
    ('service_task', 'paint-protection-film', 'PPF', 'en', 'abbreviation', NULL),
    ('service_task', 'towing', 'tow truck', 'en', 'synonym', NULL),
    ('service_task', 'towing', 'یدک‌کش', 'fa', 'local_term', NULL),
    ('service_task', 'towing', 'yadak kesh', 'fa', 'transliteration', 'latin'),
    ('service_task', 'mobile-mechanic', 'مکانیک سیار', 'fa', 'local_term', NULL),
    ('part_category', 'brake-discs', 'rotors', 'en', 'synonym', NULL),
    ('part_category', 'brake-discs', 'disk tormoz', 'fa', 'transliteration', 'latin'),
    ('part_category', 'shock-absorbers', 'struts', 'en', 'synonym', NULL),
    ('part_category', 'shock-absorbers', 'komak fanar', 'fa', 'transliteration', 'latin'),
    ('part_category', 'control-arms', 'wishbone', 'en', 'synonym', NULL),
    ('part_category', 'control-arms', 'tabagh', 'fa', 'transliteration', 'latin'),
    ('part_category', 'ball-joints', 'sibak', 'fa', 'transliteration', 'latin'),
    ('part_category', 'alternators', 'dinam', 'fa', 'transliteration', 'latin'),
    ('part_category', 'water-pumps', 'vaterpomp', 'fa', 'transliteration', 'latin'),
    ('part_category', 'spark-plugs', 'sham', 'fa', 'transliteration', 'latin'),
    ('part_category', 'ignition-coils', 'koil', 'fa', 'transliteration', 'latin'),
    ('part_category', 'clutch-kits', 'دیسک و صفحه', 'fa', 'local_term', NULL),
    ('part_category', 'cv-axles', 'polos', 'fa', 'transliteration', 'latin'),
    ('part_category', 'timing-belt-kits', 'tasme taym', 'fa', 'transliteration', 'latin'),
    ('part_category', 'engine-oils', 'motor oil', 'en', 'synonym', NULL),
    ('part_category', 'engine-oils', 'roghan motor', 'fa', 'transliteration', 'latin'),
    ('part_category', 'coolants', 'antifreeze', 'en', 'synonym', NULL),
    ('part_category', 'coolants', 'zedyakh', 'fa', 'transliteration', 'latin'),
    ('part_category', 'tires', 'tyres', 'en', 'misspelling', NULL),
    ('part_category', 'tires', 'lastik', 'fa', 'transliteration', 'latin'),
    ('part_category', 'tires', 'تایر', 'fa', 'local_term', NULL),
    ('part_category', 'alloy-wheels', 'rims', 'en', 'synonym', NULL),
    ('part_category', 'alloy-wheels', 'رینگ اسپرت', 'fa', 'local_term', NULL),
    ('part_category', 'wheel-covers', 'hubcaps', 'en', 'synonym', NULL),
    ('part_category', 'headlights', 'headlamps', 'en', 'synonym', NULL),
    ('part_category', 'headlights', 'cheragh jelo', 'fa', 'transliteration', 'latin'),
    ('part_category', 'fenders', 'wings', 'en', 'local_term', NULL),
    ('part_category', 'hoods', 'bonnet', 'en', 'local_term', NULL),
    ('part_category', 'hoods', 'kapot', 'fa', 'transliteration', 'latin'),
    ('part_category', 'trunk-lids', 'boot lid', 'en', 'local_term', NULL),
    ('part_category', 'windshields', 'windscreen', 'en', 'local_term', NULL),
    ('part_category', 'batteries', 'batri', 'fa', 'transliteration', 'latin'),
    ('part_category', 'batteries', 'باطری', 'fa', 'misspelling', NULL),
    ('part_category', 'mufflers', 'silencer', 'en', 'local_term', NULL),
    ('part_category', 'catalytic-converters', 'catalyst', 'en', 'synonym', NULL),
    ('part_category', 'fuel-injectors', 'anzhektor', 'fa', 'transliteration', 'latin'),
    ('part_category', 'gas-cylinders', 'کپسول گاز', 'fa', 'local_term', NULL),
    ('part_category', 'ecus-modules', 'ECU', 'en', 'abbreviation', NULL),
    ('part_category', 'ecus-modules', 'یونیت', 'fa', 'local_term', NULL),
    ('part_category', 'instrument-clusters', 'پشت آمپر', 'fa', 'local_term', NULL),
    ('part_category', 'keys-remotes', 'سوئیچ', 'fa', 'local_term', NULL),
    ('symptom', 'soft-brake-pedal', 'spongy brakes', 'en', 'synonym', NULL),
    ('symptom', 'soft-brake-pedal', 'ترمز شل شده', 'fa', 'local_term', NULL),
    ('symptom', 'soft-brake-pedal', 'tormoz shol', 'fa', 'transliteration', 'latin'),
    ('symptom', 'brake-squeal', 'squeaky brakes', 'en', 'synonym', NULL),
    ('symptom', 'brake-squeal', 'jir jir tormoz', 'fa', 'transliteration', 'latin'),
    ('symptom', 'steering-loose', 'فرمان لق', 'fa', 'local_term', NULL),
    ('symptom', 'steering-loose', 'farman lagh', 'fa', 'transliteration', 'latin'),
    ('symptom', 'steering-heavy', 'فرمان سنگین', 'fa', 'local_term', NULL),
    ('symptom', 'pulling-to-one-side', 'ماشین یه طرف می‌کشه', 'fa', 'local_term', NULL),
    ('symptom', 'pulling-to-one-side', 'drifting to one side', 'en', 'synonym', NULL),
    ('symptom', 'blue-exhaust-smoke', 'روغن‌سوزی', 'fa', 'local_term', NULL),
    ('symptom', 'blue-exhaust-smoke', 'roghan soozi', 'fa', 'transliteration', 'latin'),
    ('symptom', 'blue-exhaust-smoke', 'burning oil', 'en', 'synonym', NULL),
    ('symptom', 'electrical-burning-smell', 'بوی سیم سوخته', 'fa', 'local_term', NULL),
    ('symptom', 'fuel-smell', 'gas smell', 'en', 'local_term', NULL),
    ('symptom', 'fuel-smell', 'booye benzin', 'fa', 'transliteration', 'latin'),
    ('symptom', 'temperature-gauge-high', 'آمپر زده بالا', 'fa', 'local_term', NULL),
    ('symptom', 'temperature-gauge-high', 'amper zade bala', 'fa', 'transliteration', 'latin'),
    ('symptom', 'coolant-loss', 'آب کم می‌کنه', 'fa', 'local_term', NULL),
    ('symptom', 'coolant-loss', 'ab kam mikone', 'fa', 'transliteration', 'latin'),
    ('symptom', 'poor-acceleration', 'ماشین نمی‌کشه', 'fa', 'local_term', NULL),
    ('symptom', 'poor-acceleration', 'nemikeshe', 'fa', 'transliteration', 'latin'),
    ('symptom', 'limp-mode', 'limp home', 'en', 'synonym', NULL),
    ('symptom', 'stalling-while-driving', 'وسط راه خاموش میشه', 'fa', 'local_term', NULL),
    ('symptom', 'no-start', 'won''t start', 'en', 'synonym', NULL),
    ('symptom', 'no-start', 'روشن نمیشه', 'fa', 'local_term', NULL),
    ('symptom', 'no-start', 'roshan nemishe', 'fa', 'transliteration', 'latin'),
    ('symptom', 'no-crank-clicking', 'استارت نمی‌خوره', 'fa', 'local_term', NULL),
    ('symptom', 'hard-starting', 'دیر روشن میشه', 'fa', 'local_term', NULL),
    ('symptom', 'hard-starting', 'dir roshan mishe', 'fa', 'transliteration', 'latin'),
    ('symptom', 'warning-light', 'dashboard light', 'en', 'synonym', NULL),
    ('symptom', 'warning-light', 'چراغ پشت آمپر', 'fa', 'local_term', NULL),
    ('symptom', 'warning-light', 'cheragh posht amper', 'fa', 'transliteration', 'latin'),
    ('symptom', 'oil-pressure-light', 'چراغ روغن', 'fa', 'local_term', NULL),
    ('symptom', 'battery-warning-light', 'چراغ دینام', 'fa', 'local_term', NULL),
    ('symptom', 'strange-noise', 'صدا میده', 'fa', 'local_term', NULL),
    ('symptom', 'strange-noise', 'seda mide', 'fa', 'transliteration', 'latin'),
    ('symptom', 'clunking-noise', 'clunk', 'en', 'abbreviation', NULL),
    ('symptom', 'clunking-noise', 'tagh tagh', 'fa', 'transliteration', 'latin'),
    ('symptom', 'knocking-engine-noise', 'pinging', 'en', 'synonym', NULL),
    ('symptom', 'clicking-when-turning', 'CV clicking', 'en', 'synonym', NULL),
    ('symptom', 'squeaking-noise', 'jir jir', 'fa', 'transliteration', 'latin'),
    ('symptom', 'vibration', 'shaking', 'en', 'synonym', NULL),
    ('symptom', 'vibration', 'larzesh', 'fa', 'transliteration', 'latin'),
    ('symptom', 'vibration-at-idle', 'لرزش درجا', 'fa', 'local_term', NULL),
    ('symptom', 'steering-wheel-shake', 'larzesh farman', 'fa', 'transliteration', 'latin'),
    ('symptom', 'oil-leak', 'روغن‌ریزی', 'fa', 'local_term', NULL),
    ('symptom', 'oil-leak', 'roghan rizi', 'fa', 'transliteration', 'latin'),
    ('symptom', 'ac-not-cooling', 'AC not cold', 'en', 'synonym', NULL),
    ('symptom', 'ac-not-cooling', 'کولر سرد نمی‌کنه', 'fa', 'local_term', NULL),
    ('symptom', 'ac-not-cooling', 'kooler sard nemikone', 'fa', 'transliteration', 'latin'),
    ('symptom', 'heater-not-working', 'بخاری گرم نمی‌کنه', 'fa', 'local_term', NULL),
    ('symptom', 'battery-drain', 'dead battery', 'en', 'synonym', NULL),
    ('symptom', 'battery-drain', 'باتری خالی می‌کنه', 'fa', 'local_term', NULL),
    ('symptom', 'battery-drain', 'batri khali mikone', 'fa', 'transliteration', 'latin'),
    ('symptom', 'engine-misfire', 'ریپ میزنه', 'fa', 'local_term', NULL),
    ('symptom', 'engine-misfire', 'rip mizane', 'fa', 'transliteration', 'latin'),
    ('symptom', 'rough-idle', 'درجا نامیزان', 'fa', 'local_term', NULL),
    ('symptom', 'high-fuel-consumption', 'بنزین زیاد می‌خوره', 'fa', 'local_term', NULL),
    ('symptom', 'high-fuel-consumption', 'benzin ziad mikhore', 'fa', 'transliteration', 'latin'),
    ('symptom', 'high-fuel-consumption', 'bad mileage', 'en', 'synonym', NULL),
    ('symptom', 'gear-slipping', 'دنده در میره', 'fa', 'local_term', NULL),
    ('symptom', 'hard-shifting', 'دنده سخت جا میره', 'fa', 'local_term', NULL),
    ('symptom', 'clutch-slipping', 'کلاچ بکسوات میکنه', 'fa', 'local_term', NULL),
    ('symptom', 'clutch-slipping', 'kelaj boksovat', 'fa', 'transliteration', 'latin'),
    ('symptom', 'flat-tire', 'پنچر شده', 'fa', 'local_term', NULL),
    ('symptom', 'flat-tire', 'panchar', 'fa', 'transliteration', 'latin'),
    ('symptom', 'flat-tire', 'puncture', 'en', 'synonym', NULL),
    ('symptom', 'tire-bulge', 'تاول لاستیک', 'fa', 'local_term', NULL),
    ('symptom', 'accident-damage', 'تصادف کردم', 'fa', 'local_term', NULL),
    ('symptom', 'accident-damage', 'crash damage', 'en', 'synonym', NULL),
    ('symptom', 'locked-out', 'سوئیچ جا مونده', 'fa', 'local_term', NULL),
    ('symptom', 'windshield-crack', 'windscreen crack', 'en', 'local_term', NULL)
  ) AS v(type, slug, term, locale, kind, script)
  JOIN taxonomy.taxonomy_nodes n ON n.type = v.type AND n.slug = v.slug;

-- Mappings used by triage, search, matching and fitment
INSERT INTO taxonomy.taxonomy_mappings (created_by, source_node_id, target_node_id, mapping_type, weight)
SELECT core.system_actor_id(), s.id, t.id, v.kind, v.weight
  FROM (VALUES
    ('symptom_to_system', 'symptom', 'brake-problem', 'service_system', 'brakes', 95),
    ('symptom_to_system', 'symptom', 'steering-problem', 'service_system', 'steering', 90),
    ('symptom_to_system', 'symptom', 'steering-problem', 'service_system', 'suspension', 40),
    ('symptom_to_system', 'symptom', 'smoke', 'service_system', 'engine', 60),
    ('symptom_to_system', 'symptom', 'smoke', 'service_system', 'cooling', 30),
    ('symptom_to_system', 'symptom', 'burning-smell', 'service_system', 'electrical', 40),
    ('symptom_to_system', 'symptom', 'burning-smell', 'service_system', 'brakes', 30),
    ('symptom_to_system', 'symptom', 'burning-smell', 'service_system', 'engine', 30),
    ('symptom_to_system', 'symptom', 'airbag-warning', 'service_system', 'electrical', 70),
    ('symptom_to_system', 'symptom', 'airbag-warning', 'service_system', 'safety-systems', 90),
    ('symptom_to_task', 'symptom', 'airbag-warning', 'service_task', 'airbag-repair', 85),
    ('symptom_to_system', 'symptom', 'overheating', 'service_system', 'cooling', 90),
    ('symptom_to_task', 'symptom', 'overheating', 'service_task', 'overheating-diagnosis', 80),
    ('symptom_to_system', 'symptom', 'loss-of-power', 'service_system', 'engine', 70),
    ('symptom_to_system', 'symptom', 'loss-of-power', 'service_system', 'fuel-system', 50),
    ('symptom_to_task', 'symptom', 'loss-of-power', 'service_task', 'engine-diagnostics', 70),
    ('symptom_to_system', 'symptom', 'no-start', 'service_system', 'electrical', 70),
    ('symptom_to_system', 'symptom', 'no-start', 'service_system', 'engine', 40),
    ('symptom_to_system', 'symptom', 'no-start', 'service_system', 'fuel-system', 40),
    ('symptom_to_system', 'symptom', 'check-engine-light', 'service_system', 'diagnostics', 80),
    ('symptom_to_system', 'symptom', 'check-engine-light', 'service_system', 'engine', 60),
    ('symptom_to_task', 'symptom', 'check-engine-light', 'service_task', 'engine-diagnostics', 85),
    ('symptom_to_system', 'symptom', 'strange-noise', 'service_system', 'suspension', 40),
    ('symptom_to_system', 'symptom', 'strange-noise', 'service_system', 'engine', 40),
    ('symptom_to_system', 'symptom', 'strange-noise', 'service_system', 'brakes', 30),
    ('symptom_to_task', 'symptom', 'strange-noise', 'service_task', 'noise-vibration-diagnosis', 70),
    ('symptom_to_system', 'symptom', 'vibration', 'service_system', 'tires-wheels', 50),
    ('symptom_to_system', 'symptom', 'vibration', 'service_system', 'suspension', 40),
    ('symptom_to_system', 'symptom', 'vibration', 'service_system', 'engine', 30),
    ('symptom_to_task', 'symptom', 'vibration', 'service_task', 'noise-vibration-diagnosis', 60),
    ('symptom_to_system', 'symptom', 'fluid-leak', 'service_system', 'engine', 50),
    ('symptom_to_system', 'symptom', 'fluid-leak', 'service_system', 'cooling', 40),
    ('symptom_to_system', 'symptom', 'fluid-leak', 'service_system', 'transmission', 30),
    ('symptom_to_system', 'symptom', 'fluid-leak', 'service_system', 'brakes', 30),
    ('symptom_to_system', 'symptom', 'ac-not-cooling', 'service_system', 'air-conditioning', 95),
    ('symptom_to_task', 'symptom', 'ac-not-cooling', 'service_task', 'ac-recharge', 70),
    ('symptom_to_task', 'symptom', 'ac-not-cooling', 'service_task', 'ac-leak-repair', 50),
    ('symptom_to_task', 'symptom', 'ac-not-cooling', 'service_task', 'ac-compressor-repair', 40),
    ('symptom_to_system', 'symptom', 'battery-drain', 'service_system', 'electrical', 90),
    ('symptom_to_task', 'symptom', 'battery-drain', 'service_task', 'battery-drain-diagnosis', 85),
    ('symptom_to_task', 'symptom', 'battery-drain', 'service_task', 'battery-replacement', 40),
    ('symptom_to_system', 'symptom', 'warning-light', 'service_system', 'diagnostics', 80),
    ('symptom_to_system', 'symptom', 'warning-light', 'service_system', 'electrical', 40),
    ('symptom_to_task', 'symptom', 'warning-light', 'service_task', 'diagnostic-scan', 80),
    ('symptom_to_system', 'symptom', 'unusual-smell', 'service_system', 'engine', 40),
    ('symptom_to_system', 'symptom', 'unusual-smell', 'service_system', 'fuel-system', 30),
    ('symptom_to_system', 'symptom', 'unusual-smell', 'service_system', 'cooling', 30),
    ('symptom_to_system', 'symptom', 'unusual-smell', 'service_system', 'air-conditioning', 20),
    ('symptom_to_system', 'symptom', 'heater-or-ventilation-problem', 'service_system', 'air-conditioning', 85),
    ('symptom_to_system', 'symptom', 'heater-or-ventilation-problem', 'service_system', 'cooling', 40),
    ('symptom_to_system', 'symptom', 'rough-running', 'service_system', 'engine', 85),
    ('symptom_to_system', 'symptom', 'rough-running', 'service_system', 'fuel-system', 50),
    ('symptom_to_task', 'symptom', 'rough-running', 'service_task', 'engine-diagnostics', 70),
    ('symptom_to_system', 'symptom', 'high-fuel-consumption', 'service_system', 'engine', 60),
    ('symptom_to_system', 'symptom', 'high-fuel-consumption', 'service_system', 'fuel-system', 60),
    ('symptom_to_system', 'symptom', 'high-fuel-consumption', 'service_system', 'tires-wheels', 20),
    ('symptom_to_task', 'symptom', 'high-fuel-consumption', 'service_task', 'engine-diagnostics', 60),
    ('symptom_to_task', 'symptom', 'high-fuel-consumption', 'service_task', 'injector-cleaning', 40),
    ('symptom_to_task', 'symptom', 'high-fuel-consumption', 'service_task', 'oxygen-sensor-replacement', 40),
    ('symptom_to_system', 'symptom', 'transmission-problem', 'service_system', 'transmission', 95),
    ('symptom_to_system', 'symptom', 'electrical-problem', 'service_system', 'electrical', 90),
    ('symptom_to_system', 'symptom', 'electrical-problem', 'service_system', 'electronics', 40),
    ('symptom_to_task', 'symptom', 'electrical-problem', 'service_task', 'electrical-diagnostics', 70),
    ('symptom_to_system', 'symptom', 'tire-problem', 'service_system', 'tires-wheels', 95),
    ('symptom_to_system', 'symptom', 'body-damage', 'service_system', 'body-paint', 95),
    ('symptom_to_system', 'symptom', 'door-lock-key-problem', 'service_system', 'locks-security', 95),
    ('symptom_to_system', 'symptom', 'ev-charging-problem', 'service_system', 'ev-hybrid-system', 95),
    ('symptom_to_system', 'symptom', 'ride-handling-problem', 'service_system', 'suspension', 90),
    ('symptom_to_system', 'symptom', 'ride-handling-problem', 'service_system', 'steering', 40),
    ('symptom_to_system', 'symptom', 'ride-handling-problem', 'service_system', 'tires-wheels', 30),
    ('symptom_to_system', 'symptom', 'glass-or-wiper-problem', 'service_system', 'glass', 90),
    ('symptom_to_system', 'symptom', 'glass-or-wiper-problem', 'service_system', 'electrical', 30),
    ('symptom_to_system', 'symptom', 'soft-brake-pedal', 'service_system', 'brakes', 95),
    ('symptom_to_task', 'symptom', 'soft-brake-pedal', 'service_task', 'brake-inspection', 70),
    ('symptom_to_task', 'symptom', 'soft-brake-pedal', 'service_task', 'brake-master-booster-repair', 60),
    ('symptom_to_task', 'symptom', 'soft-brake-pedal', 'service_task', 'brake-fluid-change', 50),
    ('symptom_to_system', 'symptom', 'brake-grinding', 'service_system', 'brakes', 95),
    ('symptom_to_task', 'symptom', 'brake-grinding', 'service_task', 'brake-pad-replacement', 80),
    ('symptom_to_task', 'symptom', 'brake-grinding', 'service_task', 'brake-disc-replacement', 60),
    ('symptom_to_system', 'symptom', 'brake-squeal', 'service_system', 'brakes', 90),
    ('symptom_to_task', 'symptom', 'brake-squeal', 'service_task', 'brake-pad-replacement', 60),
    ('symptom_to_task', 'symptom', 'brake-squeal', 'service_task', 'brake-inspection', 50),
    ('symptom_to_system', 'symptom', 'car-pulls-when-braking', 'service_system', 'brakes', 85),
    ('symptom_to_system', 'symptom', 'car-pulls-when-braking', 'service_system', 'suspension', 30),
    ('symptom_to_task', 'symptom', 'car-pulls-when-braking', 'service_task', 'brake-caliper-repair', 50),
    ('symptom_to_system', 'symptom', 'brake-warning-light', 'service_system', 'brakes', 90),
    ('symptom_to_task', 'symptom', 'brake-warning-light', 'service_task', 'brake-inspection', 70),
    ('symptom_to_task', 'symptom', 'brake-warning-light', 'service_task', 'brake-fluid-change', 30),
    ('symptom_to_system', 'symptom', 'handbrake-not-holding', 'service_system', 'brakes', 90),
    ('symptom_to_task', 'symptom', 'handbrake-not-holding', 'service_task', 'handbrake-adjustment', 80),
    ('symptom_to_system', 'symptom', 'steering-loose', 'service_system', 'steering', 85),
    ('symptom_to_system', 'symptom', 'steering-loose', 'service_system', 'suspension', 50),
    ('symptom_to_task', 'symptom', 'steering-loose', 'service_task', 'tie-rod-replacement', 60),
    ('symptom_to_task', 'symptom', 'steering-loose', 'service_task', 'steering-rack-repair', 40),
    ('symptom_to_system', 'symptom', 'steering-heavy', 'service_system', 'steering', 95),
    ('symptom_to_task', 'symptom', 'steering-heavy', 'service_task', 'power-steering-repair', 70),
    ('symptom_to_task', 'symptom', 'steering-heavy', 'service_task', 'electric-power-steering-repair', 40),
    ('symptom_to_task', 'symptom', 'steering-heavy', 'service_task', 'power-steering-fluid-service', 40),
    ('symptom_to_system', 'symptom', 'pulling-to-one-side', 'service_system', 'tires-wheels', 60),
    ('symptom_to_system', 'symptom', 'pulling-to-one-side', 'service_system', 'suspension', 50),
    ('symptom_to_system', 'symptom', 'pulling-to-one-side', 'service_system', 'steering', 40),
    ('symptom_to_system', 'symptom', 'pulling-to-one-side', 'service_system', 'brakes', 30),
    ('symptom_to_task', 'symptom', 'pulling-to-one-side', 'service_task', 'wheel-alignment', 80),
    ('symptom_to_system', 'symptom', 'steering-wheel-off-center', 'service_system', 'tires-wheels', 70),
    ('symptom_to_system', 'symptom', 'steering-wheel-off-center', 'service_system', 'steering', 40),
    ('symptom_to_task', 'symptom', 'steering-wheel-off-center', 'service_task', 'wheel-alignment', 85),
    ('symptom_to_system', 'symptom', 'steering-noise', 'service_system', 'steering', 80),
    ('symptom_to_system', 'symptom', 'steering-noise', 'service_system', 'suspension', 40),
    ('symptom_to_task', 'symptom', 'steering-noise', 'service_task', 'power-steering-repair', 50),
    ('symptom_to_system', 'symptom', 'smoke-from-engine-bay', 'service_system', 'engine', 60),
    ('symptom_to_system', 'symptom', 'smoke-from-engine-bay', 'service_system', 'cooling', 50),
    ('symptom_to_system', 'symptom', 'smoke-from-engine-bay', 'service_system', 'electrical', 40),
    ('symptom_to_system', 'symptom', 'white-exhaust-smoke', 'service_system', 'engine', 80),
    ('symptom_to_system', 'symptom', 'white-exhaust-smoke', 'service_system', 'cooling', 50),
    ('symptom_to_task', 'symptom', 'white-exhaust-smoke', 'service_task', 'head-gasket-replacement', 50),
    ('symptom_to_system', 'symptom', 'blue-exhaust-smoke', 'service_system', 'engine', 90),
    ('symptom_to_task', 'symptom', 'blue-exhaust-smoke', 'service_task', 'engine-rebuild', 40),
    ('symptom_to_task', 'symptom', 'blue-exhaust-smoke', 'service_task', 'turbo-repair', 30),
    ('symptom_to_system', 'symptom', 'black-exhaust-smoke', 'service_system', 'fuel-system', 70),
    ('symptom_to_system', 'symptom', 'black-exhaust-smoke', 'service_system', 'engine', 50),
    ('symptom_to_task', 'symptom', 'black-exhaust-smoke', 'service_task', 'injector-cleaning', 50),
    ('symptom_to_task', 'symptom', 'black-exhaust-smoke', 'service_task', 'filter-replacement', 30),
    ('symptom_to_system', 'symptom', 'electrical-burning-smell', 'service_system', 'electrical', 90),
    ('symptom_to_task', 'symptom', 'electrical-burning-smell', 'service_task', 'wiring-repair', 60),
    ('symptom_to_system', 'symptom', 'burning-oil-smell', 'service_system', 'engine', 85),
    ('symptom_to_task', 'symptom', 'burning-oil-smell', 'service_task', 'engine-oil-leak-repair', 70),
    ('symptom_to_system', 'symptom', 'burning-rubber-smell', 'service_system', 'transmission', 60),
    ('symptom_to_system', 'symptom', 'burning-rubber-smell', 'service_system', 'engine', 40),
    ('symptom_to_system', 'symptom', 'burning-rubber-smell', 'service_system', 'brakes', 40),
    ('symptom_to_task', 'symptom', 'burning-rubber-smell', 'service_task', 'clutch-replacement', 40),
    ('symptom_to_task', 'symptom', 'burning-rubber-smell', 'service_task', 'accessory-belt-replacement', 40),
    ('symptom_to_system', 'symptom', 'temperature-gauge-high', 'service_system', 'cooling', 90),
    ('symptom_to_task', 'symptom', 'temperature-gauge-high', 'service_task', 'overheating-diagnosis', 80),
    ('symptom_to_task', 'symptom', 'temperature-gauge-high', 'service_task', 'thermostat-replacement', 40),
    ('symptom_to_system', 'symptom', 'steam-from-hood', 'service_system', 'cooling', 90),
    ('symptom_to_task', 'symptom', 'steam-from-hood', 'service_task', 'radiator-repair', 50),
    ('symptom_to_task', 'symptom', 'steam-from-hood', 'service_task', 'hose-replacement', 50),
    ('symptom_to_system', 'symptom', 'coolant-loss', 'service_system', 'cooling', 85),
    ('symptom_to_system', 'symptom', 'coolant-loss', 'service_system', 'engine', 40),
    ('symptom_to_task', 'symptom', 'coolant-loss', 'service_task', 'hose-replacement', 50),
    ('symptom_to_task', 'symptom', 'coolant-loss', 'service_task', 'water-pump-replacement', 40),
    ('symptom_to_task', 'symptom', 'coolant-loss', 'service_task', 'head-gasket-replacement', 30),
    ('symptom_to_system', 'symptom', 'stalling-while-driving', 'service_system', 'engine', 70),
    ('symptom_to_system', 'symptom', 'stalling-while-driving', 'service_system', 'fuel-system', 60),
    ('symptom_to_system', 'symptom', 'stalling-while-driving', 'service_system', 'electrical', 40),
    ('symptom_to_task', 'symptom', 'stalling-while-driving', 'service_task', 'engine-diagnostics', 70),
    ('symptom_to_system', 'symptom', 'limp-mode', 'service_system', 'engine', 60),
    ('symptom_to_system', 'symptom', 'limp-mode', 'service_system', 'transmission', 50),
    ('symptom_to_system', 'symptom', 'limp-mode', 'service_system', 'electronics', 40),
    ('symptom_to_task', 'symptom', 'limp-mode', 'service_task', 'diagnostic-scan', 80),
    ('symptom_to_system', 'symptom', 'poor-acceleration', 'service_system', 'engine', 70),
    ('symptom_to_system', 'symptom', 'poor-acceleration', 'service_system', 'fuel-system', 60),
    ('symptom_to_system', 'symptom', 'poor-acceleration', 'service_system', 'transmission', 30),
    ('symptom_to_task', 'symptom', 'poor-acceleration', 'service_task', 'engine-diagnostics', 60),
    ('symptom_to_task', 'symptom', 'poor-acceleration', 'service_task', 'injector-cleaning', 40),
    ('symptom_to_system', 'symptom', 'engine-cranks-no-start', 'service_system', 'fuel-system', 70),
    ('symptom_to_system', 'symptom', 'engine-cranks-no-start', 'service_system', 'engine', 60),
    ('symptom_to_system', 'symptom', 'engine-cranks-no-start', 'service_system', 'electrical', 40),
    ('symptom_to_task', 'symptom', 'engine-cranks-no-start', 'service_task', 'engine-diagnostics', 60),
    ('symptom_to_task', 'symptom', 'engine-cranks-no-start', 'service_task', 'fuel-pump-replacement', 40),
    ('symptom_to_system', 'symptom', 'no-crank-clicking', 'service_system', 'electrical', 90),
    ('symptom_to_task', 'symptom', 'no-crank-clicking', 'service_task', 'battery-replacement', 60),
    ('symptom_to_task', 'symptom', 'no-crank-clicking', 'service_task', 'starter-repair', 60),
    ('symptom_to_system', 'symptom', 'hard-starting', 'service_system', 'engine', 60),
    ('symptom_to_system', 'symptom', 'hard-starting', 'service_system', 'fuel-system', 60),
    ('symptom_to_system', 'symptom', 'hard-starting', 'service_system', 'electrical', 50),
    ('symptom_to_task', 'symptom', 'hard-starting', 'service_task', 'engine-diagnostics', 50),
    ('symptom_to_task', 'symptom', 'hard-starting', 'service_task', 'spark-plug-replacement', 40),
    ('symptom_to_system', 'symptom', 'starts-then-dies', 'service_system', 'fuel-system', 70),
    ('symptom_to_system', 'symptom', 'starts-then-dies', 'service_system', 'engine', 60),
    ('symptom_to_system', 'symptom', 'starts-then-dies', 'service_system', 'locks-security', 30),
    ('symptom_to_task', 'symptom', 'starts-then-dies', 'service_task', 'engine-diagnostics', 60),
    ('symptom_to_system', 'symptom', 'grinding-noise', 'service_system', 'brakes', 70),
    ('symptom_to_system', 'symptom', 'grinding-noise', 'service_system', 'drivetrain', 40),
    ('symptom_to_system', 'symptom', 'grinding-noise', 'service_system', 'suspension', 30),
    ('symptom_to_task', 'symptom', 'grinding-noise', 'service_task', 'brake-pad-replacement', 50),
    ('symptom_to_system', 'symptom', 'squeaking-noise', 'service_system', 'brakes', 60),
    ('symptom_to_system', 'symptom', 'squeaking-noise', 'service_system', 'suspension', 50),
    ('symptom_to_system', 'symptom', 'squeaking-noise', 'service_system', 'engine', 30),
    ('symptom_to_task', 'symptom', 'squeaking-noise', 'service_task', 'brake-inspection', 40),
    ('symptom_to_task', 'symptom', 'squeaking-noise', 'service_task', 'accessory-belt-replacement', 30),
    ('symptom_to_system', 'symptom', 'clunking-noise', 'service_system', 'suspension', 90),
    ('symptom_to_system', 'symptom', 'clunking-noise', 'service_system', 'steering', 30),
    ('symptom_to_task', 'symptom', 'clunking-noise', 'service_task', 'suspension-repair', 70),
    ('symptom_to_task', 'symptom', 'clunking-noise', 'service_task', 'sway-bar-link-replacement', 50),
    ('symptom_to_task', 'symptom', 'clunking-noise', 'service_task', 'control-arm-replacement', 40),
    ('symptom_to_system', 'symptom', 'knocking-engine-noise', 'service_system', 'engine', 90),
    ('symptom_to_task', 'symptom', 'knocking-engine-noise', 'service_task', 'engine-diagnostics', 60),
    ('symptom_to_task', 'symptom', 'knocking-engine-noise', 'service_task', 'engine-rebuild', 30),
    ('symptom_to_system', 'symptom', 'whining-noise', 'service_system', 'steering', 50),
    ('symptom_to_system', 'symptom', 'whining-noise', 'service_system', 'transmission', 50),
    ('symptom_to_system', 'symptom', 'whining-noise', 'service_system', 'engine', 30),
    ('symptom_to_task', 'symptom', 'whining-noise', 'service_task', 'power-steering-repair', 40),
    ('symptom_to_system', 'symptom', 'rattling-noise', 'service_system', 'exhaust', 50),
    ('symptom_to_system', 'symptom', 'rattling-noise', 'service_system', 'suspension', 40),
    ('symptom_to_system', 'symptom', 'rattling-noise', 'service_system', 'body-paint', 20),
    ('symptom_to_task', 'symptom', 'rattling-noise', 'service_task', 'exhaust-repair', 40),
    ('symptom_to_system', 'symptom', 'hissing-noise', 'service_system', 'cooling', 60),
    ('symptom_to_system', 'symptom', 'hissing-noise', 'service_system', 'engine', 40),
    ('symptom_to_task', 'symptom', 'hissing-noise', 'service_task', 'engine-diagnostics', 40),
    ('symptom_to_system', 'symptom', 'clicking-when-turning', 'service_system', 'drivetrain', 90),
    ('symptom_to_task', 'symptom', 'clicking-when-turning', 'service_task', 'cv-joint-replacement', 85),
    ('symptom_to_system', 'symptom', 'humming-noise-at-speed', 'service_system', 'suspension', 70),
    ('symptom_to_system', 'symptom', 'humming-noise-at-speed', 'service_system', 'tires-wheels', 50),
    ('symptom_to_task', 'symptom', 'humming-noise-at-speed', 'service_task', 'wheel-bearing-replacement', 75),
    ('symptom_to_system', 'symptom', 'loud-exhaust', 'service_system', 'exhaust', 95),
    ('symptom_to_task', 'symptom', 'loud-exhaust', 'service_task', 'muffler-replacement', 70),
    ('symptom_to_task', 'symptom', 'loud-exhaust', 'service_task', 'exhaust-repair', 70),
    ('symptom_to_system', 'symptom', 'vibration-at-speed', 'service_system', 'tires-wheels', 80),
    ('symptom_to_system', 'symptom', 'vibration-at-speed', 'service_system', 'drivetrain', 40),
    ('symptom_to_system', 'symptom', 'vibration-at-speed', 'service_system', 'suspension', 30),
    ('symptom_to_task', 'symptom', 'vibration-at-speed', 'service_task', 'wheel-balancing', 85),
    ('symptom_to_system', 'symptom', 'vibration-when-braking', 'service_system', 'brakes', 90),
    ('symptom_to_task', 'symptom', 'vibration-when-braking', 'service_task', 'brake-disc-resurfacing', 70),
    ('symptom_to_task', 'symptom', 'vibration-when-braking', 'service_task', 'brake-disc-replacement', 60),
    ('symptom_to_system', 'symptom', 'vibration-at-idle', 'service_system', 'engine', 80),
    ('symptom_to_task', 'symptom', 'vibration-at-idle', 'service_task', 'engine-mount-replacement', 60),
    ('symptom_to_task', 'symptom', 'vibration-at-idle', 'service_task', 'spark-plug-replacement', 40),
    ('symptom_to_system', 'symptom', 'steering-wheel-shake', 'service_system', 'tires-wheels', 70),
    ('symptom_to_system', 'symptom', 'steering-wheel-shake', 'service_system', 'steering', 40),
    ('symptom_to_system', 'symptom', 'steering-wheel-shake', 'service_system', 'suspension', 40),
    ('symptom_to_task', 'symptom', 'steering-wheel-shake', 'service_task', 'wheel-balancing', 70),
    ('symptom_to_system', 'symptom', 'oil-leak', 'service_system', 'engine', 90),
    ('symptom_to_task', 'symptom', 'oil-leak', 'service_task', 'engine-oil-leak-repair', 85),
    ('symptom_to_system', 'symptom', 'coolant-leak', 'service_system', 'cooling', 95),
    ('symptom_to_task', 'symptom', 'coolant-leak', 'service_task', 'hose-replacement', 60),
    ('symptom_to_task', 'symptom', 'coolant-leak', 'service_task', 'radiator-repair', 50),
    ('symptom_to_task', 'symptom', 'coolant-leak', 'service_task', 'water-pump-replacement', 50),
    ('symptom_to_system', 'symptom', 'brake-fluid-leak', 'service_system', 'brakes', 95),
    ('symptom_to_task', 'symptom', 'brake-fluid-leak', 'service_task', 'brake-caliper-repair', 50),
    ('symptom_to_task', 'symptom', 'brake-fluid-leak', 'service_task', 'brake-master-booster-repair', 40),
    ('symptom_to_system', 'symptom', 'transmission-fluid-leak', 'service_system', 'transmission', 90),
    ('symptom_to_task', 'symptom', 'transmission-fluid-leak', 'service_task', 'transmission-fluid-change', 40),
    ('symptom_to_system', 'symptom', 'fuel-leak', 'service_system', 'fuel-system', 95),
    ('symptom_to_task', 'symptom', 'fuel-leak', 'service_task', 'fuel-leak-repair', 90),
    ('symptom_to_system', 'symptom', 'power-steering-fluid-leak', 'service_system', 'steering', 95),
    ('symptom_to_task', 'symptom', 'power-steering-fluid-leak', 'service_task', 'power-steering-repair', 70),
    ('symptom_to_system', 'symptom', 'ac-water-drip', 'service_system', 'air-conditioning', 80),
    ('symptom_to_system', 'symptom', 'oil-pressure-light', 'service_system', 'engine', 90),
    ('symptom_to_task', 'symptom', 'oil-pressure-light', 'service_task', 'engine-diagnostics', 60),
    ('symptom_to_task', 'symptom', 'oil-pressure-light', 'service_task', 'oil-change', 40),
    ('symptom_to_system', 'symptom', 'battery-warning-light', 'service_system', 'electrical', 90),
    ('symptom_to_task', 'symptom', 'battery-warning-light', 'service_task', 'alternator-repair', 70),
    ('symptom_to_task', 'symptom', 'battery-warning-light', 'service_task', 'battery-replacement', 40),
    ('symptom_to_system', 'symptom', 'abs-warning-light', 'service_system', 'brakes', 85),
    ('symptom_to_task', 'symptom', 'abs-warning-light', 'service_task', 'abs-repair', 80),
    ('symptom_to_system', 'symptom', 'tpms-warning-light', 'service_system', 'tires-wheels', 90),
    ('symptom_to_task', 'symptom', 'tpms-warning-light', 'service_task', 'tpms-service', 70),
    ('symptom_to_system', 'symptom', 'ev-system-warning', 'service_system', 'ev-hybrid-system', 95),
    ('symptom_to_task', 'symptom', 'ev-system-warning', 'service_task', 'hv-battery-diagnostics', 70),
    ('symptom_to_system', 'symptom', 'fuel-smell', 'service_system', 'fuel-system', 95),
    ('symptom_to_task', 'symptom', 'fuel-smell', 'service_task', 'fuel-leak-repair', 80),
    ('symptom_to_system', 'symptom', 'sweet-coolant-smell', 'service_system', 'cooling', 90),
    ('symptom_to_task', 'symptom', 'sweet-coolant-smell', 'service_task', 'hose-replacement', 40),
    ('symptom_to_task', 'symptom', 'sweet-coolant-smell', 'service_task', 'heater-repair', 30),
    ('symptom_to_system', 'symptom', 'rotten-egg-smell', 'service_system', 'exhaust', 80),
    ('symptom_to_system', 'symptom', 'rotten-egg-smell', 'service_system', 'engine', 30),
    ('symptom_to_task', 'symptom', 'rotten-egg-smell', 'service_task', 'catalytic-converter-replacement', 50),
    ('symptom_to_system', 'symptom', 'musty-ac-smell', 'service_system', 'air-conditioning', 95),
    ('symptom_to_task', 'symptom', 'musty-ac-smell', 'service_task', 'filter-replacement', 60),
    ('symptom_to_system', 'symptom', 'heater-not-working', 'service_system', 'cooling', 70),
    ('symptom_to_system', 'symptom', 'heater-not-working', 'service_system', 'air-conditioning', 60),
    ('symptom_to_task', 'symptom', 'heater-not-working', 'service_task', 'heater-repair', 80),
    ('symptom_to_task', 'symptom', 'heater-not-working', 'service_task', 'thermostat-replacement', 40),
    ('symptom_to_system', 'symptom', 'weak-airflow', 'service_system', 'air-conditioning', 90),
    ('symptom_to_task', 'symptom', 'weak-airflow', 'service_task', 'cabin-blower-repair', 60),
    ('symptom_to_task', 'symptom', 'weak-airflow', 'service_task', 'filter-replacement', 50),
    ('symptom_to_system', 'symptom', 'windows-fogging', 'service_system', 'air-conditioning', 80),
    ('symptom_to_task', 'symptom', 'windows-fogging', 'service_task', 'climate-control-repair', 40),
    ('symptom_to_task', 'symptom', 'windows-fogging', 'service_task', 'filter-replacement', 30),
    ('symptom_to_system', 'symptom', 'rough-idle', 'service_system', 'engine', 80),
    ('symptom_to_system', 'symptom', 'rough-idle', 'service_system', 'fuel-system', 50),
    ('symptom_to_task', 'symptom', 'rough-idle', 'service_task', 'throttle-body-cleaning', 50),
    ('symptom_to_task', 'symptom', 'rough-idle', 'service_task', 'spark-plug-replacement', 40),
    ('symptom_to_system', 'symptom', 'engine-misfire', 'service_system', 'engine', 85),
    ('symptom_to_task', 'symptom', 'engine-misfire', 'service_task', 'spark-plug-replacement', 60),
    ('symptom_to_task', 'symptom', 'engine-misfire', 'service_task', 'ignition-coil-replacement', 60),
    ('symptom_to_system', 'symptom', 'gear-slipping', 'service_system', 'transmission', 95),
    ('symptom_to_task', 'symptom', 'gear-slipping', 'service_task', 'automatic-transmission-repair', 60),
    ('symptom_to_task', 'symptom', 'gear-slipping', 'service_task', 'manual-gearbox-repair', 40),
    ('symptom_to_system', 'symptom', 'hard-shifting', 'service_system', 'transmission', 95),
    ('symptom_to_task', 'symptom', 'hard-shifting', 'service_task', 'clutch-replacement', 50),
    ('symptom_to_task', 'symptom', 'hard-shifting', 'service_task', 'shift-linkage-repair', 50),
    ('symptom_to_system', 'symptom', 'clutch-slipping', 'service_system', 'transmission', 95),
    ('symptom_to_task', 'symptom', 'clutch-slipping', 'service_task', 'clutch-replacement', 90),
    ('symptom_to_system', 'symptom', 'delayed-engagement', 'service_system', 'transmission', 95),
    ('symptom_to_task', 'symptom', 'delayed-engagement', 'service_task', 'automatic-transmission-repair', 70),
    ('symptom_to_task', 'symptom', 'delayed-engagement', 'service_task', 'transmission-fluid-change', 50),
    ('symptom_to_system', 'symptom', 'lights-not-working', 'service_system', 'electrical', 95),
    ('symptom_to_task', 'symptom', 'lights-not-working', 'service_task', 'lighting-repair', 85),
    ('symptom_to_system', 'symptom', 'power-windows-not-working', 'service_system', 'electrical', 90),
    ('symptom_to_task', 'symptom', 'power-windows-not-working', 'service_task', 'power-window-repair', 85),
    ('symptom_to_system', 'symptom', 'dashboard-dead', 'service_system', 'electronics', 70),
    ('symptom_to_system', 'symptom', 'dashboard-dead', 'service_system', 'electrical', 70),
    ('symptom_to_task', 'symptom', 'dashboard-dead', 'service_task', 'instrument-cluster-repair', 60),
    ('symptom_to_system', 'symptom', 'flickering-lights', 'service_system', 'electrical', 95),
    ('symptom_to_task', 'symptom', 'flickering-lights', 'service_task', 'alternator-repair', 50),
    ('symptom_to_task', 'symptom', 'flickering-lights', 'service_task', 'wiring-repair', 50),
    ('symptom_to_system', 'symptom', 'horn-not-working', 'service_system', 'electrical', 95),
    ('symptom_to_task', 'symptom', 'horn-not-working', 'service_task', 'wiring-repair', 50),
    ('symptom_to_system', 'symptom', 'flat-tire', 'service_system', 'tires-wheels', 95),
    ('symptom_to_system', 'symptom', 'flat-tire', 'service_system', 'roadside-assistance', 40),
    ('symptom_to_task', 'symptom', 'flat-tire', 'service_task', 'tire-repair', 85),
    ('symptom_to_task', 'symptom', 'flat-tire', 'service_task', 'mobile-tire-service', 40),
    ('symptom_to_system', 'symptom', 'uneven-tire-wear', 'service_system', 'tires-wheels', 80),
    ('symptom_to_system', 'symptom', 'uneven-tire-wear', 'service_system', 'suspension', 50),
    ('symptom_to_task', 'symptom', 'uneven-tire-wear', 'service_task', 'wheel-alignment', 80),
    ('symptom_to_task', 'symptom', 'uneven-tire-wear', 'service_task', 'tire-rotation', 40),
    ('symptom_to_system', 'symptom', 'low-tire-pressure', 'service_system', 'tires-wheels', 95),
    ('symptom_to_task', 'symptom', 'low-tire-pressure', 'service_task', 'tire-repair', 60),
    ('symptom_to_task', 'symptom', 'low-tire-pressure', 'service_task', 'tpms-service', 30),
    ('symptom_to_system', 'symptom', 'tire-bulge', 'service_system', 'tires-wheels', 95),
    ('symptom_to_task', 'symptom', 'tire-bulge', 'service_task', 'tire-replacement', 90),
    ('symptom_to_system', 'symptom', 'accident-damage', 'service_system', 'body-paint', 95),
    ('symptom_to_system', 'symptom', 'accident-damage', 'service_system', 'suspension', 30),
    ('symptom_to_task', 'symptom', 'accident-damage', 'service_task', 'accident-repair', 90),
    ('symptom_to_system', 'symptom', 'scratches-dents', 'service_system', 'body-paint', 90),
    ('symptom_to_system', 'symptom', 'scratches-dents', 'service_system', 'detailing', 40),
    ('symptom_to_task', 'symptom', 'scratches-dents', 'service_task', 'dent-repair', 70),
    ('symptom_to_task', 'symptom', 'scratches-dents', 'service_task', 'paintless-dent-repair', 50),
    ('symptom_to_task', 'symptom', 'scratches-dents', 'service_task', 'paint-correction', 40),
    ('symptom_to_system', 'symptom', 'rust', 'service_system', 'body-paint', 95),
    ('symptom_to_task', 'symptom', 'rust', 'service_task', 'rust-repair', 90),
    ('symptom_to_system', 'symptom', 'water-leak-into-cabin', 'service_system', 'body-paint', 60),
    ('symptom_to_system', 'symptom', 'water-leak-into-cabin', 'service_system', 'glass', 50),
    ('symptom_to_system', 'symptom', 'water-leak-into-cabin', 'service_system', 'interior', 30),
    ('symptom_to_system', 'symptom', 'key-not-recognized', 'service_system', 'locks-security', 95),
    ('symptom_to_system', 'symptom', 'key-not-recognized', 'service_system', 'electronics', 30),
    ('symptom_to_task', 'symptom', 'key-not-recognized', 'service_task', 'key-programming', 85),
    ('symptom_to_system', 'symptom', 'locked-out', 'service_system', 'locks-security', 95),
    ('symptom_to_system', 'symptom', 'locked-out', 'service_system', 'roadside-assistance', 40),
    ('symptom_to_task', 'symptom', 'locked-out', 'service_task', 'lockout-service', 90),
    ('symptom_to_system', 'symptom', 'central-locking-fault', 'service_system', 'locks-security', 90),
    ('symptom_to_system', 'symptom', 'central-locking-fault', 'service_system', 'electrical', 40),
    ('symptom_to_task', 'symptom', 'central-locking-fault', 'service_task', 'central-locking-repair', 85),
    ('symptom_to_system', 'symptom', 'alarm-false-triggering', 'service_system', 'locks-security', 90),
    ('symptom_to_system', 'symptom', 'alarm-false-triggering', 'service_system', 'electrical', 40),
    ('symptom_to_task', 'symptom', 'alarm-false-triggering', 'service_task', 'alarm-installation', 40),
    ('symptom_to_system', 'symptom', 'wont-charge', 'service_system', 'ev-hybrid-system', 95),
    ('symptom_to_task', 'symptom', 'wont-charge', 'service_task', 'ev-charger-repair', 80),
    ('symptom_to_system', 'symptom', 'reduced-range', 'service_system', 'ev-hybrid-system', 95),
    ('symptom_to_task', 'symptom', 'reduced-range', 'service_task', 'hv-battery-diagnostics', 85),
    ('symptom_to_system', 'symptom', 'bouncy-ride', 'service_system', 'suspension', 95),
    ('symptom_to_task', 'symptom', 'bouncy-ride', 'service_task', 'shock-absorber-replacement', 85),
    ('symptom_to_system', 'symptom', 'car-sits-low', 'service_system', 'suspension', 95),
    ('symptom_to_task', 'symptom', 'car-sits-low', 'service_task', 'spring-replacement', 70),
    ('symptom_to_task', 'symptom', 'car-sits-low', 'service_task', 'air-suspension-repair', 40),
    ('symptom_to_system', 'symptom', 'poor-handling', 'service_system', 'suspension', 70),
    ('symptom_to_system', 'symptom', 'poor-handling', 'service_system', 'steering', 50),
    ('symptom_to_system', 'symptom', 'poor-handling', 'service_system', 'tires-wheels', 50),
    ('symptom_to_task', 'symptom', 'poor-handling', 'service_task', 'suspension-repair', 50),
    ('symptom_to_task', 'symptom', 'poor-handling', 'service_task', 'wheel-alignment', 50),
    ('symptom_to_system', 'symptom', 'windshield-crack', 'service_system', 'glass', 95),
    ('symptom_to_task', 'symptom', 'windshield-crack', 'service_task', 'windshield-replacement', 70),
    ('symptom_to_task', 'symptom', 'windshield-crack', 'service_task', 'windshield-chip-repair', 60),
    ('symptom_to_system', 'symptom', 'wiper-not-working', 'service_system', 'electrical', 70),
    ('symptom_to_system', 'symptom', 'wiper-not-working', 'service_system', 'glass', 50),
    ('symptom_to_task', 'symptom', 'wiper-not-working', 'service_task', 'wiper-replacement', 50),
    ('symptom_to_task', 'symptom', 'wiper-not-working', 'service_task', 'wiring-repair', 40),
    ('part_category_to_system', 'part_category', 'brake-parts', 'service_system', 'brakes', 100),
    ('part_category_to_system', 'part_category', 'filters', 'service_system', 'maintenance', 90),
    ('part_category_to_system', 'part_category', 'engine-parts', 'service_system', 'engine', 100),
    ('part_category_to_system', 'part_category', 'suspension-parts', 'service_system', 'suspension', 100),
    ('part_category_to_system', 'part_category', 'electrical-parts', 'service_system', 'electrical', 100),
    ('part_category_to_system', 'part_category', 'batteries', 'service_system', 'electrical', 90),
    ('part_category_to_system', 'part_category', 'tires', 'service_system', 'tires-wheels', 100),
    ('part_category_to_system', 'part_category', 'lighting', 'service_system', 'electrical', 80),
    ('part_category_to_system', 'part_category', 'lighting', 'service_system', 'body-paint', 40),
    ('part_category_to_system', 'part_category', 'body-parts', 'service_system', 'body-paint', 100),
    ('part_category_to_system', 'part_category', 'fluids-oils', 'service_system', 'maintenance', 90),
    ('part_category_to_system', 'part_category', 'cooling-parts', 'service_system', 'cooling', 100),
    ('part_category_to_system', 'part_category', 'transmission-parts', 'service_system', 'transmission', 100),
    ('part_category_to_system', 'part_category', 'steering-parts', 'service_system', 'steering', 100),
    ('part_category_to_system', 'part_category', 'wheels-rims', 'service_system', 'tires-wheels', 100),
    ('part_category_to_system', 'part_category', 'glass-mirrors', 'service_system', 'glass', 100),
    ('part_category_to_system', 'part_category', 'drivetrain-parts', 'service_system', 'drivetrain', 100),
    ('part_category_to_system', 'part_category', 'exhaust-parts', 'service_system', 'exhaust', 100),
    ('part_category_to_system', 'part_category', 'fuel-system-parts', 'service_system', 'fuel-system', 100),
    ('part_category_to_system', 'part_category', 'cng-lpg-parts', 'service_system', 'cng-lpg-system', 100),
    ('part_category_to_system', 'part_category', 'ignition-parts', 'service_system', 'engine', 90),
    ('part_category_to_system', 'part_category', 'ignition-parts', 'service_system', 'maintenance', 40),
    ('part_category_to_system', 'part_category', 'sensors', 'service_system', 'engine', 50),
    ('part_category_to_system', 'part_category', 'sensors', 'service_system', 'diagnostics', 50),
    ('part_category_to_system', 'part_category', 'electronics', 'service_system', 'electronics', 100),
    ('part_category_to_system', 'part_category', 'ac-heating-parts', 'service_system', 'air-conditioning', 100),
    ('part_category_to_system', 'part_category', 'ev-hybrid-parts', 'service_system', 'ev-hybrid-system', 100),
    ('part_category_to_system', 'part_category', 'safety-parts', 'service_system', 'safety-systems', 100),
    ('part_category_to_system', 'part_category', 'interior-parts', 'service_system', 'interior', 100),
    ('part_category_to_system', 'part_category', 'brake-pads', 'service_system', 'brakes', 100),
    ('part_category_to_system', 'part_category', 'brake-discs', 'service_system', 'brakes', 100),
    ('part_category_to_system', 'part_category', 'brake-shoes', 'service_system', 'brakes', 100),
    ('part_category_to_system', 'part_category', 'brake-drums', 'service_system', 'brakes', 100),
    ('part_category_to_system', 'part_category', 'brake-calipers', 'service_system', 'brakes', 100),
    ('part_category_to_system', 'part_category', 'brake-hoses-lines', 'service_system', 'brakes', 100),
    ('part_category_to_system', 'part_category', 'brake-master-cylinders', 'service_system', 'brakes', 100),
    ('part_category_to_system', 'part_category', 'brake-boosters', 'service_system', 'brakes', 100),
    ('part_category_to_system', 'part_category', 'abs-sensors-modules', 'service_system', 'brakes', 100),
    ('part_category_to_system', 'part_category', 'handbrake-cables', 'service_system', 'brakes', 100),
    ('part_category_to_system', 'part_category', 'oil-filters', 'service_system', 'maintenance', 90),
    ('part_category_to_system', 'part_category', 'oil-filters', 'service_system', 'engine', 40),
    ('part_category_to_system', 'part_category', 'air-filters', 'service_system', 'maintenance', 90),
    ('part_category_to_system', 'part_category', 'air-filters', 'service_system', 'engine', 40),
    ('part_category_to_system', 'part_category', 'cabin-filters', 'service_system', 'maintenance', 70),
    ('part_category_to_system', 'part_category', 'cabin-filters', 'service_system', 'air-conditioning', 70),
    ('part_category_to_system', 'part_category', 'fuel-filters', 'service_system', 'fuel-system', 90),
    ('part_category_to_system', 'part_category', 'fuel-filters', 'service_system', 'maintenance', 60),
    ('part_category_to_system', 'part_category', 'timing-belt-kits', 'service_system', 'engine', 100),
    ('part_category_to_system', 'part_category', 'timing-belt-kits', 'service_system', 'maintenance', 40),
    ('part_category_to_system', 'part_category', 'accessory-belts', 'service_system', 'engine', 100),
    ('part_category_to_system', 'part_category', 'gaskets-seals', 'service_system', 'engine', 100),
    ('part_category_to_system', 'part_category', 'pistons-rings', 'service_system', 'engine', 100),
    ('part_category_to_system', 'part_category', 'engine-mounts', 'service_system', 'engine', 100),
    ('part_category_to_system', 'part_category', 'cylinder-heads', 'service_system', 'engine', 100),
    ('part_category_to_system', 'part_category', 'oil-pumps', 'service_system', 'engine', 100),
    ('part_category_to_system', 'part_category', 'valves-camshafts', 'service_system', 'engine', 100),
    ('part_category_to_system', 'part_category', 'turbochargers', 'service_system', 'engine', 100),
    ('part_category_to_system', 'part_category', 'shock-absorbers', 'service_system', 'suspension', 100),
    ('part_category_to_system', 'part_category', 'control-arms', 'service_system', 'suspension', 100),
    ('part_category_to_system', 'part_category', 'ball-joints', 'service_system', 'suspension', 100),
    ('part_category_to_system', 'part_category', 'bushings', 'service_system', 'suspension', 100),
    ('part_category_to_system', 'part_category', 'springs', 'service_system', 'suspension', 100),
    ('part_category_to_system', 'part_category', 'sway-bar-links', 'service_system', 'suspension', 100),
    ('part_category_to_system', 'part_category', 'wheel-bearings-hubs', 'service_system', 'suspension', 100),
    ('part_category_to_system', 'part_category', 'strut-mounts', 'service_system', 'suspension', 100),
    ('part_category_to_system', 'part_category', 'air-suspension-parts', 'service_system', 'suspension', 100),
    ('part_category_to_system', 'part_category', 'alternators', 'service_system', 'electrical', 100),
    ('part_category_to_system', 'part_category', 'starters', 'service_system', 'electrical', 100),
    ('part_category_to_system', 'part_category', 'wiring-harnesses', 'service_system', 'electrical', 100),
    ('part_category_to_system', 'part_category', 'fuses-relays', 'service_system', 'electrical', 100),
    ('part_category_to_system', 'part_category', 'switches', 'service_system', 'electrical', 100),
    ('part_category_to_system', 'part_category', 'power-window-motors', 'service_system', 'electrical', 100),
    ('part_category_to_system', 'part_category', 'door-lock-actuators', 'service_system', 'locks-security', 70),
    ('part_category_to_system', 'part_category', 'door-lock-actuators', 'service_system', 'electrical', 60),
    ('part_category_to_system', 'part_category', 'horns', 'service_system', 'electrical', 100),
    ('part_category_to_system', 'part_category', 'car-tires', 'service_system', 'tires-wheels', 100),
    ('part_category_to_system', 'part_category', 'suv-tires', 'service_system', 'tires-wheels', 100),
    ('part_category_to_system', 'part_category', 'van-light-truck-tires', 'service_system', 'tires-wheels', 100),
    ('part_category_to_system', 'part_category', 'winter-tires', 'service_system', 'tires-wheels', 100),
    ('part_category_to_system', 'part_category', 'headlights', 'service_system', 'electrical', 80),
    ('part_category_to_system', 'part_category', 'headlights', 'service_system', 'body-paint', 40),
    ('part_category_to_system', 'part_category', 'tail-lights', 'service_system', 'electrical', 80),
    ('part_category_to_system', 'part_category', 'tail-lights', 'service_system', 'body-paint', 40),
    ('part_category_to_system', 'part_category', 'fog-lights', 'service_system', 'electrical', 80),
    ('part_category_to_system', 'part_category', 'fog-lights', 'service_system', 'body-paint', 40),
    ('part_category_to_system', 'part_category', 'indicators', 'service_system', 'electrical', 80),
    ('part_category_to_system', 'part_category', 'indicators', 'service_system', 'body-paint', 40),
    ('part_category_to_system', 'part_category', 'bulbs', 'service_system', 'electrical', 90),
    ('part_category_to_system', 'part_category', 'bumpers', 'service_system', 'body-paint', 100),
    ('part_category_to_system', 'part_category', 'fenders', 'service_system', 'body-paint', 100),
    ('part_category_to_system', 'part_category', 'hoods', 'service_system', 'body-paint', 100),
    ('part_category_to_system', 'part_category', 'doors', 'service_system', 'body-paint', 100),
    ('part_category_to_system', 'part_category', 'body-panels', 'service_system', 'body-paint', 100),
    ('part_category_to_system', 'part_category', 'grilles', 'service_system', 'body-paint', 100),
    ('part_category_to_system', 'part_category', 'trunk-lids', 'service_system', 'body-paint', 100),
    ('part_category_to_system', 'part_category', 'body-trim', 'service_system', 'body-paint', 100),
    ('part_category_to_system', 'part_category', 'door-handles', 'service_system', 'body-paint', 100),
    ('part_category_to_system', 'part_category', 'engine-oils', 'service_system', 'maintenance', 90),
    ('part_category_to_system', 'part_category', 'engine-oils', 'service_system', 'engine', 50),
    ('part_category_to_system', 'part_category', 'transmission-fluids', 'service_system', 'transmission', 90),
    ('part_category_to_system', 'part_category', 'brake-fluids', 'service_system', 'brakes', 90),
    ('part_category_to_system', 'part_category', 'coolants', 'service_system', 'cooling', 90),
    ('part_category_to_system', 'part_category', 'power-steering-fluids', 'service_system', 'steering', 90),
    ('part_category_to_system', 'part_category', 'ac-refrigerants', 'service_system', 'air-conditioning', 95),
    ('part_category_to_system', 'part_category', 'greases-additives', 'service_system', 'maintenance', 80),
    ('part_category_to_system', 'part_category', 'radiators', 'service_system', 'cooling', 100),
    ('part_category_to_system', 'part_category', 'water-pumps', 'service_system', 'cooling', 100),
    ('part_category_to_system', 'part_category', 'thermostats', 'service_system', 'cooling', 100),
    ('part_category_to_system', 'part_category', 'cooling-fans', 'service_system', 'cooling', 100),
    ('part_category_to_system', 'part_category', 'coolant-hoses', 'service_system', 'cooling', 100),
    ('part_category_to_system', 'part_category', 'expansion-tanks', 'service_system', 'cooling', 100),
    ('part_category_to_system', 'part_category', 'clutch-kits', 'service_system', 'transmission', 100),
    ('part_category_to_system', 'part_category', 'flywheels', 'service_system', 'transmission', 100),
    ('part_category_to_system', 'part_category', 'gearbox-components', 'service_system', 'transmission', 100),
    ('part_category_to_system', 'part_category', 'shift-cables', 'service_system', 'transmission', 100),
    ('part_category_to_system', 'part_category', 'transmission-mounts', 'service_system', 'transmission', 100),
    ('part_category_to_system', 'part_category', 'steering-racks', 'service_system', 'steering', 100),
    ('part_category_to_system', 'part_category', 'tie-rods', 'service_system', 'steering', 100),
    ('part_category_to_system', 'part_category', 'tie-rods', 'service_system', 'suspension', 40),
    ('part_category_to_system', 'part_category', 'power-steering-pumps', 'service_system', 'steering', 100),
    ('part_category_to_system', 'part_category', 'alloy-wheels', 'service_system', 'tires-wheels', 100),
    ('part_category_to_system', 'part_category', 'steel-wheels', 'service_system', 'tires-wheels', 100),
    ('part_category_to_system', 'part_category', 'wheel-nuts-bolts', 'service_system', 'tires-wheels', 100),
    ('part_category_to_system', 'part_category', 'wheel-covers', 'service_system', 'tires-wheels', 100),
    ('part_category_to_system', 'part_category', 'windshields', 'service_system', 'glass', 100),
    ('part_category_to_system', 'part_category', 'side-windows', 'service_system', 'glass', 100),
    ('part_category_to_system', 'part_category', 'rear-windows', 'service_system', 'glass', 100),
    ('part_category_to_system', 'part_category', 'side-mirrors', 'service_system', 'glass', 70),
    ('part_category_to_system', 'part_category', 'side-mirrors', 'service_system', 'body-paint', 50),
    ('part_category_to_system', 'part_category', 'wiper-blades', 'service_system', 'glass', 60),
    ('part_category_to_system', 'part_category', 'wiper-blades', 'service_system', 'maintenance', 50),
    ('part_category_to_system', 'part_category', 'washer-pumps', 'service_system', 'electrical', 50),
    ('part_category_to_system', 'part_category', 'washer-pumps', 'service_system', 'glass', 50),
    ('part_category_to_system', 'part_category', 'cv-axles', 'service_system', 'drivetrain', 100),
    ('part_category_to_system', 'part_category', 'cv-boots', 'service_system', 'drivetrain', 100),
    ('part_category_to_system', 'part_category', 'driveshafts', 'service_system', 'drivetrain', 100),
    ('part_category_to_system', 'part_category', 'differential-parts', 'service_system', 'drivetrain', 100),
    ('part_category_to_system', 'part_category', 'mufflers', 'service_system', 'exhaust', 100),
    ('part_category_to_system', 'part_category', 'catalytic-converters', 'service_system', 'exhaust', 100),
    ('part_category_to_system', 'part_category', 'exhaust-pipes-manifolds', 'service_system', 'exhaust', 100),
    ('part_category_to_system', 'part_category', 'dpf-filters', 'service_system', 'exhaust', 100),
    ('part_category_to_system', 'part_category', 'fuel-pumps', 'service_system', 'fuel-system', 100),
    ('part_category_to_system', 'part_category', 'fuel-injectors', 'service_system', 'fuel-system', 100),
    ('part_category_to_system', 'part_category', 'throttle-bodies', 'service_system', 'fuel-system', 100),
    ('part_category_to_system', 'part_category', 'fuel-tanks-lines', 'service_system', 'fuel-system', 100),
    ('part_category_to_system', 'part_category', 'fuel-pressure-regulators', 'service_system', 'fuel-system', 100),
    ('part_category_to_system', 'part_category', 'gas-cylinders', 'service_system', 'cng-lpg-system', 100),
    ('part_category_to_system', 'part_category', 'gas-regulators', 'service_system', 'cng-lpg-system', 100),
    ('part_category_to_system', 'part_category', 'gas-injectors', 'service_system', 'cng-lpg-system', 100),
    ('part_category_to_system', 'part_category', 'gas-control-units', 'service_system', 'cng-lpg-system', 100),
    ('part_category_to_system', 'part_category', 'gas-valves-lines', 'service_system', 'cng-lpg-system', 100),
    ('part_category_to_system', 'part_category', 'spark-plugs', 'service_system', 'engine', 90),
    ('part_category_to_system', 'part_category', 'spark-plugs', 'service_system', 'maintenance', 40),
    ('part_category_to_system', 'part_category', 'ignition-coils', 'service_system', 'engine', 90),
    ('part_category_to_system', 'part_category', 'ignition-coils', 'service_system', 'maintenance', 40),
    ('part_category_to_system', 'part_category', 'ignition-leads', 'service_system', 'engine', 90),
    ('part_category_to_system', 'part_category', 'ignition-leads', 'service_system', 'maintenance', 40),
    ('part_category_to_system', 'part_category', 'glow-plugs', 'service_system', 'engine', 90),
    ('part_category_to_system', 'part_category', 'glow-plugs', 'service_system', 'maintenance', 40),
    ('part_category_to_system', 'part_category', 'oxygen-sensors', 'service_system', 'exhaust', 70),
    ('part_category_to_system', 'part_category', 'oxygen-sensors', 'service_system', 'engine', 60),
    ('part_category_to_system', 'part_category', 'map-maf-sensors', 'service_system', 'engine', 90),
    ('part_category_to_system', 'part_category', 'map-maf-sensors', 'service_system', 'fuel-system', 50),
    ('part_category_to_system', 'part_category', 'temperature-sensors', 'service_system', 'cooling', 70),
    ('part_category_to_system', 'part_category', 'temperature-sensors', 'service_system', 'engine', 60),
    ('part_category_to_system', 'part_category', 'position-sensors', 'service_system', 'engine', 90),
    ('part_category_to_system', 'part_category', 'parking-sensors', 'service_system', 'electronics', 90),
    ('part_category_to_system', 'part_category', 'tpms-sensors', 'service_system', 'tires-wheels', 90),
    ('part_category_to_system', 'part_category', 'ecus-modules', 'service_system', 'electronics', 100),
    ('part_category_to_system', 'part_category', 'instrument-clusters', 'service_system', 'electronics', 100),
    ('part_category_to_system', 'part_category', 'infotainment-units', 'service_system', 'electronics', 100),
    ('part_category_to_system', 'part_category', 'cameras-dashcams', 'service_system', 'electronics', 100),
    ('part_category_to_system', 'part_category', 'keys-remotes', 'service_system', 'locks-security', 90),
    ('part_category_to_system', 'part_category', 'keys-remotes', 'service_system', 'electronics', 50),
    ('part_category_to_system', 'part_category', 'alarms-immobilizers', 'service_system', 'locks-security', 95),
    ('part_category_to_system', 'part_category', 'ac-compressors', 'service_system', 'air-conditioning', 100),
    ('part_category_to_system', 'part_category', 'condensers', 'service_system', 'air-conditioning', 100),
    ('part_category_to_system', 'part_category', 'evaporators', 'service_system', 'air-conditioning', 100),
    ('part_category_to_system', 'part_category', 'heater-cores', 'service_system', 'air-conditioning', 80),
    ('part_category_to_system', 'part_category', 'heater-cores', 'service_system', 'cooling', 50),
    ('part_category_to_system', 'part_category', 'blower-motors', 'service_system', 'air-conditioning', 100),
    ('part_category_to_system', 'part_category', 'ac-hoses-valves', 'service_system', 'air-conditioning', 100),
    ('part_category_to_system', 'part_category', 'climate-control-units', 'service_system', 'air-conditioning', 100),
    ('part_category_to_system', 'part_category', 'hv-battery-modules', 'service_system', 'ev-hybrid-system', 100),
    ('part_category_to_system', 'part_category', 'charging-ports-cables', 'service_system', 'ev-hybrid-system', 100),
    ('part_category_to_system', 'part_category', 'inverters-converters', 'service_system', 'ev-hybrid-system', 100),
    ('part_category_to_system', 'part_category', 'ev-drive-motors', 'service_system', 'ev-hybrid-system', 100),
    ('part_category_to_system', 'part_category', 'airbags', 'service_system', 'safety-systems', 100),
    ('part_category_to_system', 'part_category', 'seat-belts', 'service_system', 'safety-systems', 100),
    ('part_category_to_system', 'part_category', 'airbag-sensors-modules', 'service_system', 'safety-systems', 100),
    ('part_category_to_system', 'part_category', 'seats-covers', 'service_system', 'interior', 100),
    ('part_category_to_system', 'part_category', 'floor-mats', 'service_system', 'interior', 100),
    ('part_category_to_system', 'part_category', 'dashboard-trim', 'service_system', 'interior', 100),
    ('part_category_to_system', 'part_category', 'steering-wheels', 'service_system', 'interior', 60),
    ('part_category_to_system', 'part_category', 'steering-wheels', 'service_system', 'steering', 50),
    ('part_category_to_system', 'part_category', 'car-care', 'service_system', 'detailing', 90),
    ('part_category_to_system', 'part_category', 'emergency-kits', 'service_system', 'roadside-assistance', 30),
    ('task_to_part_category', 'service_task', 'timing-belt', 'part_category', 'timing-belt-kits', 100),
    ('task_to_part_category', 'service_task', 'timing-belt', 'part_category', 'water-pumps', 50),
    ('task_to_part_category', 'service_task', 'engine-rebuild', 'part_category', 'engine-parts', 80),
    ('task_to_part_category', 'service_task', 'engine-rebuild', 'part_category', 'pistons-rings', 90),
    ('task_to_part_category', 'service_task', 'engine-rebuild', 'part_category', 'gaskets-seals', 90),
    ('task_to_part_category', 'service_task', 'engine-rebuild', 'part_category', 'valves-camshafts', 70),
    ('task_to_part_category', 'service_task', 'cylinder-head-repair', 'part_category', 'cylinder-heads', 90),
    ('task_to_part_category', 'service_task', 'cylinder-head-repair', 'part_category', 'gaskets-seals', 80),
    ('task_to_part_category', 'service_task', 'cylinder-head-repair', 'part_category', 'valves-camshafts', 70),
    ('task_to_part_category', 'service_task', 'head-gasket-replacement', 'part_category', 'gaskets-seals', 100),
    ('task_to_part_category', 'service_task', 'engine-oil-leak-repair', 'part_category', 'gaskets-seals', 90),
    ('task_to_part_category', 'service_task', 'engine-mount-replacement', 'part_category', 'engine-mounts', 100),
    ('task_to_part_category', 'service_task', 'accessory-belt-replacement', 'part_category', 'accessory-belts', 100),
    ('task_to_part_category', 'service_task', 'turbo-repair', 'part_category', 'turbochargers', 100),
    ('task_to_part_category', 'service_task', 'ignition-coil-replacement', 'part_category', 'ignition-coils', 100),
    ('task_to_part_category', 'service_task', 'engine-tune-up', 'part_category', 'spark-plugs', 70),
    ('task_to_part_category', 'service_task', 'engine-tune-up', 'part_category', 'ignition-leads', 50),
    ('task_to_part_category', 'service_task', 'engine-tune-up', 'part_category', 'air-filters', 50),
    ('task_to_part_category', 'service_task', 'engine-replacement', 'part_category', 'engine-parts', 80),
    ('task_to_part_category', 'service_task', 'clutch-replacement', 'part_category', 'clutch-kits', 100),
    ('task_to_part_category', 'service_task', 'clutch-replacement', 'part_category', 'flywheels', 50),
    ('task_to_part_category', 'service_task', 'manual-gearbox-repair', 'part_category', 'gearbox-components', 90),
    ('task_to_part_category', 'service_task', 'automatic-transmission-repair', 'part_category', 'gearbox-components', 80),
    ('task_to_part_category', 'service_task', 'automatic-transmission-repair', 'part_category', 'transmission-fluids', 60),
    ('task_to_part_category', 'service_task', 'transmission-fluid-change', 'part_category', 'transmission-fluids', 100),
    ('task_to_part_category', 'service_task', 'cvt-repair', 'part_category', 'gearbox-components', 80),
    ('task_to_part_category', 'service_task', 'cvt-repair', 'part_category', 'transmission-fluids', 60),
    ('task_to_part_category', 'service_task', 'dual-clutch-repair', 'part_category', 'gearbox-components', 80),
    ('task_to_part_category', 'service_task', 'dual-clutch-repair', 'part_category', 'clutch-kits', 50),
    ('task_to_part_category', 'service_task', 'shift-linkage-repair', 'part_category', 'shift-cables', 100),
    ('task_to_part_category', 'service_task', 'brake-pad-replacement', 'part_category', 'brake-pads', 100),
    ('task_to_part_category', 'service_task', 'brake-disc-replacement', 'part_category', 'brake-discs', 100),
    ('task_to_part_category', 'service_task', 'brake-disc-resurfacing', 'part_category', 'brake-discs', 40),
    ('task_to_part_category', 'service_task', 'brake-shoe-replacement', 'part_category', 'brake-shoes', 100),
    ('task_to_part_category', 'service_task', 'brake-shoe-replacement', 'part_category', 'brake-drums', 60),
    ('task_to_part_category', 'service_task', 'brake-fluid-change', 'part_category', 'brake-fluids', 100),
    ('task_to_part_category', 'service_task', 'brake-caliper-repair', 'part_category', 'brake-calipers', 100),
    ('task_to_part_category', 'service_task', 'brake-caliper-repair', 'part_category', 'brake-hoses-lines', 40),
    ('task_to_part_category', 'service_task', 'abs-repair', 'part_category', 'abs-sensors-modules', 100),
    ('task_to_part_category', 'service_task', 'handbrake-adjustment', 'part_category', 'handbrake-cables', 80),
    ('task_to_part_category', 'service_task', 'brake-master-booster-repair', 'part_category', 'brake-master-cylinders', 90),
    ('task_to_part_category', 'service_task', 'brake-master-booster-repair', 'part_category', 'brake-boosters', 90),
    ('task_to_part_category', 'service_task', 'brake-inspection', 'part_category', 'brake-pads', 40),
    ('task_to_part_category', 'service_task', 'brake-inspection', 'part_category', 'brake-discs', 30),
    ('task_to_part_category', 'service_task', 'suspension-repair', 'part_category', 'suspension-parts', 80),
    ('task_to_part_category', 'service_task', 'shock-absorber-replacement', 'part_category', 'shock-absorbers', 100),
    ('task_to_part_category', 'service_task', 'shock-absorber-replacement', 'part_category', 'strut-mounts', 50),
    ('task_to_part_category', 'service_task', 'control-arm-replacement', 'part_category', 'control-arms', 100),
    ('task_to_part_category', 'service_task', 'control-arm-replacement', 'part_category', 'bushings', 70),
    ('task_to_part_category', 'service_task', 'ball-joint-replacement', 'part_category', 'ball-joints', 100),
    ('task_to_part_category', 'service_task', 'sway-bar-link-replacement', 'part_category', 'sway-bar-links', 100),
    ('task_to_part_category', 'service_task', 'wheel-bearing-replacement', 'part_category', 'wheel-bearings-hubs', 100),
    ('task_to_part_category', 'service_task', 'spring-replacement', 'part_category', 'springs', 100),
    ('task_to_part_category', 'service_task', 'strut-mount-replacement', 'part_category', 'strut-mounts', 100),
    ('task_to_part_category', 'service_task', 'air-suspension-repair', 'part_category', 'air-suspension-parts', 100),
    ('task_to_part_category', 'service_task', 'power-steering-repair', 'part_category', 'power-steering-pumps', 80),
    ('task_to_part_category', 'service_task', 'power-steering-repair', 'part_category', 'steering-racks', 50),
    ('task_to_part_category', 'service_task', 'power-steering-repair', 'part_category', 'power-steering-fluids', 50),
    ('task_to_part_category', 'service_task', 'electric-power-steering-repair', 'part_category', 'steering-racks', 70),
    ('task_to_part_category', 'service_task', 'steering-rack-repair', 'part_category', 'steering-racks', 100),
    ('task_to_part_category', 'service_task', 'tie-rod-replacement', 'part_category', 'tie-rods', 100),
    ('task_to_part_category', 'service_task', 'power-steering-fluid-service', 'part_category', 'power-steering-fluids', 100),
    ('task_to_part_category', 'service_task', 'battery-replacement', 'part_category', 'batteries', 100),
    ('task_to_part_category', 'service_task', 'alternator-repair', 'part_category', 'alternators', 100),
    ('task_to_part_category', 'service_task', 'starter-repair', 'part_category', 'starters', 100),
    ('task_to_part_category', 'service_task', 'wiring-repair', 'part_category', 'wiring-harnesses', 80),
    ('task_to_part_category', 'service_task', 'wiring-repair', 'part_category', 'fuses-relays', 60),
    ('task_to_part_category', 'service_task', 'lighting-repair', 'part_category', 'bulbs', 80),
    ('task_to_part_category', 'service_task', 'lighting-repair', 'part_category', 'headlights', 60),
    ('task_to_part_category', 'service_task', 'lighting-repair', 'part_category', 'tail-lights', 50),
    ('task_to_part_category', 'service_task', 'power-window-repair', 'part_category', 'power-window-motors', 100),
    ('task_to_part_category', 'service_task', 'power-window-repair', 'part_category', 'switches', 50),
    ('task_to_part_category', 'service_task', 'battery-drain-diagnosis', 'part_category', 'batteries', 40),
    ('task_to_part_category', 'service_task', 'radiator-repair', 'part_category', 'radiators', 100),
    ('task_to_part_category', 'service_task', 'water-pump-replacement', 'part_category', 'water-pumps', 100),
    ('task_to_part_category', 'service_task', 'thermostat-replacement', 'part_category', 'thermostats', 100),
    ('task_to_part_category', 'service_task', 'coolant-flush', 'part_category', 'coolants', 100),
    ('task_to_part_category', 'service_task', 'cooling-fan-repair', 'part_category', 'cooling-fans', 100),
    ('task_to_part_category', 'service_task', 'hose-replacement', 'part_category', 'coolant-hoses', 100),
    ('task_to_part_category', 'service_task', 'overheating-diagnosis', 'part_category', 'thermostats', 40),
    ('task_to_part_category', 'service_task', 'overheating-diagnosis', 'part_category', 'coolants', 40),
    ('task_to_part_category', 'service_task', 'ac-recharge', 'part_category', 'ac-refrigerants', 100),
    ('task_to_part_category', 'service_task', 'ac-compressor-repair', 'part_category', 'ac-compressors', 100),
    ('task_to_part_category', 'service_task', 'ac-leak-repair', 'part_category', 'ac-hoses-valves', 80),
    ('task_to_part_category', 'service_task', 'ac-leak-repair', 'part_category', 'ac-refrigerants', 60),
    ('task_to_part_category', 'service_task', 'heater-repair', 'part_category', 'heater-cores', 80),
    ('task_to_part_category', 'service_task', 'heater-repair', 'part_category', 'blower-motors', 40),
    ('task_to_part_category', 'service_task', 'cabin-blower-repair', 'part_category', 'blower-motors', 100),
    ('task_to_part_category', 'service_task', 'climate-control-repair', 'part_category', 'climate-control-units', 90),
    ('task_to_part_category', 'service_task', 'condenser-evaporator-replacement', 'part_category', 'condensers', 90),
    ('task_to_part_category', 'service_task', 'condenser-evaporator-replacement', 'part_category', 'evaporators', 90),
    ('task_to_part_category', 'service_task', 'exhaust-repair', 'part_category', 'exhaust-pipes-manifolds', 80),
    ('task_to_part_category', 'service_task', 'exhaust-repair', 'part_category', 'mufflers', 60),
    ('task_to_part_category', 'service_task', 'catalytic-converter-replacement', 'part_category', 'catalytic-converters', 100),
    ('task_to_part_category', 'service_task', 'muffler-replacement', 'part_category', 'mufflers', 100),
    ('task_to_part_category', 'service_task', 'oxygen-sensor-replacement', 'part_category', 'oxygen-sensors', 100),
    ('task_to_part_category', 'service_task', 'dpf-cleaning', 'part_category', 'dpf-filters', 70),
    ('task_to_part_category', 'service_task', 'emissions-repair', 'part_category', 'catalytic-converters', 60),
    ('task_to_part_category', 'service_task', 'emissions-repair', 'part_category', 'oxygen-sensors', 60),
    ('task_to_part_category', 'service_task', 'injector-cleaning', 'part_category', 'fuel-injectors', 40),
    ('task_to_part_category', 'service_task', 'fuel-pump-replacement', 'part_category', 'fuel-pumps', 100),
    ('task_to_part_category', 'service_task', 'fuel-filter-replacement', 'part_category', 'fuel-filters', 100),
    ('task_to_part_category', 'service_task', 'throttle-body-cleaning', 'part_category', 'throttle-bodies', 40),
    ('task_to_part_category', 'service_task', 'fuel-leak-repair', 'part_category', 'fuel-tanks-lines', 70),
    ('task_to_part_category', 'service_task', 'diesel-injection-repair', 'part_category', 'fuel-injectors', 90),
    ('task_to_part_category', 'service_task', 'diesel-injection-repair', 'part_category', 'fuel-pumps', 60),
    ('task_to_part_category', 'service_task', 'tire-replacement', 'part_category', 'tires', 100),
    ('task_to_part_category', 'service_task', 'rim-repair', 'part_category', 'alloy-wheels', 50),
    ('task_to_part_category', 'service_task', 'tpms-service', 'part_category', 'tpms-sensors', 100),
    ('task_to_part_category', 'service_task', 'seasonal-tire-change', 'part_category', 'winter-tires', 80),
    ('task_to_part_category', 'service_task', 'accident-repair', 'part_category', 'body-parts', 80),
    ('task_to_part_category', 'service_task', 'accident-repair', 'part_category', 'bumpers', 70),
    ('task_to_part_category', 'service_task', 'accident-repair', 'part_category', 'headlights', 50),
    ('task_to_part_category', 'service_task', 'bumper-repair', 'part_category', 'bumpers', 80),
    ('task_to_part_category', 'service_task', 'rust-repair', 'part_category', 'body-panels', 50),
    ('task_to_part_category', 'service_task', 'panel-replacement', 'part_category', 'body-panels', 100),
    ('task_to_part_category', 'service_task', 'panel-replacement', 'part_category', 'fenders', 70),
    ('task_to_part_category', 'service_task', 'panel-replacement', 'part_category', 'doors', 60),
    ('task_to_part_category', 'service_task', 'panel-replacement', 'part_category', 'hoods', 60),
    ('task_to_part_category', 'service_task', 'windshield-replacement', 'part_category', 'windshields', 100),
    ('task_to_part_category', 'service_task', 'side-window-replacement', 'part_category', 'side-windows', 100),
    ('task_to_part_category', 'service_task', 'side-window-replacement', 'part_category', 'rear-windows', 60),
    ('task_to_part_category', 'service_task', 'mirror-replacement', 'part_category', 'side-mirrors', 100),
    ('task_to_part_category', 'service_task', 'hv-battery-repair', 'part_category', 'hv-battery-modules', 100),
    ('task_to_part_category', 'service_task', 'hybrid-system-service', 'part_category', 'inverters-converters', 50),
    ('task_to_part_category', 'service_task', 'ev-charger-repair', 'part_category', 'charging-ports-cables', 90),
    ('task_to_part_category', 'service_task', 'electric-motor-repair', 'part_category', 'ev-drive-motors', 100),
    ('task_to_part_category', 'service_task', 'oil-change', 'part_category', 'fluids-oils', 90),
    ('task_to_part_category', 'service_task', 'oil-change', 'part_category', 'filters', 80),
    ('task_to_part_category', 'service_task', 'oil-change', 'part_category', 'engine-oils', 95),
    ('task_to_part_category', 'service_task', 'oil-change', 'part_category', 'oil-filters', 95),
    ('task_to_part_category', 'service_task', 'periodic-service', 'part_category', 'engine-oils', 80),
    ('task_to_part_category', 'service_task', 'periodic-service', 'part_category', 'oil-filters', 80),
    ('task_to_part_category', 'service_task', 'periodic-service', 'part_category', 'air-filters', 70),
    ('task_to_part_category', 'service_task', 'periodic-service', 'part_category', 'cabin-filters', 60),
    ('task_to_part_category', 'service_task', 'periodic-service', 'part_category', 'spark-plugs', 50),
    ('task_to_part_category', 'service_task', 'filter-replacement', 'part_category', 'filters', 100),
    ('task_to_part_category', 'service_task', 'filter-replacement', 'part_category', 'oil-filters', 80),
    ('task_to_part_category', 'service_task', 'filter-replacement', 'part_category', 'air-filters', 80),
    ('task_to_part_category', 'service_task', 'filter-replacement', 'part_category', 'cabin-filters', 80),
    ('task_to_part_category', 'service_task', 'filter-replacement', 'part_category', 'fuel-filters', 60),
    ('task_to_part_category', 'service_task', 'fluid-top-up', 'part_category', 'fluids-oils', 90),
    ('task_to_part_category', 'service_task', 'spark-plug-replacement', 'part_category', 'spark-plugs', 100),
    ('task_to_part_category', 'service_task', 'wiper-replacement', 'part_category', 'wiper-blades', 100),
    ('task_to_part_category', 'service_task', 'seasonal-check', 'part_category', 'coolants', 50),
    ('task_to_part_category', 'service_task', 'seasonal-check', 'part_category', 'wiper-blades', 40),
    ('task_to_part_category', 'service_task', 'seasonal-check', 'part_category', 'batteries', 40),
    ('task_to_part_category', 'service_task', 'cv-joint-replacement', 'part_category', 'cv-axles', 100),
    ('task_to_part_category', 'service_task', 'cv-joint-replacement', 'part_category', 'cv-boots', 80),
    ('task_to_part_category', 'service_task', 'driveshaft-repair', 'part_category', 'driveshafts', 100),
    ('task_to_part_category', 'service_task', 'differential-repair', 'part_category', 'differential-parts', 100),
    ('task_to_part_category', 'service_task', 'awd-system-repair', 'part_category', 'differential-parts', 70),
    ('task_to_part_category', 'service_task', 'awd-system-repair', 'part_category', 'driveshafts', 50),
    ('task_to_part_category', 'service_task', 'ecu-repair', 'part_category', 'ecus-modules', 100),
    ('task_to_part_category', 'service_task', 'ecu-programming', 'part_category', 'ecus-modules', 60),
    ('task_to_part_category', 'service_task', 'instrument-cluster-repair', 'part_category', 'instrument-clusters', 100),
    ('task_to_part_category', 'service_task', 'infotainment-repair', 'part_category', 'infotainment-units', 100),
    ('task_to_part_category', 'service_task', 'accessory-electronics-installation', 'part_category', 'cameras-dashcams', 70),
    ('task_to_part_category', 'service_task', 'parking-sensor-installation', 'part_category', 'parking-sensors', 100),
    ('task_to_part_category', 'service_task', 'parking-sensor-installation', 'part_category', 'cameras-dashcams', 60),
    ('task_to_part_category', 'service_task', 'airbag-repair', 'part_category', 'airbags', 100),
    ('task_to_part_category', 'service_task', 'airbag-repair', 'part_category', 'airbag-sensors-modules', 80),
    ('task_to_part_category', 'service_task', 'seatbelt-repair', 'part_category', 'seat-belts', 100),
    ('task_to_part_category', 'service_task', 'cng-conversion', 'part_category', 'gas-cylinders', 90),
    ('task_to_part_category', 'service_task', 'cng-conversion', 'part_category', 'gas-regulators', 90),
    ('task_to_part_category', 'service_task', 'cng-conversion', 'part_category', 'gas-injectors', 80),
    ('task_to_part_category', 'service_task', 'cng-conversion', 'part_category', 'gas-control-units', 80),
    ('task_to_part_category', 'service_task', 'gas-system-repair', 'part_category', 'gas-regulators', 70),
    ('task_to_part_category', 'service_task', 'gas-system-repair', 'part_category', 'gas-injectors', 70),
    ('task_to_part_category', 'service_task', 'gas-system-repair', 'part_category', 'gas-valves-lines', 60),
    ('task_to_part_category', 'service_task', 'gas-cylinder-inspection', 'part_category', 'gas-cylinders', 60),
    ('task_to_part_category', 'service_task', 'gas-regulator-service', 'part_category', 'gas-regulators', 100),
    ('task_to_part_category', 'service_task', 'key-programming', 'part_category', 'keys-remotes', 100),
    ('task_to_part_category', 'service_task', 'alarm-installation', 'part_category', 'alarms-immobilizers', 100),
    ('task_to_part_category', 'service_task', 'central-locking-repair', 'part_category', 'door-lock-actuators', 100),
    ('task_to_part_category', 'service_task', 'upholstery-repair', 'part_category', 'seats-covers', 60),
    ('task_to_part_category', 'service_task', 'seat-cover-installation', 'part_category', 'seats-covers', 100),
    ('task_to_part_category', 'service_task', 'dashboard-repair', 'part_category', 'dashboard-trim', 80),
    ('task_to_part_category', 'service_task', 'car-wash', 'part_category', 'car-care', 60),
    ('task_to_part_category', 'service_task', 'interior-detailing', 'part_category', 'car-care', 50),
    ('task_to_part_category', 'service_task', 'paint-correction', 'part_category', 'car-care', 60),
    ('task_to_part_category', 'service_task', 'ceramic-coating', 'part_category', 'car-care', 60),
    ('task_to_part_category', 'service_task', 'headlight-restoration', 'part_category', 'car-care', 50),
    ('task_to_part_category', 'service_task', 'jump-start', 'part_category', 'batteries', 30),
    ('task_to_part_category', 'service_task', 'mobile-tire-service', 'part_category', 'tires', 40)
  ) AS v(kind, src_type, src, tgt_type, tgt, weight)
  JOIN taxonomy.taxonomy_nodes s ON s.type = v.src_type AND s.slug = v.src
  JOIN taxonomy.taxonomy_nodes t ON t.type = v.tgt_type AND t.slug = v.tgt;

DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM taxonomy.taxonomy_nodes;
  IF n <> 694 THEN RAISE EXCEPTION 'taxonomy seed: expected 694 nodes, found %', n; END IF;
  SELECT count(*) INTO n FROM taxonomy.taxonomy_synonyms;
  IF n <> 301 THEN RAISE EXCEPTION 'taxonomy seed: expected 301 synonyms, found %', n; END IF;
  SELECT count(*) INTO n FROM taxonomy.taxonomy_mappings;
  IF n <> 741 THEN RAISE EXCEPTION 'taxonomy seed: expected 741 mappings, found %', n; END IF;
END
$$;

INSERT INTO core.schema_info (component, version, note)
VALUES ('carpal', '1.0.0', 'Initial installation from 42.db_setup.sql (API contract 1.0.0, data dictionary 52)');

RESET ROLE;

\echo '== 23. Analytics database'

-- =============================================================================
-- 23. Analytics database (Plan §2): pseudonymous product events and daily
--     aggregates, fed by the analytics-pipeline worker (W12). No personal data,
--     no foreign keys to the primary database.
-- =============================================================================
\connect :analytics_db_name

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'analytics_db_name') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO carpal_analytics_writer, carpal_analytics_reader, carpal_migrator', :'analytics_db_name') \gexec
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SELECT format('ALTER ROLE carpal_analytics_reader IN DATABASE %I SET default_transaction_read_only = on', :'analytics_db_name') \gexec

SET ROLE carpal_owner;

CREATE SCHEMA events;
COMMENT ON SCHEMA events IS 'Module analytics (WP16): pseudonymous product events (52 AnalyticsEvent)';

CREATE TABLE events.analytics_events (
  id                    uuid NOT NULL DEFAULT gen_random_uuid(),
  event_name            text NOT NULL CHECK (event_name ~ '^[a-z_]+(\.[a-z_]+)+$' AND char_length(event_name) <= 80),
  schema_version        integer NOT NULL CHECK (schema_version BETWEEN 1 AND 100),
  occurred_at           timestamptz NOT NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),
  actor_pseudonymous_id text CHECK (actor_pseudonymous_id ~ '^[0-9a-f]{64}$'),   -- never a raw user ID
  organization_id       uuid,
  session_id            text CHECK (char_length(session_id) <= 64),
  platform              text NOT NULL CHECK (platform IN ('ios','android','web_pwa','web_portal','backend')),
  app_version           text CHECK (char_length(app_version) <= 20),
  locale                text CHECK (locale ~ '^[a-z]{2}$'),
  country               text CHECK (country ~ '^[A-Z]{2}$'),
  properties            jsonb CHECK (properties IS NULL OR jsonb_typeof(properties) = 'object'),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE TABLE events.analytics_events_default PARTITION OF events.analytics_events DEFAULT;
CREATE INDEX analytics_events_name_idx ON events.analytics_events (event_name, occurred_at);
CREATE INDEX analytics_events_org_idx ON events.analytics_events (organization_id, occurred_at) WHERE organization_id IS NOT NULL;

CREATE TABLE events.daily_metrics (
  metric_date   date NOT NULL,
  metric_key    text NOT NULL CHECK (metric_key ~ '^[a-z0-9_.]{1,80}$'),
  dimension_key text NOT NULL DEFAULT '' CHECK (char_length(dimension_key) <= 200),  -- e.g. 'region=IR;org_type=provider'
  value         numeric(18,4) NOT NULL,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (metric_date, metric_key, dimension_key)
);
COMMENT ON TABLE events.daily_metrics IS 'Aggregates behind admin.analytics_dashboard (40 §23.5)';

CREATE FUNCTION events.ensure_monthly_partitions(p_months_ahead int DEFAULT 3) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  m date; part text; created integer := 0;
BEGIN
  FOR i IN 0 .. least(greatest(p_months_ahead, 0), 24) LOOP
    m := (date_trunc('month', now()) + make_interval(months => i))::date;
    part := format('analytics_events_y%sm%s', to_char(m, 'YYYY'), to_char(m, 'MM'));
    IF to_regclass(format('events.%I', part)) IS NULL THEN
      EXECUTE format('CREATE TABLE events.%I PARTITION OF events.analytics_events FOR VALUES FROM (%L) TO (%L)',
                     part, m, (m + interval '1 month')::date);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$$;
SELECT events.ensure_monthly_partitions(3) AS event_partitions \gset

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA events FROM PUBLIC;
GRANT USAGE ON SCHEMA events TO carpal_analytics_writer, carpal_analytics_reader;
GRANT INSERT ON events.analytics_events TO carpal_analytics_writer;
GRANT SELECT, INSERT, UPDATE ON events.daily_metrics TO carpal_analytics_writer;
GRANT SELECT ON events.analytics_events, events.daily_metrics TO carpal_analytics_reader;
GRANT EXECUTE ON FUNCTION events.ensure_monthly_partitions(int) TO carpal_analytics_writer;

RESET ROLE;

\echo '== CarPal database setup complete.'
\echo 'Next: set login passwords through the secret manager, then complete the bootstrap admin sign-up (password reset + WebAuthn).'
