#!/usr/bin/env bash
# First-run staff accounts (backend S12; admin console OQ-10): creates, if they do not exist, the base staff accounts
# listed in /carpal/config/staff-bootstrap.json (copy templates/staff-bootstrap.json.example and put real names and
# addresses in it). Safe to run again: an account that exists is reported and never changed. The admin console's setup
# script runs this once on its first install; later role changes go through the console with a second approver.
#
#   sudo bash staff-bootstrap.sh                     the spec in $CONFIG_DIR/staff-bootstrap.json
#   sudo bash staff-bootstrap.sh /path/spec.json     another spec file
#   sudo bash staff-bootstrap.sh --reissue <email>   a new initial password for an account that has not changed its
#                                                    initial one yet (it expires after 7 days; backend S26a, DQ-25)
#
# Passwords (backend S26a): when CARPAL_STAFF_INITIAL_PASSWORD is set in $CONFIG_DIR/backend.env, every new account
# gets that initial password (never printed); otherwise a one-time password is printed once per account. Either way
# the holder changes it at the first console sign-in, after the code sent to the account email, within 7 days. Hand
# the password over a separate channel. Until real email is set up (CARPAL_MAIL_TRANSPORT=smtp, deploy.md "Email")
# the code is in $DATA_DIR/outbox-mail.jsonl.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root
start_log

[[ -f "$BACKEND_DIR/package.json" ]] || die "no code in $BACKEND_DIR: run 1-sync.sh and 2-build.sh first"
pg_active || die "PostgreSQL ($(pg_unit)) is not running"

if [[ "${1:-}" == "--reissue" ]]; then
  EMAIL="${2:-}"
  [[ -n "$EMAIL" ]] || die "usage: staff-bootstrap.sh --reissue <email>"
  step "New initial password for $EMAIL"
  run_db pnpm -s staff:bootstrap --reissue "$EMAIL"
  ok "done"
  finish
  exit 0
fi

SPEC="${1:-$CONFIG_DIR/staff-bootstrap.json}"
[[ -f "$SPEC" ]] || die "no staff spec at $SPEC: copy $DEPLOY_DIR/templates/staff-bootstrap.json.example there and edit it"
chown root:root "$SPEC" && chmod 600 "$SPEC"
if grep -q '^CARPAL_STAFF_INITIAL_PASSWORD=..*' "$CONFIG_DIR/backend.env" 2>/dev/null; then
  ok "new accounts get the initial password from backend.env (CARPAL_STAFF_INITIAL_PASSWORD; not shown)"
else
  warn "CARPAL_STAFF_INITIAL_PASSWORD is not set: each new account gets a one-time password, printed once below"
fi

step "Staff accounts from $SPEC"
run_db pnpm -s staff:bootstrap --file "$SPEC"
ok "done; run it again any time: existing accounts are left as they are"
finish
