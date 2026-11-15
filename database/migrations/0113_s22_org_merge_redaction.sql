-- Backend S22 (contract 1.4.0, admin console BR-08, BR-15): organization merge and staff redaction.
-- admin.org_merge runs as a background job after approval (kind organization_merge, result the surviving
-- organization), and admin.case_action records the moderation action apply_redaction (boxes on an image; the
-- media worker replaces the public copy). Only three CHECK constraints change; no table or column is added.
-- Docs/43.db_setup.sql has the same constraints. Idempotent, because a fresh install already has them and still
-- runs this file once.

ALTER TABLE core.background_jobs DROP CONSTRAINT IF EXISTS background_jobs_kind_check;
ALTER TABLE core.background_jobs ADD CONSTRAINT background_jobs_kind_check CHECK (kind IN ('ai_insight','inventory_import',
  'fleet_import','fleet_export','data_export','pre_visit_report','bulk_inventory_update','taxonomy_merge','redaction',
  'organization_merge'));

ALTER TABLE core.background_jobs DROP CONSTRAINT IF EXISTS background_jobs_result_type_check;
ALTER TABLE core.background_jobs ADD CONSTRAINT background_jobs_result_type_check CHECK (result_type IN ('ai_insight',
  'inventory_import_batch','fleet_import_batch','fleet_export','data_subject_request','pre_visit_report','match_session',
  'media_asset','taxonomy_node','organization'));

ALTER TABLE admin.moderation_actions DROP CONSTRAINT IF EXISTS moderation_actions_action_type_check;
ALTER TABLE admin.moderation_actions ADD CONSTRAINT moderation_actions_action_type_check CHECK (action_type IN ('approve','hide',
  'remove','restore','request_changes','warn_user','suspend_account','reactivate_account','verify_organization',
  'reject_verification','merge_duplicate','revoke_badge','apply_trust_penalty','confirm_review_approval',
  'reject_review_approval','request_evidence','correct_location','assist_onboarding','reduce_weight','edit_request',
  'downgrade_fitment','request_verification_info','correct_profile','apply_redaction'));
