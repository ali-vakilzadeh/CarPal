-- Backend S18 (contract 1.4.0, admin console BR-32, BR-27, BR-33, BR-29): moderation queues and content context.
-- The Docs/23 A-CON-01 severity floor (unsafe_advice, non_consensual_media and privacy cases are at least high) becomes
-- a trigger on admin.moderation_cases, so no path can open or change such a case below high, and the open cases below
-- the floor are raised. trust.disputes records who resolved a dispute (admin.my_decisions_list), and the moderation
-- log gets an index by actor for the same read.
-- Docs/43.db_setup.sql has the same function, trigger, column and indexes. Idempotent, because a fresh install already
-- has the baseline's objects and still runs this file once.

CREATE OR REPLACE FUNCTION admin.tg_moderation_case_severity_floor() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.reason IN ('unsafe_advice','non_consensual_media','privacy') AND NEW.severity IN ('low','medium') THEN
    NEW.severity := 'high';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS moderation_cases_severity_floor ON admin.moderation_cases;
CREATE TRIGGER moderation_cases_severity_floor BEFORE INSERT OR UPDATE OF reason, severity ON admin.moderation_cases
  FOR EACH ROW EXECUTE FUNCTION admin.tg_moderation_case_severity_floor();

-- Open cases below the floor (closed cases keep their history).
UPDATE admin.moderation_cases SET severity = 'high'
 WHERE reason IN ('unsafe_advice','non_consensual_media','privacy') AND severity IN ('low','medium')
   AND status IN ('open','investigating','escalated') AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS moderation_actions_actor_idx ON admin.moderation_actions (actor_user_id, created_at);

ALTER TABLE trust.disputes ADD COLUMN IF NOT EXISTS resolved_by uuid;
CREATE INDEX IF NOT EXISTS disputes_resolver_idx ON trust.disputes (resolved_by, resolved_at) WHERE resolved_by IS NOT NULL;

-- Disputes resolved before this migration: the staff member of their status_changed audit entry.
UPDATE trust.disputes d SET resolved_by = a.actor_id
  FROM (SELECT DISTINCT ON (entity_id) entity_id, actor_id
          FROM analytics.audit_logs
         WHERE action = 'dispute.status_changed' AND entity_type = 'dispute' AND actor_type = 'platform_staff'
           AND new_state_summary LIKE 'resolved\_%'
         ORDER BY entity_id, created_at DESC) a
 WHERE d.id = a.entity_id AND d.resolved_by IS NULL AND d.status IN ('resolved_upheld','resolved_rejected');
