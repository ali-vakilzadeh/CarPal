-- Backend S21 (contract 1.4.0, admin console BR-17): admin.system_health counts failed notification deliveries and
-- files the virus scan could not check over the last 30 days by the time they failed. Both are rare, so two small
-- partial indexes keep the dashboard's counts off the full tables. Docs/43.db_setup.sql has the same indexes.
-- Idempotent, because a fresh install already has them and still runs this file once.

CREATE INDEX IF NOT EXISTS notification_deliveries_failed_idx ON notification.notification_deliveries (updated_at)
  WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS media_assets_scan_failed_idx ON media.media_assets (updated_at)
  WHERE scan_status = 'failed';
