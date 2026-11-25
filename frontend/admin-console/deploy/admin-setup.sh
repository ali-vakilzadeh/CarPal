#!/usr/bin/env bash
# shellcheck disable=SC2034 # CLIENT_PRIVATE_JWKS and GATE_RULES are read by render() through indirect expansion
# One-time (and re-runnable) server preparation for the CarPal admin console on Ubuntu 24.04 LTS.
#
#   sudo bash /home/root/staging/frontend/admin-console/deploy/admin-setup.sh
#
# Does: system packages (nginx, certbot, rsync), Node.js + pnpm, the service user carpal-admin, the folders,
# /carpal/config/admin.env (with the cp-web-admin key the backend's server-setup.sh made), the systemd unit
# carpal-admin, the nginx site for admin.<DOMAIN> with the access gate (ADMIN_GATE), optionally the TLS certificate, a
# check of the backend's settings the console depends on, on the first install the backend's staff-bootstrap.sh
# (OQ-10), and (FIRST_DEPLOY=1) the first release through admin-update.sh.
# Safe to re-run: admin.env and an nginx site with TLS blocks are never overwritten.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root

# ----------------------------------------------------------------------------- config
mkdir -p "$CONFIG_DIR"
if [[ ! -f "$SHARED_CONF" ]]; then
  {
    echo "# Server overrides of the CarPal deploy kits' defaults (created $(date +%F) by admin-setup.sh)."
    echo "DOMAIN=example.com"
    echo "LETSENCRYPT_EMAIL=admin@example.com"
    echo "STAGING_DIR=$STAGING_DIR"
  } >"$SHARED_CONF"
  chmod 640 "$SHARED_CONF"
  echo "Created $SHARED_CONF. Set DOMAIN and LETSENCRYPT_EMAIL (console-only values go to $ADMIN_CONF), then run this script again."
  echo "Deploy the backend first (backend/deploy/deploy.md): the console needs its key file and its running admin-api."
  exit 0
fi
[[ "$DOMAIN" != "example.com" ]] || die "set DOMAIN in $SHARED_CONF first"
GATE_RULES="$(gate_rules)"
start_log
cd /

. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || warn "written for Ubuntu 24.04; found ${PRETTY_NAME:-unknown}"
[[ -f "$STAGING_DIR/frontend/admin-console/package.json" ]] || warn "no repository in $STAGING_DIR yet (upload it before admin-update.sh)"

# --------------------------------------------------------------------------- packages
step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl openssl rsync tar xz-utils nginx certbot python3-certbot-nginx
ok "packages installed"

# ---------------------------------------------------------------------------- Node.js
step "Node.js and pnpm"
install_node

# ------------------------------------------------------------------- user and folders
step "Service user $ADMIN_SERVICE_USER and folders"
getent group "$ADMIN_SERVICE_GROUP" >/dev/null || groupadd --system "$ADMIN_SERVICE_GROUP"
id -u "$ADMIN_SERVICE_USER" >/dev/null 2>&1 ||
  useradd --system --gid "$ADMIN_SERVICE_GROUP" --home-dir "$ADMIN_ROOT" --no-create-home --shell /usr/sbin/nologin "$ADMIN_SERVICE_USER"
install -d -m 755 -o root -g root "$CARPAL_ROOT"
install -d -m 750 -o root -g "$ADMIN_SERVICE_GROUP" "$ADMIN_ROOT"
[[ -d "$ADMIN_SRC_DIR" ]] || install -d -m 750 -o root -g "$ADMIN_SERVICE_GROUP" "$ADMIN_SRC_DIR"
install -d -m 700 -o root -g root "$BACKUP_DIR" "$STAGING_DIR"
install -d -m 750 -o root -g root "$LOG_DIR"
# CONFIG_DIR may belong to the backend (root:carpal 750): systemd reads admin.env as root, so it stays as it is.
chmod o-rwx "$CONFIG_DIR"
ok "layout under $ADMIN_ROOT (user $ADMIN_SERVICE_USER, separate from the PWA's)"

# ------------------------------------------------------------------------- admin.env
step "Service environment $ADMIN_ENV_FILE"
if [[ ! -f "$ADMIN_ENV_FILE" ]]; then
  [[ -f "$ADMIN_CLIENT_KEYS" ]] ||
    die "$ADMIN_CLIENT_KEYS is missing: run the backend's server-setup.sh first (it makes the cp-web-admin key pair)"
  CLIENT_PRIVATE_JWKS="$(tr -d '\n' <"$ADMIN_CLIENT_KEYS")"
  [[ "$CLIENT_PRIVATE_JWKS" == *'"cp-web-admin"'* && "$CLIENT_PRIVATE_JWKS" == *'"d":'* && "$CLIENT_PRIVATE_JWKS" != *"'"* ]] ||
    die "$ADMIN_CLIENT_KEYS does not hold the private key of cp-web-admin (backend deploy.md 'Client keys')"
  (umask 027 && render "$DEPLOY_DIR/templates/admin.env.template" "$ADMIN_ENV_FILE" CLIENT_PRIVATE_JWKS)
  ok "generated admin.env (review it: deploy.md step 5)"
else
  [[ "$(env_value CARPAL_ADMIN_ORIGIN)" == "https://$ADMIN_CONSOLE_HOST" ]] ||
    warn "admin.env CARPAL_ADMIN_ORIGIN is $(env_value CARPAL_ADMIN_ORIGIN), but this deployment serves https://$ADMIN_CONSOLE_HOST"
  [[ "$(env_value CARPAL_ADMIN_API_AUDIENCE)" == "https://$ADMIN_HOST" ]] ||
    warn "admin.env CARPAL_ADMIN_API_AUDIENCE is $(env_value CARPAL_ADMIN_API_AUDIENCE), expected https://$ADMIN_HOST"
  ok "admin.env exists: left unchanged"
fi
chown root:"$ADMIN_SERVICE_GROUP" "$ADMIN_ENV_FILE"
chmod 640 "$ADMIN_ENV_FILE"
# The PWA's environment must never carry the staff client's key (backend S12, D-12).
if [[ -f "$CONFIG_DIR/pwa.env" ]] && grep -q 'cp-web-admin' "$CONFIG_DIR/pwa.env"; then
  warn "$CONFIG_DIR/pwa.env mentions cp-web-admin: remove the staff client's key from the PWA's environment"
fi

# -------------------------------------------------------------------------- systemd
step "systemd unit $ADMIN_SERVICE_NAME"
render "$DEPLOY_DIR/templates/carpal-admin.service" "$(unit_file)"
chmod 644 "$(unit_file)"
systemctl daemon-reload
systemctl enable "$ADMIN_SERVICE_NAME" >/dev/null
ok "installed and enabled (started by admin-update.sh after the build)"

# ---------------------------------------------------------------------------- nginx
step "nginx for $ADMIN_CONSOLE_HOST (gate: $ADMIN_GATE)"
install -m 644 "$DEPLOY_DIR/templates/nginx-carpal-admin-proxy.conf" /etc/nginx/snippets/carpal-admin-proxy.conf
site=/etc/nginx/sites-available/carpal-admin
other="$(grep -lE "server_name[^;]*[[:space:]]$ADMIN_CONSOLE_HOST[[:space:];]" /etc/nginx/sites-enabled/* 2>/dev/null | grep -v '/carpal-admin$' || true)"
if [[ -n "$other" ]]; then
  die "$ADMIN_CONSOLE_HOST is already served by $other: remove that server block first (the console's gate and limits live in $site)"
elif [[ -f "$site" ]] && grep -q "ssl_certificate" "$site"; then
  warn "$site already has certbot TLS blocks: left unchanged (re-render by hand if the template or the gate changed)"
  if [[ "$ADMIN_GATE" == "ip_allowlist" ]] && ! grep -q 'deny all;' "$site"; then
    warn "ADMIN_GATE=ip_allowlist, but $site has no 'deny all;': add the allow/deny lines to every location (deploy.md 'Access gate')"
  elif [[ "$ADMIN_GATE" == "none" ]] && grep -q 'deny all;' "$site"; then
    warn "ADMIN_GATE=none, but $site still filters addresses (deploy.md 'Access gate')"
  fi
  ln -sfn "$site" /etc/nginx/sites-enabled/carpal-admin
else
  render "$DEPLOY_DIR/templates/nginx-carpal-admin.conf" "$site" GATE_RULES
  chmod 644 "$site"
  ln -sfn "$site" /etc/nginx/sites-enabled/carpal-admin
  ok "installed $site"
fi
nginx -t
systemctl enable --now nginx >/dev/null
systemctl reload nginx
ok "nginx configured"

# ----------------------------------------------------------------------------- TLS
step "TLS for $ADMIN_CONSOLE_HOST"
if grep -qs "ssl_certificate" "$site" && certbot certificates 2>/dev/null | grep -qE "Domains:.*[[:space:]]$ADMIN_CONSOLE_HOST([[:space:]]|$)"; then
  ok "a certificate for $ADMIN_CONSOLE_HOST exists (certbot renews it automatically)"
elif [[ "$RUN_CERTBOT" == "1" ]]; then
  certbot --nginx --non-interactive --agree-tos --redirect --email "$LETSENCRYPT_EMAIL" -d "$ADMIN_CONSOLE_HOST"
  ok "certificate issued; http redirects to https"
else
  warn "no certificate for $ADMIN_CONSOLE_HOST yet. When DNS points here: certbot --nginx -d $ADMIN_CONSOLE_HOST --email $LETSENCRYPT_EMAIL --agree-tos --redirect"
fi

# ------------------------------------------------------------- backend settings check
step "Backend settings the console depends on"
BACKEND_ENV="$CONFIG_DIR/backend.env"
if [[ -f "$BACKEND_ENV" ]]; then
  bget() { sed -n "s/^$1=//p" "$BACKEND_ENV" | tail -n 1 | sed "s/^'//; s/'\$//"; }
  origin="https://$ADMIN_CONSOLE_HOST"
  redirects="$(bget CARPAL_OAUTH_REDIRECT_URIS)"
  [[ "$redirects" =~ \"cp-web-admin\":\[[^]]*\"$origin/bff/oauth/callback\" ]] ||
    warn "backend.env CARPAL_OAUTH_REDIRECT_URIS: cp-web-admin needs \"$origin/bff/oauth/callback\" (staff sign-in fails without it)"
  [[ "$(bget CARPAL_WEBAUTHN_ORIGINS)" == *"\"$origin\""* ]] || warn "backend.env CARPAL_WEBAUTHN_ORIGINS needs \"$origin\" (security keys)"
  auth_origins="$(bget CARPAL_AUTH_WEB_ORIGINS)"
  [[ -z "$auth_origins" || "$auth_origins" == *"\"$origin\""* ]] ||
    warn "backend.env CARPAL_AUTH_WEB_ORIGINS is set but lacks \"$origin\" (the sign-in steps are refused)"
  [[ "$(bget CARPAL_ADMIN_API_AUDIENCE)" == "$(env_value CARPAL_ADMIN_API_AUDIENCE)" ]] ||
    warn "CARPAL_ADMIN_API_AUDIENCE differs: backend.env $(bget CARPAL_ADMIN_API_AUDIENCE), admin.env $(env_value CARPAL_ADMIN_API_AUDIENCE)"
  [[ "$(bget CARPAL_STRICT_AUTH)" == "$(env_value CARPAL_STRICT_AUTH)" ]] ||
    warn "CARPAL_STRICT_AUTH differs: backend.env $(bget CARPAL_STRICT_AUTH), admin.env $(env_value CARPAL_STRICT_AUTH)"
  [[ "$(bget CARPAL_OAUTH_CLIENT_JWKS)" == *'"cp-web-admin"'* ]] ||
    warn "backend.env CARPAL_OAUTH_CLIENT_JWKS lacks cp-web-admin: every staff token request answers invalid_client (backend server-setup.sh prints the value)"
  [[ -z "$(bget CARPAL_SIGNIN_URL)" ]] || warn "backend.env sets CARPAL_SIGNIN_URL: leave it unset (the console's /id proxy serves <issuer>/signin)"
  [[ "$(bget CARPAL_WEBAUTHN_RP_ID)" == "$DOMAIN" ]] || warn "backend.env CARPAL_WEBAUTHN_RP_ID should be $DOMAIN (security keys are bound to it)"
  ok "checked $BACKEND_ENV"
else
  warn "no $BACKEND_ENV here: set the backend's CARPAL_OAUTH_REDIRECT_URIS (cp-web-admin), CARPAL_WEBAUTHN_ORIGINS and CARPAL_OAUTH_CLIENT_JWKS for https://$ADMIN_CONSOLE_HOST by hand (deploy.md 'Requirements')"
fi
if curl -fsS --max-time 5 -o /dev/null "$BACKEND_HEALTH_URL"; then
  ok "backend answers at $BACKEND_HEALTH_URL"
else
  warn "backend does not answer at $BACKEND_HEALTH_URL (deploy and start it before admin-update.sh)"
fi

# ------------------------------------------------------------- first staff accounts (OQ-10)
step "Base staff accounts (backend staff-bootstrap.sh, first install only)"
marker="$ADMIN_ROOT/.staff-bootstrap-done"
if [[ "$RUN_STAFF_BOOTSTRAP" != "1" ]]; then
  ok "skipped (RUN_STAFF_BOOTSTRAP=$RUN_STAFF_BOOTSTRAP)"
elif [[ -f "$marker" ]]; then
  ok "already run on $(cat "$marker"); later accounts: sudo bash $BACKEND_DEPLOY_DIR/staff-bootstrap.sh (runbook.md)"
elif [[ ! -f "$CONFIG_DIR/staff-bootstrap.json" ]]; then
  warn "no $CONFIG_DIR/staff-bootstrap.json: create the staff accounts later (runbook.md 'First staff accounts')"
elif [[ ! -f "$BACKEND_DEPLOY_DIR/staff-bootstrap.sh" ]]; then
  warn "the backend is not installed in $CARPAL_ROOT/backend: deploy it, then run its staff-bootstrap.sh (runbook.md)"
else
  # Without CARPAL_STAFF_INITIAL_PASSWORD its output holds one-time passwords. The backend script keeps its own log
  # (root only); on a terminal its output goes there and to the screen, not into this script's log a second time.
  echo "    Running $BACKEND_DEPLOY_DIR/staff-bootstrap.sh"
  out=/dev/stdout
  if { : >/dev/tty; } 2>/dev/null; then out=/dev/tty; fi
  if bash "$BACKEND_DEPLOY_DIR/staff-bootstrap.sh" >"$out" 2>&1; then
    date +%F >"$marker"
    ok "staff accounts created or found"
  else
    warn "staff-bootstrap.sh failed: read its output above, fix it and run it again by hand (runbook.md)"
  fi
fi

# ------------------------------------------------------------------------- checks
mem_mb=$(($(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024))
swap_mb=$(($(awk '/SwapTotal/ {print $2}' /proc/meminfo) / 1024))
((mem_mb + swap_mb >= 4000)) || warn "RAM + swap is ${mem_mb}+${swap_mb} MB: next build needs about 4 GB (add swap, deploy.md 'Troubleshooting')"

finish
if [[ "$FIRST_DEPLOY" == "1" && -f "$STAGING_DIR/frontend/admin-console/package.json" ]]; then
  echo
  echo "First release: running admin-update.sh"
  exec bash "$DEPLOY_DIR/admin-update.sh"
fi
cat <<EOF

Next (deploy.md "First deployment"):
  1. Review $ADMIN_ENV_FILE.
  2. Upload the repository with WinSCP to $STAGING_DIR (without node_modules, .next, .data, .tools).
  3. sudo bash $STAGING_DIR/frontend/admin-console/deploy/admin-update.sh
EOF
