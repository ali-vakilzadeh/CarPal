-- Backend S25a (contract 1.4.0; owner decisions of 2026-11-16, S17-D4): the rest of the Docs/23 A-NOTIF-01 rules and
-- the Delivery health tab.
--   notification_rules   review-approval reminders to businesses (Path 2, days after the request, default 3 and 6),
--                        the maintenance reminder due window (days before the due date, default 14) and the mileage
--                        due window (km before the due mileage, default 500): the values the code used before S25a.
--   reviews              business_reminder_count: Path 2 reminders already sent (never repeated).
--   deliveries           provider: the sender that took each attempt (Delivery health groups by channel and provider);
--                        a partial index keeps the 30-day counts off the full table.
-- Docs/43.db_setup.sql has the same columns, constraints and index. Idempotent, because a fresh install already has
-- them and still runs this file once.

ALTER TABLE notification.notification_rules
  ADD COLUMN IF NOT EXISTS review_approval_reminder_days integer[] NOT NULL DEFAULT '{3,6}' CHECK (
    cardinality(review_approval_reminder_days) <= 3 AND array_position(review_approval_reminder_days, NULL) IS NULL
    AND 1 <= ALL (review_approval_reminder_days) AND 6 >= ALL (review_approval_reminder_days)),
  ADD COLUMN IF NOT EXISTS maintenance_due_window_days integer NOT NULL DEFAULT 14
    CHECK (maintenance_due_window_days BETWEEN 1 AND 90),
  ADD COLUMN IF NOT EXISTS mileage_due_window_km integer NOT NULL DEFAULT 500
    CHECK (mileage_due_window_km BETWEEN 50 AND 5000);

ALTER TABLE trust.reviews
  ADD COLUMN IF NOT EXISTS business_reminder_count integer NOT NULL DEFAULT 0
    CHECK (business_reminder_count BETWEEN 0 AND 3);

ALTER TABLE notification.notification_deliveries
  ADD COLUMN IF NOT EXISTS provider text CHECK (provider ~ '^[a-z0-9_]{1,40}$');

CREATE INDEX IF NOT EXISTS notification_deliveries_attempted_idx ON notification.notification_deliveries (updated_at)
  WHERE status IN ('sent','delivered','failed');
