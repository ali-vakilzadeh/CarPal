#!/usr/bin/env bash
# Update step 1: copy the uploaded repository from the staging folder (WinSCP target) into the
# production code folder, and link the code to the data folders outside it.
#
#   sudo bash 1-sync.sh             sync (the service must be stopped: 0-predeploy.sh)
#   sudo bash 1-sync.sh --dry-run   show what would change, change nothing
#
# Only SYNC_DIRS (backend Docs shared database) are copied; files deleted in staging are deleted in
# production. Never copied, never deleted: node_modules, dist, .data, .tools, .env, .git, logs.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root
start_log

DRY=()
if [[ "${1:-}" == "--dry-run" ]]; then DRY=(--dry-run --itemize-changes); fi

# ------------------------------------------------------------------- preconditions
step "Checking $STAGING_DIR"
[[ -f "$STAGING_DIR/backend/package.json" ]] || die "$STAGING_DIR/backend/package.json not found: upload the repository root (the folder holding backend/, Docs/, shared/) to $STAGING_DIR"
grep -q '"name": "@carpal/backend"' "$STAGING_DIR/backend/package.json" || die "$STAGING_DIR/backend is not the CarPal backend"
for d in $SYNC_DIRS; do [[ -d "$STAGING_DIR/$d" ]] || die "$STAGING_DIR/$d is missing"; done
if [[ -e "$STAGING_DIR/backend/.data" ]]; then
  warn "$STAGING_DIR/backend/.data was uploaded (a developer's local database and files): it is ignored; delete it to save space"
fi
if [[ ${#DRY[@]} -eq 0 ]] && service_installed && service_active; then
  [[ "${ALLOW_LIVE_SYNC:-0}" == "1" ]] || die "$SERVICE_NAME is running: run 0-predeploy.sh first (or ALLOW_LIVE_SYNC=1)"
fi
ok "staging holds the CarPal repository"

# ---------------------------------------------------------------------------- sync
install -d -m 750 -o root -g "$SERVICE_GROUP" "$SRC_DIR"
EXCLUDES=(
  --exclude=node_modules/
  --exclude=/dist/
  --exclude=.data
  --exclude=.tools/
  --exclude=.env
  --exclude='.env.*'
  --exclude=.git/
  --exclude=coverage/
  --exclude='*.log'
  --exclude=.DS_Store
  --exclude=Thumbs.db
)
# Keep the example env file (documentation), not a real one.
INCLUDES=(--include=.env.example)
for d in $SYNC_DIRS; do
  step "Sync $d/"
  rsync -a --delete --human-readable --stats "${DRY[@]}" "${INCLUDES[@]}" "${EXCLUDES[@]}" \
    "$STAGING_DIR/$d/" "$SRC_DIR/$d/" | grep -E '^(Number of (created|deleted|regular) files|Total transferred file size|[<>ch*][fdLDS.+]|\*deleting)' || true
done

if [[ ${#DRY[@]} -gt 0 ]]; then
  ok "dry run: nothing changed"
  finish
  exit 0
fi

# Scripts edited on Windows may carry CRLF line ends, which bash cannot run.
find "$BACKEND_DIR/deploy" -type f \( -name '*.sh' -o -name '*.conf*' -o -name '*.service' -o -name '*.template' \) -exec sed -i 's/\r$//' {} +

# --------------------------------------------------------------- data outside the code
# The backend keeps lite-mode runtime files in backend/.data (fixed path) and media objects in
# backend/.data/objects. Both are links to the folders outside the code tree.
step "Linking data folders"
install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$DATA_DIR" "$UPLOAD_DIR"
if [[ -e "$BACKEND_DIR/.data" && ! -L "$BACKEND_DIR/.data" ]]; then
  die "$BACKEND_DIR/.data is a real folder; move its contents to $DATA_DIR (objects/ to $UPLOAD_DIR) and remove it"
fi
ln -sfn "$DATA_DIR" "$BACKEND_DIR/.data"
if [[ -e "$DATA_DIR/objects" && ! -L "$DATA_DIR/objects" ]]; then
  die "$DATA_DIR/objects is a real folder; move its contents to $UPLOAD_DIR and remove it"
fi
ln -sfn "$UPLOAD_DIR" "$DATA_DIR/objects"
chown -h "$SERVICE_USER:$SERVICE_GROUP" "$DATA_DIR/objects"
ok "$BACKEND_DIR/.data -> $DATA_DIR, $DATA_DIR/objects -> $UPLOAD_DIR"

# ----------------------------------------------------------------------- release
{
  echo "synced_at=$(date --iso-8601=seconds)"
  echo "staging_mtime=$(stat -c %y "$STAGING_DIR/backend/package.json")"
  echo "package_version=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$BACKEND_DIR/package.json" | head -1)"
  echo "contract_sha256=$(sed -n 's/.*"sourceSha256": "\([0-9a-f]*\)".*/\1/p' "$BACKEND_DIR/libs/contract/generated/operations.json" | head -1)"
} >"$SRC_DIR/.release"
ok "release marker $SRC_DIR/.release"
finish
