#!/usr/bin/env bash
# Deploys the admin console code uploaded to the staging folder (WinSCP) as a new release.
#
#   sudo bash /home/root/staging/frontend/admin-console/deploy/admin-update.sh
#
# Steps: preflight (staging copy, admin.env, backend up and serving at least the console's contract version) → copy
# frontend/admin-console/ and shared/ from staging → stop the service → move the current release to
# /carpal/backups/admin-<time> → pnpm install (frozen lockfile), checks, next build → permissions → start → health check
# (the signed-out page and a BFF session). A release that fails to build or start is replaced by the previous one
# (AUTO_ROLLBACK=1). The console is down from the stop to the end of the health check (a few minutes), and the restart
# signs every staff member out (in-memory sessions, D-112).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root
[[ "$DOMAIN" != "example.com" ]] || die "set DOMAIN in $SHARED_CONF first (run admin-setup.sh)"
start_log
cd /

TS="$(date +%Y%m%d-%H%M%S)"
PREVIOUS="$BACKUP_DIR/admin-$TS"
NEW="$ADMIN_ROOT/src.new"
STAGED_APP="$STAGING_DIR/frontend/admin-console"

# ------------------------------------------------------------------------- preflight
step "Preflight"
for d in $ADMIN_SYNC_DIRS; do [[ -d "$STAGING_DIR/$d" ]] || die "missing $STAGING_DIR/$d (upload the repository first)"; done
[[ -f "$STAGED_APP/package.json" && -f "$STAGED_APP/pnpm-lock.yaml" ]] || die "no frontend/admin-console/package.json + pnpm-lock.yaml in $STAGING_DIR"
[[ -f "$ADMIN_ENV_FILE" ]] || die "missing $ADMIN_ENV_FILE (run admin-setup.sh)"
[[ -f "$(unit_file)" ]] || die "missing $(unit_file) (run admin-setup.sh)"
[[ -x "$NODE_BIN/node" && -x "$NODE_BIN/pnpm" ]] || die "Node.js / pnpm missing in $NODE_BIN (run admin-setup.sh)"
# admin.env is written once, so a host change does not reach it: stop here, before the downtime.
[[ "$(env_value CARPAL_ADMIN_ORIGIN)" == "https://$ADMIN_CONSOLE_HOST" ]] ||
  die "admin.env CARPAL_ADMIN_ORIGIN is $(env_value CARPAL_ADMIN_ORIGIN), but this deployment serves https://$ADMIN_CONSOLE_HOST (deploy.md 'Changing the host')"
[[ "$(env_value CARPAL_ADMIN_API_AUDIENCE)" == "https://$ADMIN_HOST" ]] ||
  die "admin.env CARPAL_ADMIN_API_AUDIENCE is $(env_value CARPAL_ADMIN_API_AUDIENCE), expected https://$ADMIN_HOST (the htu of the BFF's DPoP proofs)"
[[ -z "$(env_value CARPAL_ADMIN_OAUTH_REDIRECT_URI)" ]] || die "admin.env sets CARPAL_ADMIN_OAUTH_REDIRECT_URI: dev and E2E only, remove it"
[[ "$(env_value CARPAL_ADMIN_ENV)" != "dev" ]] || die "admin.env CARPAL_ADMIN_ENV=dev: never on a server (prod or staging)"

want="$(contract_of "$STAGED_APP")"
[[ -n "$want" ]] || die "cannot read the contract version of the upload (frontend/admin-console/src/lib/api/generated/operations.ts)"
have="$(curl -sS --max-time 10 -D - -o /dev/null "$BACKEND_HEALTH_URL" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1)=="carpal-contract" {print $2}' || true)"
if [[ -z "$have" ]]; then
  [[ "$REQUIRE_BACKEND" == "1" ]] && die "the backend does not answer at $BACKEND_HEALTH_URL (start it, or REQUIRE_BACKEND=0)"
  warn "the backend does not answer at $BACKEND_HEALTH_URL: staff cannot sign in until it runs"
elif ! version_ge "$have" "$want"; then
  [[ "$REQUIRE_BACKEND" == "1" ]] && die "the backend serves contract $have; this console needs $want or newer (deploy the backend first)"
  warn "the backend serves contract $have; this console needs $want"
else
  ok "backend contract $have (console built for $want)"
fi
free_mb=$(($(df -Pk "$ADMIN_ROOT" | awk 'NR==2 {print $4}') / 1024))
((free_mb >= 3000)) || warn "only ${free_mb} MB free under $ADMIN_ROOT (a release with node_modules and .next takes about 1.5 GB)"
ok "staging copy and configuration found"

# ----------------------------------------------------------------- copy (before the stop)
step "Copying ${ADMIN_SYNC_DIRS// /, } from $STAGING_DIR"
rm -rf "$NEW"
install -d -m 750 -o root -g "$ADMIN_SERVICE_GROUP" "$NEW"
for d in $ADMIN_SYNC_DIRS; do
  mkdir -p "$NEW/$d"
  rsync -a --delete \
    --exclude 'node_modules/' --exclude '.next/' --exclude 'test-results/' --exclude 'playwright-report/' \
    --exclude 'blob-report/' --exclude 'coverage/' --exclude 'public/ds/' --exclude '.env' --exclude '.env.local' \
    --exclude '.env.*.local' --exclude '*.tsbuildinfo' --exclude '*.jwk' --exclude '*.pem' --exclude '.turbo/' \
    --exclude '.git/' \
    "$STAGING_DIR/$d/" "$NEW/$d/"
done
grep -lq $'\r' "$NEW/frontend/admin-console/deploy/"*.sh 2>/dev/null && warn "the uploaded deploy scripts have Windows line ends (deploy.md 'Troubleshooting')"
ok "copied to $NEW"

# --------------------------------------------------------------------- release swap
step "Stopping $ADMIN_SERVICE_NAME (staff are signed out)"
WAS_RUNNING=0
if service_active; then
  WAS_RUNNING=1
  systemctl stop "$ADMIN_SERVICE_NAME"
  ok "stopped"
else
  ok "was not running"
fi
HAVE_PREVIOUS=0
if [[ -d "$ADMIN_SRC_DIR" && -n "$(ls -A "$ADMIN_SRC_DIR" 2>/dev/null)" ]]; then
  mv "$ADMIN_SRC_DIR" "$PREVIOUS"
  HAVE_PREVIOUS=1
  ok "previous release kept in $PREVIOUS"
else
  rm -rf "$ADMIN_SRC_DIR"
fi
mv "$NEW" "$ADMIN_SRC_DIR"

# A release that cannot be built or started: put the previous one back and start it again.
rollback() {
  local reason="$1"
  if [[ "$AUTO_ROLLBACK" == "1" && "$HAVE_PREVIOUS" == "1" ]]; then
    warn "$reason: restoring the previous release"
    systemctl stop "$ADMIN_SERVICE_NAME" 2>/dev/null || true
    mv "$ADMIN_SRC_DIR" "$BACKUP_DIR/admin-$TS-failed"
    mv "$PREVIOUS" "$ADMIN_SRC_DIR"
    systemctl start "$ADMIN_SERVICE_NAME"
    if wait_healthy; then
      die "$reason. The previous release runs again; the failed one is in $BACKUP_DIR/admin-$TS-failed (journalctl -u $ADMIN_SERVICE_NAME)"
    fi
    die "$reason, and the restored previous release is not healthy either (journalctl -u $ADMIN_SERVICE_NAME)"
  fi
  die "$reason (no automatic rollback: $([[ "$HAVE_PREVIOUS" == "1" ]] && echo "previous release in $PREVIOUS, deploy.md 'Rollback'" || echo "first release"))"
}

# The signed-out page needs no session and no backend call: 200 through the same Host nginx sends.
wait_healthy() {
  local deadline=$(($(date +%s) + ADMIN_HEALTH_TIMEOUT_S)) code
  while (($(date +%s) < deadline)); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: $ADMIN_CONSOLE_HOST" -H 'X-Forwarded-Proto: https' \
      "http://127.0.0.1:$ADMIN_PORT/id/signed-out" || true)"
    [[ "$code" == "200" ]] && return 0
    sleep 3
  done
  return 1
}

# ----------------------------------------------------------------------------- build
build() {
  step "pnpm install (frozen lockfile)"
  run_clean pnpm install --frozen-lockfile || return 1
  if [[ "$RUN_LINT" == "1" ]]; then
    step "pnpm lint"
    run_clean pnpm lint || return 1
  fi
  if [[ "$RUN_TYPECHECK" == "1" ]]; then
    step "pnpm typecheck"
    run_clean pnpm typecheck || return 1
  fi
  if [[ "$RUN_UNIT_TESTS" == "1" ]]; then
    step "pnpm test (unit + DOM)"
    run_clean pnpm test || return 1
  fi
  # next build sometimes stops with a SecurityFatalError after a successful compile; a plain rerun passes (README).
  local attempt=1
  while :; do
    step "next build (with $ADMIN_ENV_FILE), attempt $attempt of $BUILD_ATTEMPTS"
    if run_with_env pnpm build && [[ -f "$ADMIN_APP_DIR/.next/BUILD_ID" ]]; then break; fi
    ((attempt < BUILD_ATTEMPTS)) || return 1
    attempt=$((attempt + 1))
    warn "next build failed; trying again"
  done
  ok "build $(cat "$ADMIN_APP_DIR/.next/BUILD_ID")"
}
build || rollback "the build failed"

# ----------------------------------------------------------------------- permissions
step "Permissions"
# Code: root-owned, readable by the service group, never writable by the service; .next is the service's own
# (Next.js writes its cache there).
chown -R root:"$ADMIN_SERVICE_GROUP" "$ADMIN_SRC_DIR"
chmod -R u+rwX,g+rX,g-w,o-rwx "$ADMIN_SRC_DIR"
install -d -m 750 -o "$ADMIN_SERVICE_USER" -g "$ADMIN_SERVICE_GROUP" "$ADMIN_APP_DIR/.next/cache"
chown -R "$ADMIN_SERVICE_USER":"$ADMIN_SERVICE_GROUP" "$ADMIN_APP_DIR/.next"
chown root:"$ADMIN_SERVICE_GROUP" "$ADMIN_ENV_FILE"
chmod 640 "$ADMIN_ENV_FILE"
ok "root:$ADMIN_SERVICE_GROUP, .next owned by $ADMIN_SERVICE_USER"

# ---------------------------------------------------------------------------- start
step "Starting $ADMIN_SERVICE_NAME"
# The unit follows the template of the deploy scripts that run this update.
render "$DEPLOY_DIR/templates/carpal-admin.service" "$(unit_file)"
chmod 644 "$(unit_file)"
systemctl daemon-reload
systemctl start "$ADMIN_SERVICE_NAME"
wait_healthy || rollback "the new release did not answer 200 on /id/signed-out within ${ADMIN_HEALTH_TIMEOUT_S} s"
ok "pages answer"

step "BFF session"
# GET /bff/csrf creates a pre-session (Set-Cookie __Host-cpa_sid); the same request with that cookie must read it back
# (the same CSRF token): the session store and the cookie work end to end.
csrf() { curl -s -D - --max-time 20 -H "Host: $ADMIN_CONSOLE_HOST" -H 'X-Forwarded-Proto: https' "$@" "http://127.0.0.1:$ADMIN_PORT/bff/csrf" | tr -d '\r'; }
first="$(csrf || true)"
cookie="$(printf '%s\n' "$first" | sed -n 's/^[Ss]et-[Cc]ookie: \(__Host-cpa_sid=[^;]*\).*/\1/p' | head -n 1)"
token1="$(printf '%s\n' "$first" | sed -n 's/.*"csrf_token":"\([^"]*\)".*/\1/p' | head -n 1)"
[[ -n "$cookie" && -n "$token1" ]] || rollback "GET /bff/csrf issued no session ($(printf '%s\n' "$first" | head -n 1); journalctl -u $ADMIN_SERVICE_NAME)"
token2="$(csrf -H "Cookie: $cookie" | sed -n 's/.*"csrf_token":"\([^"]*\)".*/\1/p' | head -n 1 || true)"
[[ "$token2" == "$token1" ]] || rollback "the session could not be read back"
ok "a session was issued and read back"

step "Security headers"
hdrs="$(curl -s -D - -o /dev/null --max-time 10 -H "Host: $ADMIN_CONSOLE_HOST" -H 'X-Forwarded-Proto: https' "http://127.0.0.1:$ADMIN_PORT/id/signed-out" | tr -d '\r' | tr 'A-Z' 'a-z')"
for h in 'content-security-policy:' 'strict-transport-security:' 'cache-control: private, no-store' 'x-robots-tag: noindex'; do
  [[ "$hdrs" == *"$h"* ]] || rollback "the signed-out page lacks '$h' (src/server/security-headers.ts, admin.env CARPAL_ADMIN_ENV)"
done
ok "CSP, HSTS, no-store, noindex"

# ------------------------------------------------------------------------- clean up
step "Old releases"
mapfile -t old < <(ls -1dt "$BACKUP_DIR"/admin-* 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))")
for d in "${old[@]}"; do rm -rf "$d"; done
ok "kept the newest $KEEP_BACKUPS in $BACKUP_DIR (${#old[@]} removed)"

finish
cat <<EOF

Release $(cat "$ADMIN_APP_DIR/.next/BUILD_ID") of @carpal/admin-console $(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ADMIN_APP_DIR/package.json") (contract $want) runs.
  Logs:   journalctl -u $ADMIN_SERVICE_NAME -f
  Check:  https://$ADMIN_CONSOLE_HOST/  (deploy.md "After each deployment")
  Before: $([[ "$HAVE_PREVIOUS" == "1" ]] && echo "$PREVIOUS" || echo "none (first release)")$([[ "$WAS_RUNNING" == "0" ]] && echo " — the service was not running before this update")
EOF
