#!/usr/bin/env bash
# Update step 0: stop the backend, prepare permissions for the backup, back up code, configuration,
# databases, runtime data and uploads into /carpal/backups/<timestamp>/, prune old backups.
#
#   sudo bash 0-predeploy.sh            stop + full backup
#   sudo bash 0-predeploy.sh --no-stop  backup while running (databases are still consistent: pg_dump snapshot)
#
# Not needed for the first deployment (nothing to back up yet); every step skips what does not exist.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root
start_log
cd /

STOP=1
if [[ "${1:-}" == "--no-stop" ]]; then STOP=0; fi

TS="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/$TS"
PREV="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' 2>/dev/null | sort | tail -n 1 || true)"

# ------------------------------------------------------------------------ stop
if [[ $STOP == 1 ]] && service_installed && service_active; then
  step "Stopping $SERVICE_NAME"
  systemctl stop "$SERVICE_NAME"
  ok "stopped (lite mode keeps sessions in memory: users sign in again after the restart)"
elif [[ $STOP == 0 ]]; then
  step "Backing up while $SERVICE_NAME keeps running (--no-stop)"
else
  step "$SERVICE_NAME is not running: nothing to stop"
fi

# ------------------------------------------------------------- permissions for backup
# root reads everything already; this makes the result predictable: a private backup folder, and a
# code tree root can overwrite in 1-sync.sh even if a file was left read-only.
step "Preparing permissions"
install -d -m 700 -o root -g root "$BACKUP_DIR" "$DEST"
if [[ -d "$SRC_DIR" ]]; then chmod -R u+rwX "$SRC_DIR"; fi
ok "backup folder $DEST"

# ------------------------------------------------------------------------- code
if [[ -f "$BACKEND_DIR/package.json" ]]; then
  step "Code -> code.tar.gz"
  excludes=(--exclude="./backend/.data")
  if [[ "$BACKUP_NODE_MODULES" != "1" ]]; then excludes+=(--exclude="./backend/node_modules"); fi
  tar -czf "$DEST/code.tar.gz" -C "$SRC_DIR" "${excludes[@]}" .
  ok "$(du -h "$DEST/code.tar.gz" | cut -f1) (dist included; node_modules $([[ "$BACKUP_NODE_MODULES" == "1" ]] && echo included || echo excluded))"
else
  warn "no code in $SRC_DIR yet: skipped"
fi

# ----------------------------------------------------------------------- config
if [[ -d "$CONFIG_DIR" ]]; then
  step "Configuration -> config.tar.gz (secrets: keep this backup private)"
  tar -czf "$DEST/config.tar.gz" -C "$CARPAL_ROOT" "$(basename "$CONFIG_DIR")"
  ok "config saved"
fi

# --------------------------------------------------------------------- databases
if pg_active; then
  step "Databases -> $DB_NAME.dump, $ANALYTICS_DB_NAME.dump, globals.sql"
  for db in "$DB_NAME" "$ANALYTICS_DB_NAME"; do
    if runuser -u postgres -- psql -p "$PG_PORT" -Atc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1; then
      runuser -u postgres -- pg_dump -p "$PG_PORT" -Fc -d "$db" >"$DEST/$db.dump"
      ok "$db: $(du -h "$DEST/$db.dump" | cut -f1)"
    else
      warn "database $db does not exist yet: skipped"
    fi
  done
  # Roles and their password hashes (the CarPal login roles are cluster-wide).
  runuser -u postgres -- pg_dumpall -p "$PG_PORT" --globals-only >"$DEST/globals.sql"
  ok "globals (roles) saved"
else
  warn "PostgreSQL ($(pg_unit)) is not running: databases NOT backed up"
fi

# ------------------------------------------------------------ runtime data + uploads
if [[ -d "$DATA_DIR" ]]; then
  step "Runtime data -> data.tar.gz (mail/SMS/push outbox, dead letters)"
  tar -czf "$DEST/data.tar.gz" -C "$DATA_DIR" --exclude=./objects .
  ok "data saved"
fi
if [[ -d "$UPLOAD_DIR" ]]; then
  step "Uploads -> upload/ (hard links to the previous backup for unchanged files)"
  link=()
  if [[ -n "$PREV" && -d "$PREV/upload" ]]; then link=(--link-dest="$PREV/upload"); fi
  rsync -a "${link[@]}" "$UPLOAD_DIR/" "$DEST/upload/"
  ok "$(find "$DEST/upload" -type f | wc -l) files"
fi

# ------------------------------------------------------------------- manifest
{
  echo "created=$(date --iso-8601=seconds)"
  echo "host=$(hostname)"
  echo "service_was_stopped=$STOP"
  if [[ -f "$SRC_DIR/.release" ]]; then sed 's/^/release./' "$SRC_DIR/.release"; fi
} >"$DEST/MANIFEST"
# shellcheck disable=SC2094 # SHA256SUMS is excluded from the file list it is written from
(cd "$DEST" && find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%f\n' | sort | xargs -r sha256sum >SHA256SUMS)

# ----------------------------------------------------------------------- prune
mapfile -t all < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort)
if ((${#all[@]} > KEEP_BACKUPS)); then
  step "Pruning backups (keeping $KEEP_BACKUPS)"
  for old in "${all[@]:0:${#all[@]}-KEEP_BACKUPS}"; do
    rm -rf --one-file-system "$old"
    ok "removed $(basename "$old")"
  done
fi

ok "backup $DEST: $(du -sh "$DEST" | cut -f1); free on $(df -h --output=target "$BACKUP_DIR" | tail -1): $(df -h --output=avail "$BACKUP_DIR" | tail -1 | tr -d ' ')"
finish
