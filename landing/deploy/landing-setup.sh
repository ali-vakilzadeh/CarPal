#!/usr/bin/env bash
# One-time (and re-runnable) server preparation for the CarPal landing site on Ubuntu 24.04 LTS.
#
#   sudo bash /home/root/staging/landing/deploy/landing-setup.sh
#
# Does: nginx and certbot, the folders, the nginx site for www.<DOMAIN>, optionally the TLS certificate, a check that the
# bare <DOMAIN> redirects here, and (FIRST_DEPLOY=1) the first release through landing-update.sh.
# Safe to re-run: an nginx site with TLS blocks is never overwritten.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root

# ----------------------------------------------------------------------------- config
mkdir -p "$CONFIG_DIR"
if [[ ! -f "$SHARED_CONF" ]]; then
  {
    echo "# Server overrides of the deploy kits' example settings (created $(date +%F))."
    echo "DOMAIN=example.com"
    echo "LETSENCRYPT_EMAIL=admin@example.com"
    echo "STAGING_DIR=$STAGING_DIR"
  } >"$SHARED_CONF"
  chmod 640 "$SHARED_CONF"
  echo "Created $SHARED_CONF. Set DOMAIN and LETSENCRYPT_EMAIL, then run this script again."
  exit 0
fi
[[ "$DOMAIN" != "example.com" ]] || die "set DOMAIN in $SHARED_CONF first"
start_log
cd /

. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || warn "written for Ubuntu 24.04; found ${PRETTY_NAME:-unknown}"
[[ -f "$STAGING_DIR/landing/index.html" ]] || warn "no landing/ in $STAGING_DIR yet (upload it before landing-update.sh)"

# --------------------------------------------------------------------------- packages
step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl nginx certbot python3-certbot-nginx
ok "packages installed"

# ---------------------------------------------------------------------------- folders
step "Folders under $LANDING_ROOT"
getent group "$LANDING_WEB_GROUP" >/dev/null || die "group $LANDING_WEB_GROUP does not exist (nginx runs as another user? set LANDING_WEB_GROUP)"
install -d -m 755 -o root -g root "$CARPAL_ROOT"
install -d -m 750 -o root -g "$LANDING_WEB_GROUP" "$LANDING_ROOT" "$RELEASES_DIR"
install -d -m 750 -o root -g root "$LOG_DIR"
ok "layout under $LANDING_ROOT"

# ---------------------------------------------------------------------------- nginx
step "nginx site for $LANDING_HOST"
# A server set up before the PWA moved to pwa.<DOMAIN> still serves www.<DOMAIN> from another site.
other="$(grep -lE "server_name[^;]*[[:space:]]$LANDING_HOST[[:space:];]" /etc/nginx/sites-enabled/* 2>/dev/null | grep -v '/carpal-landing$' || true)"
[[ -z "$other" ]] || die "$other already serves $LANDING_HOST: move the PWA first (pwa/deploy/deploy.md 'Changing the public host')"
if [[ -f "$SITE_FILE" ]] && grep -q "ssl_certificate" "$SITE_FILE"; then
  warn "$SITE_FILE already has certbot TLS blocks: left unchanged (re-render by hand if the template changed)"
else
  render "$DEPLOY_DIR/templates/nginx-carpal-landing.conf" "$SITE_FILE"
  chmod 644 "$SITE_FILE"
  ok "installed $SITE_FILE"
fi
ln -sfn "$SITE_FILE" /etc/nginx/sites-enabled/carpal-landing
nginx -t
systemctl enable --now nginx >/dev/null
systemctl reload nginx
ok "nginx configured"

# ----------------------------------------------------------------------------- TLS
step "TLS for $LANDING_HOST"
if grep -q "ssl_certificate" "$SITE_FILE"; then
  ok "the site already has a certificate (certbot renews it automatically)"
elif [[ "$RUN_CERTBOT" == "1" ]]; then
  certbot --nginx --non-interactive --agree-tos --redirect --email "$LETSENCRYPT_EMAIL" -d "$LANDING_HOST"
  ok "certificate issued; http redirects to https"
else
  warn "no certificate for $LANDING_HOST yet. When DNS points here: certbot --nginx -d $LANDING_HOST --email $LETSENCRYPT_EMAIL --agree-tos --redirect"
fi

# --------------------------------------------------------------- bare domain redirect
step "Redirect of $DOMAIN"
if [[ "$BARE_DOMAIN_HERE" != "1" ]]; then
  ok "$DOMAIN does not point here (BARE_DOMAIN_HERE=0)"
elif grep -qsF "return 301 https://$LANDING_HOST\$request_uri" /etc/nginx/sites-enabled/*; then
  ok "$DOMAIN redirects to https://$LANDING_HOST"
else
  warn "no enabled site redirects $DOMAIN to https://$LANDING_HOST (the backend and PWA kits add it; on a site with TLS blocks, change the 'return 301' target by hand: deploy.md 'First deployment')"
fi

finish
if [[ "$FIRST_DEPLOY" == "1" && -f "$STAGING_DIR/landing/index.html" ]]; then
  echo
  echo "First release: running landing-update.sh"
  exec bash "$DEPLOY_DIR/landing-update.sh"
fi
cat <<EOF

Next (deploy.md "First deployment"):
  1. Upload the repository with WinSCP to $STAGING_DIR.
  2. sudo bash $STAGING_DIR/landing/deploy/landing-update.sh
EOF
