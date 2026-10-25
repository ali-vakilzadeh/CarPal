#!/usr/bin/env bash
# shellcheck disable=SC2034 # the generated secrets are read by render() through indirect expansion
# One-time (and re-runnable) server preparation for the CarPal backend on Ubuntu 24.04 LTS.
#
#   sudo bash server-setup.sh
#
# First run: creates /carpal/config/deploy.conf and stops so you can set DOMAIN.
# Second run: installs packages, Node.js, PostgreSQL 16 (data in /carpal/db), the service
# user, the folder layout, generated secrets, the systemd unit and the nginx site.
# Safe to re-run: existing secrets, configuration and databases are never overwritten.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root

# ----------------------------------------------------------------------------- config
mkdir -p "$CONFIG_DIR"
if [[ ! -f "$CONFIG_DIR/deploy.conf" ]]; then
  {
    echo "# Server overrides of backend/deploy/deploy.conf.example (created $(date +%F))."
    echo "DOMAIN=example.com"
    echo "LETSENCRYPT_EMAIL=admin@example.com"
    echo "STAGING_DIR=$STAGING_DIR"
  } >"$CONFIG_DIR/deploy.conf"
  chmod 640 "$CONFIG_DIR/deploy.conf"
  echo "Created $CONFIG_DIR/deploy.conf. Set DOMAIN (and anything else from deploy.conf.example), then run this script again."
  exit 0
fi
[[ "$DOMAIN" != "example.com" ]] || die "set DOMAIN in $CONFIG_DIR/deploy.conf first"
start_log
cd /

. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || warn "written for Ubuntu 24.04; found ${PRETTY_NAME:-unknown}"
[[ "${VERSION_ID:-}" == "24.04" ]] || warn "PostgreSQL $PG_VERSION is the default only on Ubuntu 24.04; other releases need the PGDG repository"

# --------------------------------------------------------------------------- packages
step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg openssl rsync tar xz-utils \
  nginx certbot python3-certbot-nginx ufw \
  "postgresql-$PG_VERSION" "postgresql-$PG_VERSION-pgvector" postgresql-common
ok "packages installed"

# ---------------------------------------------------------------------------- Node.js
NODE_VERSION="$NODE_VERSION_FALLBACK"
for f in "$STAGING_DIR/backend/.node-version" "$BACKEND_DIR/.node-version"; do
  if [[ -f "$f" ]]; then NODE_VERSION="$(tr -d ' \r\n' <"$f")"; break; fi
done
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac
NODE_DIR="$NODE_INSTALL_ROOT/node-v$NODE_VERSION-linux-$NODE_ARCH"
step "Node.js $NODE_VERSION ($NODE_ARCH)"
if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  tmp="$(mktemp -d)"
  tarball="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$tarball" -o "$tmp/$tarball"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -) || die "Node.js checksum mismatch"
  tar -xJf "$tmp/$tarball" -C "$NODE_INSTALL_ROOT"
  rm -rf "$tmp"
fi
ln -sfn "$NODE_DIR" "$NODE_INSTALL_ROOT/node"
for b in node npm npx corepack; do ln -sfn "$NODE_INSTALL_ROOT/node/bin/$b" "$NODE_BIN/$b"; done
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$NODE_BIN/corepack" enable --install-directory "$NODE_BIN" pnpm
ok "node $("$NODE_BIN/node" --version), pnpm shim in $NODE_BIN (version from backend/package.json packageManager)"

# ------------------------------------------------------------------- user and folders
step "Service user and folders"
getent group "$SERVICE_GROUP" >/dev/null || groupadd --system "$SERVICE_GROUP"
id -u "$SERVICE_USER" >/dev/null 2>&1 ||
  useradd --system --gid "$SERVICE_GROUP" --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -m 755 -o root -g root "$CARPAL_ROOT"
install -d -m 750 -o root -g "$SERVICE_GROUP" "$(dirname "$SRC_DIR")" "$SRC_DIR" "$CONFIG_DIR"
install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$DATA_DIR" "$UPLOAD_DIR"
install -d -m 700 -o postgres -g postgres "$DB_DIR"
install -d -m 700 -o root -g root "$BACKUP_DIR" "$STAGING_DIR"
install -d -m 750 -o root -g root "$LOG_DIR"
chown root:"$SERVICE_GROUP" "$CONFIG_DIR/deploy.conf"
ok "layout under $CARPAL_ROOT"

# ------------------------------------------------------------------------ PostgreSQL
step "PostgreSQL $PG_VERSION cluster $PG_CLUSTER in $DB_DIR"
PG_DATA="$DB_DIR/$PG_VERSION/$PG_CLUSTER"
current="$(pg_lsclusters -h 2>/dev/null | awk -v v="$PG_VERSION" -v c="$PG_CLUSTER" '$1==v && $2==c {print $6}')"
if [[ -n "$current" && "$current" != "$PG_DATA" ]]; then
  # The package created its default cluster under /var/lib/postgresql: replace it, but only while it is empty.
  systemctl start "$(pg_unit)" || true
  users="$(runuser -u postgres -- psql -p "$(pg_lsclusters -h | awk -v v="$PG_VERSION" -v c="$PG_CLUSTER" '$1==v && $2==c {print $3}')" -Atc \
    "SELECT count(*) FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')" 2>/dev/null || echo unknown)"
  [[ "$users" == "0" ]] || die "cluster $PG_VERSION/$PG_CLUSTER at $current holds databases ($users); move it to $PG_DATA by hand (deploy.md)"
  pg_dropcluster --stop "$PG_VERSION" "$PG_CLUSTER"
  current=""
fi
if [[ -z "$current" ]]; then
  pg_createcluster "$PG_VERSION" "$PG_CLUSTER" -d "$PG_DATA" -p "$PG_PORT" --start -- \
    --auth-local=peer --auth-host=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8
fi
systemctl enable --now "$(pg_unit)"
ok "$(pg_lsclusters -h | awk -v v="$PG_VERSION" -v c="$PG_CLUSTER" '$1==v && $2==c {print "cluster", $1"/"$2, "port", $3, $4, $6}')"

# --------------------------------------------------------------------------- secrets
step "Secrets in $CONFIG_DIR"
gen() { openssl rand -hex "${1:-24}"; }
if [[ ! -f "$CONFIG_DIR/db-admin.env" ]]; then
  PW_SUPERUSER="$(gen)"
  render "$DEPLOY_DIR/templates/db-admin.env.template" "$CONFIG_DIR/db-admin.env" PW_SUPERUSER
  ok "generated db-admin.env"
fi
if [[ ! -f "$CONFIG_DIR/backend.env" ]]; then
  MASTER_SECRET="$(gen 32)"
  PW_MIGRATOR="$(gen)" PW_AUTH="$(gen)" PW_API="$(gen)" PW_ADMIN_API="$(gen)" PW_WORKER="$(gen)" PW_AI="$(gen)"
  PW_READONLY="$(gen)" PW_ANALYTICS_WRITER="$(gen)" PW_ANALYTICS_READER="$(gen)"
  render "$DEPLOY_DIR/templates/backend.env.template" "$CONFIG_DIR/backend.env" MASTER_SECRET PW_MIGRATOR PW_AUTH PW_API \
    PW_ADMIN_API PW_WORKER PW_AI PW_READONLY PW_ANALYTICS_WRITER PW_ANALYTICS_READER
  ok "generated backend.env (review it: deploy.md step 3)"
fi
chown root:root "$CONFIG_DIR/db-admin.env" && chmod 600 "$CONFIG_DIR/db-admin.env"
chown root:"$SERVICE_GROUP" "$CONFIG_DIR/backend.env" && chmod 640 "$CONFIG_DIR/backend.env"
# The superuser password always follows db-admin.env. It goes to psql on stdin (never on a command line);
# generated passwords are hex, so they need no quoting.
superuser_pw="$(sed -n 's/^CARPAL_DB_SUPERUSER_PASSWORD=//p' "$CONFIG_DIR/db-admin.env")"
[[ "$superuser_pw" =~ ^[A-Za-z0-9._-]+$ ]] || die "CARPAL_DB_SUPERUSER_PASSWORD in db-admin.env must use letters, digits, '.', '_' or '-'"
runuser -u postgres -- psql -p "$PG_PORT" -q -v ON_ERROR_STOP=1 <<SQL
\set pw '$superuser_pw'
ALTER ROLE postgres PASSWORD :'pw';
SQL
unset superuser_pw
ok "postgres superuser password set from db-admin.env"

# -------------------------------------------------------------------------- systemd
step "systemd unit $SERVICE_NAME"
render "$DEPLOY_DIR/templates/carpal-backend.service" "/etc/systemd/system/$SERVICE_NAME.service"
chmod 644 "/etc/systemd/system/$SERVICE_NAME.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
ok "installed and enabled (started by 4-start.sh after the first build)"

# ---------------------------------------------------------------------------- nginx
step "nginx site for $API_HOST, $AUTH_HOST, $MEDIA_HOST"
install -m 644 "$DEPLOY_DIR/templates/nginx-carpal-proxy.conf" /etc/nginx/snippets/carpal-proxy.conf
site=/etc/nginx/sites-available/carpal
if [[ -f "$site" ]] && grep -q "ssl_certificate" "$site"; then
  warn "$site already has certbot TLS blocks: left unchanged (re-render by hand if the template changed)"
else
  render "$DEPLOY_DIR/templates/nginx-carpal.conf" "$site"
  if [[ "$EXPOSE_ADMIN_API" == "1" ]]; then
    [[ -n "$ADMIN_ALLOW_IPS" ]] || die "EXPOSE_ADMIN_API=1 needs ADMIN_ALLOW_IPS"
    {
      echo "server {"
      echo "    listen 80;"
      echo "    listen [::]:80;"
      echo "    server_tokens off;"
      echo "    server_name $ADMIN_HOST;"
      echo "    client_max_body_size 64k;"
      for ip in $ADMIN_ALLOW_IPS; do echo "    allow $ip;"; done
      echo "    deny all;"
      echo "    location / {"
      echo "        proxy_pass http://127.0.0.1:8081;"
      echo "        include /etc/nginx/snippets/carpal-proxy.conf;"
      echo "    }"
      echo "}"
    } >>"$site"
  fi
  chmod 644 "$site"
fi
ln -sfn "$site" /etc/nginx/sites-enabled/carpal
nginx -t
systemctl enable --now nginx
systemctl reload nginx
ok "nginx configured (TLS: deploy.md step 6)"

# ------------------------------------------------------------------------- firewall
if [[ "$ENABLE_UFW" == "1" ]]; then
  step "Firewall"
  ufw allow OpenSSH
  ufw allow 'Nginx Full'
  ufw --force enable
  ok "ufw: OpenSSH and Nginx Full only"
else
  warn "firewall not changed (ENABLE_UFW=0). The backend and PostgreSQL listen on 127.0.0.1 only."
fi

# ------------------------------------------------------------------------- checks
mem_mb=$(($(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024))
swap_mb=$(($(awk '/SwapTotal/ {print $2}' /proc/meminfo) / 1024))
((mem_mb + swap_mb >= 4000)) || warn "RAM + swap is ${mem_mb}+${swap_mb} MB: the build needs about 4 GB (add swap, deploy.md 'Server')"

finish
cat <<EOF

Next (deploy.md "First deployment"):
  1. Review $CONFIG_DIR/backend.env.
  2. Upload the repository with WinSCP to $STAGING_DIR (binary mode, without node_modules, dist, .data, .tools).
  3. bash $STAGING_DIR/backend/deploy/1-sync.sh && bash $BACKEND_DIR/deploy/2-build.sh \\
       && bash $BACKEND_DIR/deploy/3-permissions.sh && bash $BACKEND_DIR/deploy/4-start.sh
  4. certbot --nginx -d $API_HOST -d $AUTH_HOST -d $MEDIA_HOST --email $LETSENCRYPT_EMAIL --agree-tos --redirect
EOF
