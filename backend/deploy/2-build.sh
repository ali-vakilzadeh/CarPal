#!/usr/bin/env bash
# Update step 2: install dependencies, build, check and test the synced code, then install or
# migrate the databases.
#
#   sudo bash 2-build.sh              everything enabled in deploy.conf
#   sudo bash 2-build.sh --skip-db    build and checks only
#   sudo bash 2-build.sh --quick      install + build + database (no checks, no tests)
#
# Build tools run as root in a clean environment (no service secrets). Integration tests are never
# run here: they write fixtures into whatever database they reach. CI runs them (deploy.md).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root
start_log

SKIP_DB=0
for a in "$@"; do
  case "$a" in
    --skip-db) SKIP_DB=1 ;;
    --quick) RUN_CONTRACT_CHECKS=0 RUN_TYPECHECK=0 RUN_LINT=0 RUN_UNIT_TESTS=0 ;;
    *) die "unknown option $a" ;;
  esac
done

[[ -f "$BACKEND_DIR/package.json" ]] || die "no code in $BACKEND_DIR: run 1-sync.sh first"
if service_installed && service_active; then warn "$SERVICE_NAME is running: the new build replaces dist/ under it (restart with 4-start.sh)"; fi

# ------------------------------------------------------------------- toolchain
step "Toolchain"
[[ -x "$NODE_BIN/node" ]] || die "node not found in $NODE_BIN (run server-setup.sh)"
want="$(tr -d ' \r\n' <"$BACKEND_DIR/.node-version")"
have="$("$NODE_BIN/node" --version | sed 's/^v//')"
if [[ "${want%%.*}" != "${have%%.*}" ]]; then die "Node $have installed, backend/.node-version wants $want (re-run server-setup.sh)"; fi
if [[ "$want" != "$have" ]]; then warn "Node $have installed, backend/.node-version says $want (same major: continuing)"; fi
pm="$(sed -n 's/.*"packageManager": "\(pnpm@[^"]*\)".*/\1/p' "$BACKEND_DIR/package.json")"
run_clean "$NODE_BIN/corepack" prepare "$pm" --activate >/dev/null
ok "node $have, $(run_clean pnpm --version | sed 's/^/pnpm /')"

# --------------------------------------------------------------- install + build
step "pnpm install --frozen-lockfile"
run_clean pnpm install --frozen-lockfile --reporter=append-only
ok "dependencies match pnpm-lock.yaml"

step "pnpm build (clean dist/)"
rm -rf "$BACKEND_DIR/dist"
run_clean pnpm build
[[ -f "$BACKEND_DIR/dist/apps/dev/main.js" ]] || die "build did not produce dist/apps/dev/main.js"
ok "dist/ built"

# ----------------------------------------------------------------------- checks
if [[ "$RUN_CONTRACT_CHECKS" == "1" ]]; then
  step "Contract checks"
  run_clean pnpm contract:check
  run_clean pnpm openapi:check
  run_clean pnpm contract:coverage --strict | tail -n 4
  ok "registry, sweep suites and OpenAPI match Docs/40; no unexplained 501"
fi
if [[ "$RUN_TYPECHECK" == "1" ]]; then
  step "pnpm typecheck"
  run_clean pnpm typecheck
  ok "types"
fi
if [[ "$RUN_LINT" == "1" ]]; then
  step "pnpm lint"
  run_clean pnpm lint
  ok "lint and module boundaries"
fi
if [[ "$RUN_UNIT_TESTS" == "1" ]]; then
  step "pnpm test (unit project)"
  run_clean pnpm test
  ok "unit tests"
fi

# --------------------------------------------------------------------- database
if [[ "$SKIP_DB" == "1" || "$RUN_DB_SETUP" != "1" ]]; then
  warn "database step skipped"
  finish
  exit 0
fi
step "Database ($DB_NAME, $ANALYTICS_DB_NAME on 127.0.0.1:$PG_PORT)"
pg_active || die "PostgreSQL ($(pg_unit)) is not running"
installed="$(cd / && runuser -u postgres -- psql -p "$PG_PORT" -Atc "SELECT count(*) FROM pg_database WHERE datname = '$DB_NAME'")"
if [[ "$installed" == "0" ]]; then
  warn "database $DB_NAME does not exist yet: first install of the Docs/43 baseline (roles, both databases, seeds)"
  status=""
else
  status="$(run_db pnpm -s db:status 2>&1)" || die "pnpm db:status failed:
$status"
  printf '%s\n' "$status" | sed 's/^/    /'
fi
if grep -q 'changed since install' <<<"$status"; then
  # Docs/43 is the baseline of a fresh install only. Once a database holds data, every schema change
  # must be a numbered file in database/migrations (database/migrations/README.md); db:reset would erase it.
  [[ "${ALLOW_BASELINE_DRIFT:-0}" == "1" ]] || die "Docs/43.db_setup.sql changed since this database was installed, and no migration covers it.
  Add the change as database/migrations/NNNN_name.sql (and keep Docs/43 in step), upload, sync and build again.
  Set ALLOW_BASELINE_DRIFT=1 only if you know the change is already applied."
  warn "baseline drift accepted (ALLOW_BASELINE_DRIFT=1)"
fi
run_db pnpm -s db:setup
ok "databases installed / migrated"
finish
