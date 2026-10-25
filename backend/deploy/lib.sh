#!/usr/bin/env bash
# Shared helpers of the CarPal deploy scripts. Sourced, never run directly.
#   - loads deploy.conf.example (defaults), then /carpal/config/deploy.conf (overrides)
#   - logs every script run to $LOG_DIR/deploy-<date>.log
#   - runs build tools in a clean environment and database tools with the service secrets

set -Eeuo pipefail
umask 027

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy.conf.example
source "$DEPLOY_DIR/deploy.conf.example"
DEPLOY_CONF="${CARPAL_DEPLOY_CONF:-/carpal/config/deploy.conf}"
if [[ -f "$DEPLOY_CONF" ]]; then
  # shellcheck disable=SC1090
  source "$DEPLOY_CONF"
fi

API_HOST="${API_HOST:-api.$DOMAIN}"
AUTH_HOST="${AUTH_HOST:-id.$DOMAIN}"
ADMIN_HOST="${ADMIN_HOST:-admin-api.$DOMAIN}"
MEDIA_HOST="${MEDIA_HOST:-media.$DOMAIN}"
BACKEND_DIR="$SRC_DIR/backend"
NODE_BIN=/usr/local/bin

SCRIPT_NAME="$(basename "$0")"
STARTED_AT="$(date +%s)"

c_info=$'\e[36m'; c_ok=$'\e[32m'; c_warn=$'\e[33m'; c_err=$'\e[31m'; c_off=$'\e[0m'
[[ -t 1 ]] || { c_info=''; c_ok=''; c_warn=''; c_err=''; c_off=''; }

step() { printf '%s==> %s%s\n' "$c_info" "$*" "$c_off"; }
ok()   { printf '%s    ok: %s%s\n' "$c_ok" "$*" "$c_off"; }
warn() { printf '%s    warning: %s%s\n' "$c_warn" "$*" "$c_off" >&2; }
die()  { printf '%sERROR (%s): %s%s\n' "$c_err" "$SCRIPT_NAME" "$*" "$c_off" >&2; exit 1; }

on_error() {
  local code=$? line=${1:-?}
  printf '%sERROR (%s): command failed at line %s (exit %s): %s%s\n' "$c_err" "$SCRIPT_NAME" "$line" "$code" "$BASH_COMMAND" "$c_off" >&2
  exit "$code"
}
trap 'on_error $LINENO' ERR

require_root() {
  [[ $EUID -eq 0 ]] || die "run as root (sudo bash $0)"
}

# Every run is appended to the day's deploy log (stdout and stderr).
start_log() {
  mkdir -p "$LOG_DIR"
  chmod 750 "$LOG_DIR"
  local log
  log="$LOG_DIR/deploy-$(date +%Y%m%d).log"
  exec > >(tee -a "$log") 2>&1
  printf '\n===== %s %s (%s) =====\n' "$(date '+%F %T')" "$SCRIPT_NAME" "$(id -un)"
}

finish() {
  ok "$SCRIPT_NAME finished in $(($(date +%s) - STARTED_AT)) s"
}

service_installed() { [[ -f "/etc/systemd/system/$SERVICE_NAME.service" ]]; }
service_active() { systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; }
pg_unit() { echo "postgresql@${PG_VERSION}-${PG_CLUSTER}"; }
pg_active() { systemctl is-active --quiet "$(pg_unit)" 2>/dev/null; }

# Build tools (pnpm, tsc, vitest) run as root in a clean environment: no service secrets,
# no CARPAL_* variables from the shell, so checks and unit tests behave as on a developer machine.
run_clean() {
  (cd "$BACKEND_DIR" && env -i \
    HOME=/root \
    PATH="$NODE_BIN:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" \
    LANG=C.UTF-8 \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_OPTIONS="--max-old-space-size=$BUILD_MEMORY_MB" \
    "$@")
}

# Database tools (pnpm db:*) need the role passwords (backend.env) and the superuser login (db-admin.env).
run_db() {
  [[ -f "$CONFIG_DIR/backend.env" && -f "$CONFIG_DIR/db-admin.env" ]] ||
    die "missing $CONFIG_DIR/backend.env or db-admin.env (run server-setup.sh)"
  # shellcheck disable=SC2016 # $1, $2 and $@ expand in the inner bash
  (cd "$BACKEND_DIR" && env -i \
    HOME=/root \
    PATH="$NODE_BIN:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" \
    LANG=C.UTF-8 \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    bash -c 'set -a; . "$1"; . "$2"; set +a; shift 2; exec "$@"' _ "$CONFIG_DIR/backend.env" "$CONFIG_DIR/db-admin.env" "$@")
}

# Replaces @NAME@ placeholders of a template with the values of the same-named variables
# (the fixed list below plus any extra names given after the output path).
render() {
  local template="$1" out="$2" content name
  shift 2
  content="$(cat "$template")"
  for name in "$@" DOMAIN API_HOST AUTH_HOST ADMIN_HOST MEDIA_HOST CARPAL_ROOT SRC_DIR BACKEND_DIR CONFIG_DIR DATA_DIR \
    UPLOAD_DIR DB_DIR SERVICE_NAME SERVICE_USER SERVICE_GROUP PG_VERSION PG_CLUSTER PG_PORT DB_NAME ANALYTICS_DB_NAME NODE_BIN; do
    content="${content//@${name}@/${!name}}"
  done
  printf '%s\n' "$content" >"$out"
}
