#!/usr/bin/env bash
# Shared helpers of the CarPal landing deploy scripts. Sourced, never run directly.
#   - loads landing-deploy.conf.example (defaults), /carpal/config/deploy.conf (shared with the backend and the PWA) and
#     /carpal/config/landing-deploy.conf (landing overrides)
#   - logs every script run to $LOG_DIR/landing-deploy-<date>.log

set -Eeuo pipefail
umask 027

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=landing-deploy.conf.example
source "$DEPLOY_DIR/landing-deploy.conf.example"
SHARED_CONF="${CARPAL_DEPLOY_CONF:-/carpal/config/deploy.conf}"
LANDING_CONF="${CARPAL_LANDING_DEPLOY_CONF:-/carpal/config/landing-deploy.conf}"
# shellcheck disable=SC1090
[[ -f "$SHARED_CONF" ]] && source "$SHARED_CONF"
# shellcheck disable=SC1090
[[ -f "$LANDING_CONF" ]] && source "$LANDING_CONF"

LANDING_HOST="${LANDING_HOST:-www.$DOMAIN}"
WEB_HOST="${WEB_HOST:-pwa.$DOMAIN}"
PORTAL_HOST="${PORTAL_HOST:-web.$DOMAIN}"
FLEET_HOST="${FLEET_HOST:-fleet.$DOMAIN}"
RELEASES_DIR="$LANDING_ROOT/releases"
CURRENT_LINK="$LANDING_ROOT/current"      # nginx's root; a new release replaces this link in one step
SITE_FILE="${CARPAL_LANDING_SITE_FILE:-/etc/nginx/sites-available/carpal-landing}"

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

# Every run is appended to the day's log (stdout and stderr).
start_log() {
  mkdir -p "$LOG_DIR"
  chmod 750 "$LOG_DIR"
  exec > >(tee -a "$LOG_DIR/landing-deploy-$(date +%Y%m%d).log") 2>&1
  printf '\n===== %s %s (%s) =====\n' "$(date '+%F %T')" "$SCRIPT_NAME" "$(id -un)"
}

finish() {
  ok "$SCRIPT_NAME finished in $(($(date +%s) - STARTED_AT)) s"
}

# Replaces @NAME@ placeholders of a template with the values of the same-named variables.
render() {
  local template="$1" out="$2" content name
  content="$(cat "$template")"
  for name in LANDING_HOST LANDING_ROOT; do
    content="${content//@${name}@/${!name}}"
  done
  printf '%s\n' "$content" >"$out"
}
