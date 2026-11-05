#!/usr/bin/env bash
# shellcheck disable=SC2034 # REDIS_PASSWORD is read by render() through indirect expansion
# One-time (and re-runnable) server preparation for the CarPal consumer PWA on Ubuntu 24.04 LTS.
#
#   sudo bash /home/root/staging/pwa/deploy/pwa-setup.sh
#
# Does: system packages (nginx, certbot, Redis, rsync), Node.js + pnpm, the service user carpal-web, the folders,
# Redis for the BFF sessions (local only, password), /carpal/config/pwa.env, the systemd unit carpal-pwa, the nginx
# site for www.<DOMAIN> (unless the backend's site already serves it), optionally the TLS certificate, a check of the
# backend's settings the PWA depends on, and (FIRST_DEPLOY=1) the first release through pwa-update.sh.
# Safe to re-run: existing passwords, pwa.env and TLS blocks are never overwritten.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root

# ----------------------------------------------------------------------------- config
mkdir -p "$CONFIG_DIR"
if [[ ! -f "$SHARED_CONF" ]]; then
  {
    echo "# Server overrides of backend/deploy/deploy.conf.example and pwa/deploy/pwa-deploy.conf.example (created $(date +%F))."
    echo "DOMAIN=example.com"
    echo "LETSENCRYPT_EMAIL=admin@example.com"
    echo "STAGING_DIR=$STAGING_DIR"
  } >"$SHARED_CONF"
  chmod 640 "$SHARED_CONF"
  echo "Created $SHARED_CONF. Set DOMAIN and LETSENCRYPT_EMAIL (PWA-only values go to $PWA_CONF), then run this script again."
  exit 0
fi
[[ "$DOMAIN" != "example.com" ]] || die "set DOMAIN in $SHARED_CONF first"
start_log
cd /

. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || warn "written for Ubuntu 24.04; found ${PRETTY_NAME:-unknown}"
[[ -f "$STAGING_DIR/pwa/package.json" ]] || warn "no repository in $STAGING_DIR yet (upload it before pwa-update.sh)"

# --------------------------------------------------------------------------- packages
step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl openssl rsync tar xz-utils nginx certbot python3-certbot-nginx redis-server
ok "packages installed"

# ---------------------------------------------------------------------------- Node.js
step "Node.js and pnpm"
install_node

# ------------------------------------------------------------------- user and folders
step "Service user $PWA_SERVICE_USER and folders"
getent group "$PWA_SERVICE_GROUP" >/dev/null || groupadd --system "$PWA_SERVICE_GROUP"
id -u "$PWA_SERVICE_USER" >/dev/null 2>&1 ||
  useradd --system --gid "$PWA_SERVICE_GROUP" --home-dir "$PWA_ROOT" --no-create-home --shell /usr/sbin/nologin "$PWA_SERVICE_USER"
install -d -m 755 -o root -g root "$CARPAL_ROOT"
install -d -m 750 -o root -g "$PWA_SERVICE_GROUP" "$PWA_ROOT"
[[ -d "$PWA_SRC_DIR" ]] || install -d -m 750 -o root -g "$PWA_SERVICE_GROUP" "$PWA_SRC_DIR"
install -d -m 700 -o root -g root "$BACKUP_DIR" "$STAGING_DIR"
install -d -m 750 -o root -g root "$LOG_DIR"
# CONFIG_DIR may belong to the backend (root:carpal 750): systemd reads pwa.env as root, so it stays as it is.
chmod o-rwx "$CONFIG_DIR"
ok "layout under $PWA_ROOT"

# ------------------------------------------------------------------------------ Redis
step "Redis for the BFF sessions (127.0.0.1:$REDIS_PORT, password)"
REDIS_PASSWORD=""
if [[ -f /etc/redis/carpal-pwa.conf ]]; then
  REDIS_PASSWORD="$(sed -n 's/^requirepass //p' /etc/redis/carpal-pwa.conf | tail -n 1)"
fi
[[ -n "$REDIS_PASSWORD" ]] || REDIS_PASSWORD="$(openssl rand -hex 24)"
render "$DEPLOY_DIR/templates/redis-carpal-pwa.conf" /etc/redis/carpal-pwa.conf REDIS_PASSWORD
chown root:redis /etc/redis/carpal-pwa.conf
chmod 640 /etc/redis/carpal-pwa.conf
grep -qxF 'include /etc/redis/carpal-pwa.conf' /etc/redis/redis.conf || echo 'include /etc/redis/carpal-pwa.conf' >>/etc/redis/redis.conf
systemctl enable redis-server >/dev/null
systemctl restart redis-server
for _ in $(seq 1 20); do
  [[ "$(REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping 2>/dev/null)" == "PONG" ]] && break
  sleep 1
done
[[ "$(REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping 2>/dev/null)" == "PONG" ]] || die "Redis does not answer on 127.0.0.1:$REDIS_PORT"
ok "Redis answers (local only, maxmemory $REDIS_MAXMEMORY, volatile-lru)"

# --------------------------------------------------------------------------- pwa.env
step "Service environment $PWA_ENV_FILE"
if [[ ! -f "$PWA_ENV_FILE" ]]; then
  CLIENT_KEYS="$CONFIG_DIR/oauth-client-keys.json"
  [[ -f "$CLIENT_KEYS" ]] || die "$CLIENT_KEYS is missing: run the backend's server-setup.sh first (it makes the client key pairs)"
  CLIENT_PRIVATE_JWKS="$(tr -d '\n' <"$CLIENT_KEYS")"
  render "$DEPLOY_DIR/templates/pwa.env.template" "$PWA_ENV_FILE" REDIS_PASSWORD CLIENT_PRIVATE_JWKS
  ok "generated pwa.env (review it: deploy.md step 4)"
else
  url="$(env_value CARPAL_PWA_REDIS_URL)"
  [[ "$url" == *":$REDIS_PASSWORD@"* ]] || warn "CARPAL_PWA_REDIS_URL in pwa.env does not carry the password of /etc/redis/carpal-pwa.conf"
  ok "pwa.env exists: left unchanged"
fi
chown root:"$PWA_SERVICE_GROUP" "$PWA_ENV_FILE"
chmod 640 "$PWA_ENV_FILE"

# -------------------------------------------------------------------------- systemd
step "systemd unit $PWA_SERVICE_NAME"
render "$DEPLOY_DIR/templates/carpal-pwa.service" "$(unit_file)"
chmod 644 "$(unit_file)"
systemctl daemon-reload
systemctl enable "$PWA_SERVICE_NAME" >/dev/null
ok "installed and enabled (started by pwa-update.sh after the build)"

# ---------------------------------------------------------------------------- nginx
step "nginx for $WEB_HOST and $DOMAIN"
install -m 644 "$DEPLOY_DIR/templates/nginx-carpal-pwa-proxy.conf" /etc/nginx/snippets/carpal-pwa-proxy.conf
site=/etc/nginx/sites-available/carpal-pwa
# Which enabled site already names WEB_HOST? (the backend's nginx-carpal.conf has the same server blocks)
other="$(grep -lE "server_name[^;]*[[:space:]]$WEB_HOST[[:space:];]" /etc/nginx/sites-enabled/* 2>/dev/null | grep -v '/carpal-pwa$' || true)"
if [[ -n "$other" ]]; then
  ok "$WEB_HOST is already served by $other (backend template): carpal-pwa site not installed"
  if [[ -L /etc/nginx/sites-enabled/carpal-pwa ]]; then
    rm -f /etc/nginx/sites-enabled/carpal-pwa
    warn "removed the duplicate /etc/nginx/sites-enabled/carpal-pwa"
  fi
elif [[ -f "$site" ]] && grep -q "ssl_certificate" "$site"; then
  warn "$site already has certbot TLS blocks: left unchanged (re-render by hand if the template changed)"
  ln -sfn "$site" /etc/nginx/sites-enabled/carpal-pwa
else
  render "$DEPLOY_DIR/templates/nginx-carpal-pwa.conf" "$site"
  chmod 644 "$site"
  ln -sfn "$site" /etc/nginx/sites-enabled/carpal-pwa
  ok "installed $site"
fi
nginx -t
systemctl enable --now nginx >/dev/null
systemctl reload nginx
ok "nginx configured"

# ----------------------------------------------------------------------------- TLS
step "TLS for $WEB_HOST and $DOMAIN"
if grep -rqsE "ssl_certificate[^;]*/live/[^/]*/" /etc/nginx/sites-enabled/ && certbot certificates 2>/dev/null | grep -qE "Domains:.*[[:space:]]$WEB_HOST([[:space:]]|$)"; then
  ok "a certificate for $WEB_HOST exists (certbot renews it automatically)"
elif [[ "$RUN_CERTBOT" == "1" ]]; then
  certbot --nginx --non-interactive --agree-tos --redirect --email "$LETSENCRYPT_EMAIL" -d "$WEB_HOST" -d "$DOMAIN"
  ok "certificate issued; http redirects to https"
else
  warn "no certificate for $WEB_HOST yet. When DNS points here: certbot --nginx -d $WEB_HOST -d $DOMAIN --email $LETSENCRYPT_EMAIL --agree-tos --redirect"
fi

# ------------------------------------------------------------- backend settings check
step "Backend settings the PWA depends on"
BACKEND_ENV="$CONFIG_DIR/backend.env"
if [[ -f "$BACKEND_ENV" ]]; then
  bget() { sed -n "s/^$1=//p" "$BACKEND_ENV" | tail -n 1 | sed "s/^'//; s/'\$//"; }
  origin="https://$WEB_HOST"
  [[ "$(bget CARPAL_OAUTH_REDIRECT_URIS)" == *"\"$origin/bff/oauth/callback\""* ]] ||
    warn "backend.env CARPAL_OAUTH_REDIRECT_URIS: cp-web-consumer needs \"$origin/bff/oauth/callback\" (sign-in fails without it)"
  [[ "$(bget CARPAL_WEBAUTHN_ORIGINS)" == *"\"$origin\""* ]] || warn "backend.env CARPAL_WEBAUTHN_ORIGINS needs \"$origin\" (passkeys)"
  [[ "$(bget CARPAL_MEDIA_CORS_ORIGINS)" == *"\"$origin\""* ]] || warn "backend.env CARPAL_MEDIA_CORS_ORIGINS needs \"$origin\" (uploads, PDF preview)"
  [[ "$(bget CARPAL_LINK_BASE_URL)" == "$origin/l" ]] || warn "backend.env CARPAL_LINK_BASE_URL should be $origin/l (emailed links)"
  [[ "$(bget CARPAL_API_AUDIENCE)" == "$(env_value CARPAL_API_AUDIENCE)" ]] ||
    warn "CARPAL_API_AUDIENCE differs: backend.env $(bget CARPAL_API_AUDIENCE), pwa.env $(env_value CARPAL_API_AUDIENCE)"
  [[ "$(bget CARPAL_STRICT_AUTH)" == "$(env_value CARPAL_STRICT_AUTH)" ]] ||
    warn "CARPAL_STRICT_AUTH differs: backend.env $(bget CARPAL_STRICT_AUTH), pwa.env $(env_value CARPAL_STRICT_AUTH)"
  [[ "$(env_value CARPAL_STRICT_AUTH)" != "1" || -n "$(bget CARPAL_OAUTH_CLIENT_JWKS)" ]] ||
    warn "backend.env has no CARPAL_OAUTH_CLIENT_JWKS: strict mode refuses the PWA's token requests"
  [[ -z "$(bget CARPAL_SIGNIN_URL)" ]] || warn "backend.env sets CARPAL_SIGNIN_URL: leave it unset (the PWA's /id proxy serves <issuer>/signin)"
  ok "checked $BACKEND_ENV"
else
  warn "no $BACKEND_ENV here: set the backend's CARPAL_OAUTH_REDIRECT_URIS, CARPAL_WEBAUTHN_ORIGINS, CARPAL_MEDIA_CORS_ORIGINS and CARPAL_LINK_BASE_URL for https://$WEB_HOST by hand (deploy.md step 2)"
fi
if curl -fsS --max-time 5 -o /dev/null "$BACKEND_HEALTH_URL"; then
  ok "backend answers at $BACKEND_HEALTH_URL"
else
  warn "backend does not answer at $BACKEND_HEALTH_URL (deploy and start it before pwa-update.sh)"
fi

# ------------------------------------------------------------------------- checks
mem_mb=$(($(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024))
swap_mb=$(($(awk '/SwapTotal/ {print $2}' /proc/meminfo) / 1024))
((mem_mb + swap_mb >= 4000)) || warn "RAM + swap is ${mem_mb}+${swap_mb} MB: next build needs about 4 GB (add swap, deploy.md 'Server')"

finish
if [[ "$FIRST_DEPLOY" == "1" && -f "$STAGING_DIR/pwa/package.json" ]]; then
  echo
  echo "First release: running pwa-update.sh"
  exec bash "$DEPLOY_DIR/pwa-update.sh"
fi
cat <<EOF

Next (deploy.md "First deployment"):
  1. Review $PWA_ENV_FILE.
  2. Upload the repository with WinSCP to $STAGING_DIR (without node_modules, .next, .data, .tools).
  3. sudo bash $STAGING_DIR/pwa/deploy/pwa-update.sh
EOF
