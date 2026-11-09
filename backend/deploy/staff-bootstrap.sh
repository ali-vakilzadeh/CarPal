#!/usr/bin/env bash
# First-run staff accounts (backend S12; admin console OQ-10): creates, if they do not exist, the base staff accounts
# listed in /carpal/config/staff-bootstrap.json (copy templates/staff-bootstrap.json.example and put real names and
# addresses in it). Safe to run again: an account that exists is reported and never changed. The admin console's setup
# script runs this once on its first install; later role changes go through the console with a second approver.
#
#   sudo bash staff-bootstrap.sh                 the spec in $CONFIG_DIR/staff-bootstrap.json
#   sudo bash staff-bootstrap.sh /path/spec.json another spec file
#
# Prints a one-time password per new account (shown once, never stored in a file): hand each to its owner over a
# separate channel. The first console sign-in then asks for the password, a code sent to the email and a device-bound
# passkey. Until real email is set up (backend NI-07) the code is in $DATA_DIR/outbox-mail.jsonl.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root
start_log

SPEC="${1:-$CONFIG_DIR/staff-bootstrap.json}"
[[ -f "$SPEC" ]] || die "no staff spec at $SPEC: copy $DEPLOY_DIR/templates/staff-bootstrap.json.example there and edit it"
[[ -f "$BACKEND_DIR/package.json" ]] || die "no code in $BACKEND_DIR: run 1-sync.sh and 2-build.sh first"
pg_active || die "PostgreSQL ($(pg_unit)) is not running"
chown root:root "$SPEC" && chmod 600 "$SPEC"

step "Staff accounts from $SPEC"
run_db pnpm -s staff:bootstrap --file "$SPEC"
ok "done; run it again any time: existing accounts are left as they are"
finish
