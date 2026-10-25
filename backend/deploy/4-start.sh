#!/usr/bin/env bash
# Update step 4: (re)start the backend and wait until every host answers.
#
#   sudo bash 4-start.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root
start_log

service_installed || die "/etc/systemd/system/$SERVICE_NAME.service missing (run server-setup.sh)"
pg_active || die "PostgreSQL ($(pg_unit)) is not running"

step "Starting $SERVICE_NAME"
systemctl daemon-reload
systemctl restart "$SERVICE_NAME"

step "Waiting for $HEALTH_URL (up to ${HEALTH_TIMEOUT_S}s)"
deadline=$(($(date +%s) + HEALTH_TIMEOUT_S))
until curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; do
  if ! service_active || (($(date +%s) > deadline)); then
    journalctl -u "$SERVICE_NAME" -n 80 --no-pager || true
    die "$SERVICE_NAME did not become healthy (log above; full log: journalctl -u $SERVICE_NAME)"
  fi
  sleep 2
done
ok "api: $(curl -fsS --max-time 3 "$HEALTH_URL")"

# The other listeners: auth (discovery document needs no token), admin-api (no token -> 401),
# storage (unsigned URL -> 403). CarPal-Client is required on every route except token-less GETs.
check() {
  local name="$1" url="$2" want="$3" got
  got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H 'CarPal-Client: cp-ops/1.0.0 (linux 1.0)' "$url" || true)"
  if [[ "$got" == "$want" ]]; then ok "$name answers ($got)"; else warn "$name: HTTP $got from $url (expected $want)"; fi
}
check auth "http://127.0.0.1:8082/.well-known/openid-configuration" 200
check admin-api "http://127.0.0.1:8081/v1/admin/flags" 401
check storage "http://127.0.0.1:8083/o/health-check" 403

systemctl --no-pager --lines=0 status "$SERVICE_NAME" | head -n 5 || true
finish
