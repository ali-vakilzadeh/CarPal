#!/usr/bin/env bash
# Email check (backend S26a.T2; deploy.md "Email", email_setup_guide.md): with the settings of
# $CONFIG_DIR/backend.env, connects to the CARPAL_SMTP_URL mail server from this machine, starts TLS, logs in with the
# mailbox and sends one test message. Never prints the password.
#
#   sudo bash mail-test.sh you@example.com
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root
start_log

TO="${1:-}"
[[ -n "$TO" ]] || die "usage: mail-test.sh <address>"
[[ -f "$BACKEND_DIR/package.json" ]] || die "no code in $BACKEND_DIR: run 1-sync.sh and 2-build.sh first"

step "Test message to $TO"
run_db pnpm -s mail:test --to "$TO"
ok "sent; check the inbox (and the spam folder) of $TO"
finish
