#!/usr/bin/env bash
# Shared helpers of the CarPal PWA deploy scripts. Sourced, never run directly.
#   - loads pwa-deploy.conf.example (defaults), /carpal/config/deploy.conf (shared with the backend) and
#     /carpal/config/pwa-deploy.conf (PWA overrides)
#   - logs every script run to $LOG_DIR/pwa-deploy-<date>.log
#   - runs build tools as root in a clean environment (no shell variables, only pwa.env for next build)

set -Eeuo pipefail
umask 027

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pwa-deploy.conf.example
source "$DEPLOY_DIR/pwa-deploy.conf.example"
SHARED_CONF="${CARPAL_DEPLOY_CONF:-/carpal/config/deploy.conf}"
PWA_CONF="${CARPAL_PWA_DEPLOY_CONF:-/carpal/config/pwa-deploy.conf}"
# shellcheck disable=SC1090
[[ -f "$SHARED_CONF" ]] && source "$SHARED_CONF"
# shellcheck disable=SC1090
[[ -f "$PWA_CONF" ]] && source "$PWA_CONF"

WEB_HOST="${WEB_HOST:-pwa.$DOMAIN}"
PORTAL_HOST="${PORTAL_HOST:-web.$DOMAIN}"
LANDING_HOST="${LANDING_HOST:-www.$DOMAIN}"
API_HOST="${API_HOST:-api.$DOMAIN}"
AUTH_HOST="${AUTH_HOST:-id.$DOMAIN}"
MEDIA_HOST="${MEDIA_HOST:-media.$DOMAIN}"
PWA_SRC_DIR="$PWA_ROOT/src"               # holds pwa/ and shared/, like the repository
PWA_APP_DIR="$PWA_SRC_DIR/pwa"            # the Next.js app (package.json, .next/)
PWA_ENV_FILE="$CONFIG_DIR/pwa.env"
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

# Every run is appended to the day's log (stdout and stderr).
start_log() {
  mkdir -p "$LOG_DIR"
  chmod 750 "$LOG_DIR"
  exec > >(tee -a "$LOG_DIR/pwa-deploy-$(date +%Y%m%d).log") 2>&1
  printf '\n===== %s %s (%s) =====\n' "$(date '+%F %T')" "$SCRIPT_NAME" "$(id -un)"
}

finish() {
  ok "$SCRIPT_NAME finished in $(($(date +%s) - STARTED_AT)) s"
}

unit_file() { echo "/etc/systemd/system/$PWA_SERVICE_NAME.service"; }
service_active() { systemctl is-active --quiet "$PWA_SERVICE_NAME" 2>/dev/null; }

# One value of pwa.env (KEY=value lines; quotes around the value are removed).
env_value() {
  local v
  v="$(sed -n "s/^$1=//p" "$PWA_ENV_FILE" | tail -n 1)"
  v="${v%\'}"; v="${v#\'}"; v="${v%\"}"; v="${v#\"}"
  printf '%s' "$v"
}

# Build tools (pnpm, next, tsc, vitest) run as root in a clean environment: no CARPAL_* variables from the shell.
run_clean() {
  (cd "$PWA_APP_DIR" && env -i \
    HOME=/root \
    PATH="$NODE_BIN:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" \
    LANG=C.UTF-8 \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_OPTIONS="--max-old-space-size=$BUILD_MEMORY_MB" \
    "$@")
}

# next build with the service environment: pages prerendered at build time (robots, manifests, sitemaps' shells) read
# CARPAL_PWA_ORIGIN and the other settings, so a change of pwa.env needs a new build (deploy.md "Configuration").
run_with_env() {
  [[ -f "$PWA_ENV_FILE" ]] || die "missing $PWA_ENV_FILE (run pwa-setup.sh)"
  # shellcheck disable=SC2016 # $1 and $@ expand in the inner bash
  (cd "$PWA_APP_DIR" && env -i \
    HOME=/root \
    PATH="$NODE_BIN:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" \
    LANG=C.UTF-8 \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_OPTIONS="--max-old-space-size=$BUILD_MEMORY_MB" \
    bash -c 'set -a; . "$1"; set +a; shift; exec "$@"' _ "$PWA_ENV_FILE" "$@")
}

# Replaces @NAME@ placeholders of a template with the values of the same-named variables
# (the fixed list below plus any extra names given after the output path).
render() {
  local template="$1" out="$2" content name
  shift 2
  content="$(cat "$template")"
  for name in "$@" DOMAIN WEB_HOST PORTAL_HOST LANDING_HOST API_HOST AUTH_HOST MEDIA_HOST CARPAL_ROOT CONFIG_DIR PWA_ROOT PWA_SRC_DIR PWA_APP_DIR \
    PWA_ENV_FILE PWA_SERVICE_NAME PWA_SERVICE_USER PWA_SERVICE_GROUP PWA_PORT BACKEND_API_URL BACKEND_AUTH_URL \
    REDIS_PORT REDIS_DB REDIS_MAXMEMORY NODE_BIN; do
    content="${content//@${name}@/${!name}}"
  done
  printf '%s\n' "$content" >"$out"
}

# "1.1.0" >= "1.0.3"? (numeric major.minor.patch)
version_ge() {
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" == "$2" ]]
}

# Installs the official Node.js build (checksum-verified) into NODE_INSTALL_ROOT unless /usr/local/bin/node already
# has the wanted version (the backend's server-setup.sh installs the same one), and enables pnpm through corepack.
install_node() {
  local version="$NODE_VERSION_FALLBACK" f arch dir tmp tarball
  for f in "$STAGING_DIR/backend/.node-version" "$CARPAL_ROOT/backend/src/backend/.node-version"; do
    if [[ -f "$f" ]]; then version="$(tr -d ' \r\n' <"$f")"; break; fi
  done
  if [[ -x "$NODE_BIN/node" ]] && [[ "$("$NODE_BIN/node" --version)" == "v$version" ]]; then
    ok "node v$version already installed"
  else
    case "$(uname -m)" in
      x86_64) arch=x64 ;;
      aarch64) arch=arm64 ;;
      *) die "unsupported CPU $(uname -m)" ;;
    esac
    dir="$NODE_INSTALL_ROOT/node-v$version-linux-$arch"
    if [[ ! -x "$dir/bin/node" ]]; then
      tmp="$(mktemp -d)"
      tarball="node-v$version-linux-$arch.tar.xz"
      curl -fsSL "https://nodejs.org/dist/v$version/$tarball" -o "$tmp/$tarball"
      curl -fsSL "https://nodejs.org/dist/v$version/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
      (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -) || die "Node.js checksum mismatch"
      tar -xJf "$tmp/$tarball" -C "$NODE_INSTALL_ROOT"
      rm -rf "$tmp"
    fi
    ln -sfn "$dir" "$NODE_INSTALL_ROOT/node"
    for b in node npm npx corepack; do ln -sfn "$NODE_INSTALL_ROOT/node/bin/$b" "$NODE_BIN/$b"; done
    ok "node $("$NODE_BIN/node" --version) installed"
  fi
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$NODE_BIN/corepack" enable --install-directory "$NODE_BIN" pnpm
  ok "pnpm shim in $NODE_BIN (version from pwa/package.json packageManager)"
}
