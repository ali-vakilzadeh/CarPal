#!/usr/bin/env bash
# Publishes the landing site uploaded to the staging folder (WinSCP) as a new release.
#
#   sudo bash /home/root/staging/landing/deploy/landing-update.sh
#
# Steps: preflight → copy landing/ to /carpal/landing/releases/<time> → write the hosts of this deployment into the pages
# → permissions → switch the "current" link → health check. The site stays up throughout: nginx reads the link on every
# request, so there is nothing to stop or reload. A release that fails the health check is replaced by the previous one.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root
[[ "$DOMAIN" != "example.com" ]] || die "set DOMAIN in $SHARED_CONF first (run landing-setup.sh)"
start_log
cd /

TS="$(date +%Y%m%d-%H%M%S)"
SOURCE="$STAGING_DIR/landing"
NEW="$RELEASES_DIR/$TS"

# ------------------------------------------------------------------------- preflight
step "Preflight"
for f in index.html en/index.html en/benefits.html fa/index.html fa/benefits.html assets/site.css assets/site.js assets/lang.js assets/entry.css 404.html ds/tokens.css; do
  [[ -f "$SOURCE/$f" ]] || die "missing $SOURCE/$f (upload the repository first)"
done
[[ -f "$SITE_FILE" ]] || die "missing $SITE_FILE (run landing-setup.sh)"
ok "staging copy and configuration found"

# ------------------------------------------------------------------------------ copy
step "Copying $SOURCE"
install -d -m 750 -o root -g "$LANDING_WEB_GROUP" "$NEW"
cp -R "$SOURCE/." "$NEW/"
rm -rf "$NEW/deploy"                      # the kit itself is never served
find "$NEW" -mindepth 1 -name '.*' -prune -exec rm -rf {} +
ok "copied to $NEW"

# ----------------------------------------------------------------------------- hosts
# The pages name carpals.ir, the Iran market's domain. Another market's DOMAIN (or a host override) needs no edit of the HTML.
step "Hosts in the pages"
find "$NEW" -name '*.html' -exec sed -i \
  -e "s/www\.carpals\.ir/$LANDING_HOST/g" \
  -e "s/pwa\.carpals\.ir/$WEB_HOST/g" \
  -e "s/web\.carpals\.ir/$PORTAL_HOST/g" \
  -e "s/fleet\.carpals\.ir/$FLEET_HOST/g" \
  -e "s/carpals\.ir/$DOMAIN/g" {} +
ok "$LANDING_HOST, links to $WEB_HOST, $PORTAL_HOST and $FLEET_HOST"

# ----------------------------------------------------------------------- permissions
step "Permissions"
chown -R root:"$LANDING_WEB_GROUP" "$NEW"
chmod -R u=rwX,g=rX,o= "$NEW"
ok "root:$LANDING_WEB_GROUP, read-only for nginx"

# ---------------------------------------------------------------------------- switch
switch_to() {
  ln -sfn "$1" "$CURRENT_LINK.tmp"
  mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"
}

# One page or file answers 200 from nginx on this server: over https once the site has a certificate, else http.
answers() {
  local scheme code
  for scheme in https http; do
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 \
      --resolve "$LANDING_HOST:443:127.0.0.1" --resolve "$LANDING_HOST:80:127.0.0.1" "$scheme://$LANDING_HOST$1" || true)"
    [[ "$code" == "200" ]] && return 0
  done
  return 1
}

healthy() {
  local path
  for path in / /en/ /fa/ /en/benefits.html /fa/benefits.html /404.html /assets/site.css /assets/entry.css /assets/lang.js /ds/tokens.css; do
    answers "$path" || { warn "$path does not answer 200"; return 1; }
  done
}

step "Switching to the new release"
PREVIOUS="$(readlink "$CURRENT_LINK" 2>/dev/null || true)"
switch_to "$NEW"
ok "$CURRENT_LINK → $NEW"

step "Health check"
if ! healthy; then
  if [[ -n "$PREVIOUS" ]]; then
    switch_to "$PREVIOUS"
    die "the new release failed its health check; back on $PREVIOUS. The failed one stays in $NEW"
  fi
  die "the first release failed its health check (nginx running? systemctl status nginx)"
fi
ok "every page answers"

# ------------------------------------------------------------------------- clean up
step "Old releases"
mapfile -t old < <(ls -1dt "$RELEASES_DIR"/* 2>/dev/null | tail -n +"$((KEEP_RELEASES + 1))")
for d in "${old[@]}"; do rm -rf "$d"; done
ok "kept the newest $KEEP_RELEASES in $RELEASES_DIR (${#old[@]} removed)"

finish
cat <<EOF

Release $TS runs.
  Check:  https://$LANDING_HOST/  (deploy.md "After each deployment")
  Before: ${PREVIOUS:-none (first release)}
EOF
