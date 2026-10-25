#!/usr/bin/env bash
# Update step 3: set owners and modes so each service reaches exactly what it needs.
#
#   code    /carpal/backend/src   root:carpal  dirs 750, files 640 (executables keep x)  service: read only
#   config  /carpal/config        root:carpal  750; backend.env 640, deploy.conf 640, db-admin.env root 600
#   data    /carpal/data          carpal:carpal 750/640                                  service: read + write
#   uploads /carpal/upload        carpal:carpal 750/640                                  service: read + write
#   db      /carpal/db            postgres:postgres 700 (PostgreSQL refuses anything looser)
#   backups /carpal/backups       root 700        logs /carpal/logs root 750
#
#   sudo bash 3-permissions.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root
start_log

id -u "$SERVICE_USER" >/dev/null 2>&1 || die "user $SERVICE_USER missing (run server-setup.sh)"

step "Top level"
chown root:root "$CARPAL_ROOT" && chmod 755 "$CARPAL_ROOT"
install -d -m 750 -o root -g "$SERVICE_GROUP" "$(dirname "$SRC_DIR")"
ok "$CARPAL_ROOT 755 (traversable; every folder below is restricted)"

step "Code (read-only for $SERVICE_USER)"
chown -R -h root:"$SERVICE_GROUP" "$SRC_DIR"
# X keeps execute on folders and on files that already have it (node_modules/.bin, PostgreSQL tools).
chmod -R u=rwX,g=rX,o= "$SRC_DIR"
chmod 750 "$BACKEND_DIR"/deploy/*.sh
# The data links belong to the service user (the link itself; the targets are handled below).
if [[ -L "$BACKEND_DIR/.data" ]]; then chown -h "$SERVICE_USER:$SERVICE_GROUP" "$BACKEND_DIR/.data"; fi
ok "$SRC_DIR"

step "Configuration"
install -d -m 750 -o root -g "$SERVICE_GROUP" "$CONFIG_DIR"
for f in backend.env deploy.conf; do
  if [[ -f "$CONFIG_DIR/$f" ]]; then chown root:"$SERVICE_GROUP" "$CONFIG_DIR/$f" && chmod 640 "$CONFIG_DIR/$f"; fi
done
if [[ -f "$CONFIG_DIR/db-admin.env" ]]; then chown root:root "$CONFIG_DIR/db-admin.env" && chmod 600 "$CONFIG_DIR/db-admin.env"; fi
ok "$CONFIG_DIR"

step "Data and uploads (read + write for $SERVICE_USER)"
for d in "$DATA_DIR" "$UPLOAD_DIR"; do
  install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$d"
  chown -R -h "$SERVICE_USER:$SERVICE_GROUP" "$d"
  chmod -R u=rwX,g=rX,o= "$d"
done
ok "$DATA_DIR, $UPLOAD_DIR"

step "Database folder"
if [[ -d "$DB_DIR" ]]; then
  chown postgres:postgres "$DB_DIR"
  chmod 700 "$DB_DIR"
  # Only the top folder: PostgreSQL manages the modes inside its data directory itself.
  ok "$DB_DIR postgres 700"
fi

step "Backups and logs"
install -d -m 700 -o root -g root "$BACKUP_DIR"
install -d -m 750 -o root -g root "$LOG_DIR"
ok "$BACKUP_DIR 700, $LOG_DIR 750"

step "Access check as $SERVICE_USER"
runuser -u "$SERVICE_USER" -- test -r "$BACKEND_DIR/dist/apps/dev/main.js" || die "$SERVICE_USER cannot read dist/ (build first)"
runuser -u "$SERVICE_USER" -- test -r "$CONFIG_DIR/backend.env" || die "$SERVICE_USER cannot read backend.env"
runuser -u "$SERVICE_USER" -- test -w "$BACKEND_DIR/.data/" || die "$SERVICE_USER cannot write $BACKEND_DIR/.data"
runuser -u "$SERVICE_USER" -- test -w "$BACKEND_DIR/.data/objects/" || die "$SERVICE_USER cannot write uploads"
if runuser -u "$SERVICE_USER" -- test -r "$CONFIG_DIR/db-admin.env"; then die "$SERVICE_USER can read db-admin.env"; fi
if runuser -u "$SERVICE_USER" -- test -w "$BACKEND_DIR/package.json"; then die "$SERVICE_USER can write the code"; fi
ok "reads code and config, writes data and uploads, cannot read the superuser login or change the code"
finish
