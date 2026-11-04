#!/usr/bin/env bash
# Deploys the PWA code uploaded to the staging folder (WinSCP) as a new release.
#
#   sudo bash /home/root/staging/pwa/deploy/pwa-update.sh
#
# Steps: preflight (staging copy, pwa.env, backend up and serving at least the PWA's contract version) → stop the
# service → move the current release to /carpal/backups/pwa-<time> → copy pwa/ and shared/ from staging → pnpm install
# (frozen lockfile), checks, next build → permissions → start → health check (pages and a Redis-backed BFF session).
# A release that fails to build or start is replaced by the previous one (AUTO_ROLLBACK=1). The site is down from the
# stop to the end of the health check (a few minutes: the build runs in the release folder).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root
[[ "$DOMAIN" != "example.com" ]] || die "set DOMAIN in $SHARED_CONF first (run pwa-setup.sh)"
start_log
cd /

TS="$(date +%Y%m%d-%H%M%S)"
PREVIOUS="$BACKUP_DIR/pwa-$TS"
NEW="$PWA_ROOT/src.new"

# ------------------------------------------------------------------------- preflight
step "Preflight"
for d in $PWA_SYNC_DIRS; do [[ -d "$STAGING_DIR/$d" ]] || die "missing $STAGING_DIR/$d (upload the repository first)"; done
[[ -f "$STAGING_DIR/pwa/package.json" && -f "$STAGING_DIR/pwa/pnpm-lock.yaml" ]] || die "no pwa/package.json + pnpm-lock.yaml in $STAGING_DIR"
[[ -f "$PWA_ENV_FILE" ]] || die "missing $PWA_ENV_FILE (run pwa-setup.sh)"
[[ -f "$(unit_file)" ]] || die "missing $(unit_file) (run pwa-setup.sh)"
[[ -x "$NODE_BIN/node" && -x "$NODE_BIN/pnpm" ]] || die "Node.js / pnpm missing in $NODE_BIN (run pwa-setup.sh)"
[[ "$(env_value CARPAL_PWA_DEMO)" != "1" ]] || die "CARPAL_PWA_DEMO=1 in pwa.env: never in production"

want="$(grep -o '"version":"[0-9.]*"' "$STAGING_DIR/shared/api-contracts/generated/operations.ts" | head -n 1 | cut -d'"' -f4)"
[[ -n "$want" ]] || die "cannot read the contract version of the upload (shared/api-contracts/generated/operations.ts)"
have="$(curl -sS --max-time 10 -D - -o /dev/null "$BACKEND_HEALTH_URL" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1)=="carpal-contract" {print $2}' || true)"
if [[ -z "$have" ]]; then
  [[ "$REQUIRE_BACKEND" == "1" ]] && die "the backend does not answer at $BACKEND_HEALTH_URL (start it, or REQUIRE_BACKEND=0)"
  warn "the backend does not answer at $BACKEND_HEALTH_URL: the health check below will fail"
elif ! version_ge "$have" "$want"; then
  [[ "$REQUIRE_BACKEND" == "1" ]] && die "the backend serves contract $have; this PWA needs $want or newer (deploy the backend first)"
  warn "the backend serves contract $have; this PWA needs $want"
else
  ok "backend contract $have (PWA built for $want)"
fi
free_mb=$(($(df -Pk "$PWA_ROOT" | awk 'NR==2 {print $4}') / 1024))
((free_mb >= 3000)) || warn "only ${free_mb} MB free under $PWA_ROOT (a release with node_modules and .next takes about 1.5 GB)"
ok "staging copy and configuration found"

# ----------------------------------------------------------------- copy (before the stop)
step "Copying ${PWA_SYNC_DIRS// /, } from $STAGING_DIR"
rm -rf "$NEW"
install -d -m 750 -o root -g "$PWA_SERVICE_GROUP" "$NEW"
for d in $PWA_SYNC_DIRS; do
  rsync -a --delete \
    --exclude 'node_modules/' --exclude '.next/' --exclude 'test-results/' --exclude 'playwright-report/' \
    --exclude 'public/ds/' --exclude '.env' --exclude '.env.local' --exclude '.env.*.local' --exclude '*.tsbuildinfo' \
    --exclude '.turbo/' --exclude '.git/' \
    "$STAGING_DIR/$d/" "$NEW/$d/"
done
grep -rlq $'\r' "$NEW/pwa/deploy/"*.sh 2>/dev/null && warn "the uploaded deploy scripts have Windows line ends (deploy.md 'Troubleshooting')"
ok "copied to $NEW"

# --------------------------------------------------------------------- release swap
step "Stopping $PWA_SERVICE_NAME"
WAS_RUNNING=0
if service_active; then
  WAS_RUNNING=1
  systemctl stop "$PWA_SERVICE_NAME"
  ok "stopped"
else
  ok "was not running"
fi
HAVE_PREVIOUS=0
if [[ -d "$PWA_SRC_DIR" && -n "$(ls -A "$PWA_SRC_DIR" 2>/dev/null)" ]]; then
  mv "$PWA_SRC_DIR" "$PREVIOUS"
  HAVE_PREVIOUS=1
  ok "previous release kept in $PREVIOUS"
else
  rm -rf "$PWA_SRC_DIR"
fi
mv "$NEW" "$PWA_SRC_DIR"

# A release that cannot be built or started: put the previous one back and start it again.
rollback() {
  local reason="$1"
  if [[ "$AUTO_ROLLBACK" == "1" && "$HAVE_PREVIOUS" == "1" ]]; then
    warn "$reason: restoring the previous release"
    systemctl stop "$PWA_SERVICE_NAME" 2>/dev/null || true
    mv "$PWA_SRC_DIR" "$BACKUP_DIR/pwa-$TS-failed"
    mv "$PREVIOUS" "$PWA_SRC_DIR"
    systemctl start "$PWA_SERVICE_NAME"
    if wait_healthy; then
      die "$reason. The previous release runs again; the failed one is in $BACKUP_DIR/pwa-$TS-failed (journalctl -u $PWA_SERVICE_NAME)"
    fi
    die "$reason, and the restored previous release is not healthy either (journalctl -u $PWA_SERVICE_NAME)"
  fi
  die "$reason (no automatic rollback: $([[ "$HAVE_PREVIOUS" == "1" ]] && echo "previous release in $PREVIOUS, deploy.md 'Rollback'" || echo "first release"))"
}

# Pages answer 200 through the same Host nginx sends.
wait_healthy() {
  local deadline=$(($(date +%s) + PWA_HEALTH_TIMEOUT_S)) code
  while (($(date +%s) < deadline)); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: $WEB_HOST" -H 'X-Forwarded-Proto: https' \
      "http://127.0.0.1:$PWA_PORT/fa" || true)"
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
  step "next build (with $PWA_ENV_FILE)"
  run_with_env pnpm build || return 1
  [[ -f "$PWA_APP_DIR/.next/BUILD_ID" ]] || return 1
  ok "build $(cat "$PWA_APP_DIR/.next/BUILD_ID")"
}
build || rollback "the build failed"

# ----------------------------------------------------------------------- permissions
step "Permissions"
# Code: root-owned, readable by the service group, never writable by the service; .next is the service's own (Next.js
# writes its cache and regenerated pages there).
chown -R root:"$PWA_SERVICE_GROUP" "$PWA_SRC_DIR"
chmod -R u+rwX,g+rX,g-w,o-rwx "$PWA_SRC_DIR"
install -d -m 750 -o "$PWA_SERVICE_USER" -g "$PWA_SERVICE_GROUP" "$PWA_APP_DIR/.next/cache"
chown -R "$PWA_SERVICE_USER":"$PWA_SERVICE_GROUP" "$PWA_APP_DIR/.next"
chown root:"$PWA_SERVICE_GROUP" "$PWA_ENV_FILE"
chmod 640 "$PWA_ENV_FILE"
ok "root:$PWA_SERVICE_GROUP, .next owned by $PWA_SERVICE_USER"

# ---------------------------------------------------------------------------- start
step "Starting $PWA_SERVICE_NAME"
# The unit follows the template of the deploy scripts that run this update.
render "$DEPLOY_DIR/templates/carpal-pwa.service" "$(unit_file)"
chmod 644 "$(unit_file)"
systemctl daemon-reload
systemctl start "$PWA_SERVICE_NAME"
wait_healthy || rollback "the new release did not answer 200 on /fa within ${PWA_HEALTH_TIMEOUT_S} s"
ok "pages answer"

step "BFF session in Redis"
# GET /bff/csrf creates and stores a pre-session (Set-Cookie __Host-cp_sid); the same request with that cookie must
# read it back from Redis (the same CSRF token). Exercises the session store end to end (NI-P13-03).
redis_pw="$(env_value CARPAL_PWA_REDIS_URL | sed -n 's#^redis://[^:]*:\([^@]*\)@.*#\1#p')"
keys() { REDISCLI_AUTH="$redis_pw" redis-cli -h 127.0.0.1 -p "$REDIS_PORT" -n "$REDIS_DB" --scan --pattern 'cp:bff:sess:*' 2>/dev/null | wc -l; }
csrf() { curl -s -D - --max-time 20 -H "Host: $WEB_HOST" -H 'X-Forwarded-Proto: https' "$@" "http://127.0.0.1:$PWA_PORT/bff/csrf" | tr -d '\r'; }
before="$(keys)"
first="$(csrf || true)"
cookie="$(printf '%s\n' "$first" | sed -n 's/^[Ss]et-[Cc]ookie: \(__Host-cp_sid=[^;]*\).*/\1/p' | head -n 1)"
token1="$(printf '%s\n' "$first" | sed -n 's/.*"csrf_token":"\([^"]*\)".*/\1/p' | head -n 1)"
[[ -n "$cookie" && -n "$token1" ]] || rollback "GET /bff/csrf issued no session ($(printf '%s\n' "$first" | head -n 1); journalctl -u $PWA_SERVICE_NAME)"
(($(keys) > before)) || rollback "a session was issued but not stored in Redis (CARPAL_PWA_REDIS_URL)"
token2="$(csrf -H "Cookie: $cookie" | sed -n 's/.*"csrf_token":"\([^"]*\)".*/\1/p' | head -n 1 || true)"
[[ "$token2" == "$token1" ]] || rollback "the stored session could not be read back from Redis"
ok "a session was written to and read back from Redis"

# ------------------------------------------------------------------------- clean up
step "Old releases"
mapfile -t old < <(ls -1dt "$BACKUP_DIR"/pwa-* 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))")
for d in "${old[@]}"; do rm -rf "$d"; done
ok "kept the newest $KEEP_BACKUPS in $BACKUP_DIR (${#old[@]} removed)"

finish
cat <<EOF

Release $(cat "$PWA_APP_DIR/.next/BUILD_ID") of @carpal/pwa $(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$PWA_APP_DIR/package.json") (contract $want) runs.
  Logs:   journalctl -u $PWA_SERVICE_NAME -f
  Check:  https://$WEB_HOST/fa  (deploy.md "After each deployment")
  Before: $([[ "$HAVE_PREVIOUS" == "1" ]] && echo "$PREVIOUS" || echo "none (first release)")$([[ "$WAS_RUNNING" == "0" ]] && echo " — the service was not running before this update")
EOF
