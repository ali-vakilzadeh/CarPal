#!/usr/bin/env bash
# Break glass for a lost staff security key (backend S16a; owner decision DQ-04): when fewer than two other platform
# admins can approve a recovery in the admin console, the server operator resets one staff account's security keys and
# recovery codes from here. Check the person's identity out of band first (a call to a known number, in person).
#
#   sudo bash staff-break-glass.sh <staff email> "<reason: who asked, how you checked it was them>"
#
# Disables the account's keys and open recovery codes, audits it as actor system with the reason (staff.break_glass),
# and the running backend ends the account's sessions and emails the account and every other active admin. The next
# console sign-in enrols a new device-bound key with the password and a code sent to the account's email.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root
start_log

EMAIL="${1:-}"
REASON="${2:-}"
[[ -n "$EMAIL" && -n "$REASON" ]] || die "usage: sudo bash staff-break-glass.sh <staff email> \"<reason>\""
[[ -f "$BACKEND_DIR/package.json" ]] || die "no code in $BACKEND_DIR: run 1-sync.sh and 2-build.sh first"
pg_active || die "PostgreSQL ($(pg_unit)) is not running"

step "Break glass for $EMAIL"
run_db pnpm -s staff:break-glass --email "$EMAIL" --reason "$REASON"
ok "done; the reason is in the audit log (action staff.break_glass)"
finish
