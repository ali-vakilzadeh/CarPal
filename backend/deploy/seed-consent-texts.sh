#!/usr/bin/env bash
# Consent-text seed (backend S26a.T5): loads the owner's reviewed consent texts (13 consent types, EN and FA) as draft
# versions in the pilot region. Safe to run again: a consent type that already has the file's version is left as it
# is, and published versions are never changed. Publishing stays in the admin console (Policies, A-POL-01, four eyes).
#
#   sudo bash seed-consent-texts.sh                         $CONFIG_DIR/consent-texts.json
#   sudo bash seed-consent-texts.sh /path/consent-texts.json
#
# The file is the reviewed copy of database/seeds/consent-texts.template.json with meta.status "approved" and no
# [bracketed] placeholder left; the command refuses anything else.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root
start_log

FILE="${1:-$CONFIG_DIR/consent-texts.json}"
[[ -f "$FILE" ]] || die "no consent texts at $FILE: copy the reviewed database/seeds/consent-texts.json there"
[[ -f "$BACKEND_DIR/package.json" ]] || die "no code in $BACKEND_DIR: run 1-sync.sh and 2-build.sh first"
pg_active || die "PostgreSQL ($(pg_unit)) is not running"

step "Consent texts from $FILE"
run_db pnpm -s seed:consent-texts --file "$FILE"
ok "done; publish the drafts in the admin console (Policies), one per consent type"
finish
