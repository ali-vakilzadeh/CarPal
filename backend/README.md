# Backend

Node.js + NestJS (TypeScript, ESM) **modular monolith** with event-driven workers. See `Docs/02.Detailed project plan.md` §1 and `Docs/41.backend plan.md`. Each module owns its own PostgreSQL schema and talks to other modules only through its public `interface/` or domain events, so any module can later be extracted into its own service.

Build progress and stage-by-stage notes: [`dev_plan.json`](dev_plan.json) — the scratch build (S1–S9) is done; what comes next is its `next_iteration` list. Known risks and their treatment: [`risk_control_plan.json`](risk_control_plan.json).

## Quick start

```bash
cd backend
node tools/setup-local-node.mjs      # once: project-local Node 24 LTS in .tools/ (gitignored)
source tools/use-local-node.sh       # per shell (PowerShell: . tools\use-local-node.ps1)
pnpm install
pnpm db:setup                        # starts the embedded PostgreSQL 16 and installs Docs/43
pnpm test && pnpm test:int           # unit tests, then integration tests against the local DB
pnpm dev                             # api :8080, admin-api :8081, auth :8082, worker, storage :8083
curl http://127.0.0.1:8080/v1/health # {"status":"ok"}
```

The system Node may stay older (another project pins 20.10); the backend needs Node ≥ 24.7 (`crypto.argon2`) and is developed on the local Node 24 from `.node-version`.

| Command                                                 | Does                                                                                      |
| :------------------------------------------------------ | :---------------------------------------------------------------------------------------- |
| `pnpm dev`                                              | Lite mode: db:setup, build, then every deployable in one process (shared lite adapters)   |
| `pnpm start:api` / `:admin-api` / `:auth` / `:worker`   | One deployable from `dist/` (full mode; lite adapters are per process)                    |
| `pnpm build` / `pnpm typecheck`                         | Compile to `dist/` / type-check everything (sources, tools, tests)                        |
| `pnpm lint`                                             | ESLint + dependency-cruiser module-boundary rules (41 §4.2)                               |
| `pnpm test` / `pnpm test:int` / `pnpm test:all`         | Vitest: unit (`*.test.ts`), integration (`*.int.test.ts`, needs the DB), both             |
| `pnpm db:start` / `db:stop` / `db:status`               | Embedded PostgreSQL 16 on `127.0.0.1:54329`, data in `.data/pg`                           |
| `pnpm db:setup` / `db:reset`                            | Install the baseline (`Docs/43.db_setup.sql`) and pending migrations / drop and reinstall |
| `pnpm db:codegen [--verify]`                            | Regenerate Kysely table types in `libs/db/generated/` from the installed DB               |
| `pnpm dev:flags list` / `set <key\|community>… on\|off` | Dev only (`CARPAL_ENV=dev`): feature flags of the dev environment (PWA DI-18)             |
| `pnpm contract:generate` / `contract:check`             | Regenerate / verify `libs/contract/generated/` and the sweep suites from Docs/40          |
| `pnpm contract:tests`                                   | Regenerate the contract sweep suites (`apps/testing/contract/generated/`)                 |
| `pnpm contract:coverage [--strict]`                     | Operations served vs. the 407 of the contract; `--strict` fails on an unexplained 501     |
| `pnpm openapi:generate` / `openapi:check`               | Write / verify `shared/api-contracts/openapi.yaml` (OpenAPI 3.1) against registry, router |

## Local infrastructure ("lite" and "full" mode)

**Lite** (default, no Docker): PostgreSQL 16 comes from the `embedded-postgres` package and runs as a normal server process under `.data/pg` (durability settings are relaxed for speed; never use them in production). pgvector is not available there, so the installer replaces `ext.vector` with a `real[]` domain and skips the HNSW index (`core.schema_info` row `runtime.lite_shims`); only `ai_mcp.embeddings` is affected. Redis, NATS, Elasticsearch and object storage are replaced by in-process adapters behind ports (`libs/infra`): KV store with TTL and sliding windows, event bus with redelivery and dead letters, job queue, an in-memory search index (rebuilt from the database when the worker starts, `CARPAL_SEARCH_REBUILD_ON_START`), signed-URL object storage under `.data/objects`, and email/SMS/push sinks written to `.data/outbox-*.jsonl`. They live in one process, so `pnpm dev` runs all deployables together.

**Full**: `infrastructure/docker/docker-compose.yml` (PostgreSQL + pgvector, Redis, NATS JetStream, OpenSearch, MinIO, Mailpit) with `CARPAL_DB_MODE=external`. Not yet verified.

Configuration: environment variables or `backend/.env` (see `.env.example`), validated at startup (`libs/config`). Development derives every key (JWT Ed25519, KEK, HMAC, pepper) from a public dev master secret; staging and prod refuse to start without `CARPAL_MASTER_SECRET`, and prod requires `CARPAL_STRICT_AUTH=1`.

## Request pipeline (41 §5)

There are no Nest controllers: `libs/http-pipeline` mounts the routes of `operations.json` for each host on `node:http`, so a route outside the contract cannot exist. Nest provides dependency injection, modules and lifecycle; a handler is any provider decorated with `@Operation(<op id>)`. Every request runs, in order:

1. **Router**: unknown path `404`, other method `405` (HEAD/OPTIONS too), invalid path ids `404`.
2. **Load shedding** by priority (`503 OVERLOADED`).
3. **Transport**: `CarPal-Client`, method-override headers, `Content-Type` (`415`), body ≤ 64 KiB (`413`), strict JSON (duplicate keys, `__proto__`, exponents, depth 8, 1,000 keys), SEC-IN-4 text normalization.
4. **Authentication**: EdDSA access token, audience per host, `CarPal-Client` = `client_id`, live session in the KV store; aal3 on the admin plane.
5. **Rate limits** (caller scopes) → 6. **Authorization** (`PUB`/`USR`/`ORG`/`DRV`/`STF`, step-up, `PURP`, `ATT`; failures are `404`, never `403`; `DRV` admits fleet drivers on assigned vehicles only) → organization-scoped rate limits.
6. **Feature flags**; then `501 NOT_IMPLEMENTED` if no handler is bound (GD-05).
7. **Validation** of query and body against the closed schemas (`Vin` fields are upper-cased first; a bad VIN alone is `VIN_INVALID`), signed cursors (query, or the body of POST searches), **idempotency** (`IDEM`) and **If-Match** (`ETAG`).
8. **Handler**: `ctx.tx(fn)` runs one transaction with `core.set_context(...)`; `publishEvent` and `writeAudit` write in the same transaction.
9. **Response**: checked against the contract in dev/test (and `AUD` operations must have written an audit entry), `ETag`, `Cache-Control`, security headers, problem+json errors.

## Layout

| Folder                                                                         | Responsibility                                                                                                                                                                                                                                         | WP            |
| :----------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------ |
| `apps/`                                                                        | Deployable entry points: `api`, `admin-api`, `auth` (authorization server), `worker` (41 §1 D1–D3, D5).                                                                                                                                                | WP1, WP2      |
| `api-gateway/`                                                                 | Per-portal BFFs (consumer, portal, admin), later.                                                                                                                                                                                                      | WP19, WP20    |
| `libs/`                                                                        | Platform libraries L1–L22 of 41 §2.2 (contract registry, HTTP pipeline, auth, tenancy, outbox, …). No business rules.                                                                                                                                  | WP1, WP2      |
| `libs/contract`                                                                | L1: operation registry and JSON Schemas generated from Docs/40 (contract 1.1.0: 407 operations, 459 routes).                                                                                                                                           | WP1           |
| `libs/db`, `libs/tenancy`                                                      | Pools per login role, Kysely types, SQLSTATE → error mapping; `TxRunner` (RLS context in every transaction).                                                                                                                                           | WP1           |
| `libs/http-pipeline`, `libs/runtime`                                           | Contract router and the 41 §5 pipeline; Nest `PlatformModule` and the HTTP host.                                                                                                                                                                       | WP1           |
| `libs/{auth,authz,rate-limit,idempotency,concurrency,flags,audit,outbox,jobs}` | L3, L4, L8, L6, L7, L14, L15, L9, L10.                                                                                                                                                                                                                 | WP1, WP2      |
| `libs/{crypto,link-tokens,i18n,geo,region-config,observability,infra,config}`  | L11, L12, L13, L19, L20, L21, infrastructure ports and adapters, configuration.                                                                                                                                                                        | WP1           |
| `libs/{consent-gate,entitlements,safety-check}`                                | L16–L18 guard shells; identity, billing and taxonomy implement them (S3).                                                                                                                                                                              | WP1           |
| `libs/platform`                                                                | Platform operations of 40 §22: `health.get`, `config.client`, `jobs.get`, `jobs.cancel`.                                                                                                                                                               | WP1           |
| `libs/csv`                                                                     | Strict RFC 4180 CSV parser with the SEC-IN-11 limits, and the formula-safe CSV writer (imports, error reports, exports).                                                                                                                               | WP1, WP7      |
| `libs/testing`, `apps/testing`                                                 | L22: HTTP client, fixtures, BOLA/BFLA matrices from the registry; test app factory and the contract-wide integration tests.                                                                                                                            | WP21          |
| `modules/identity`                                                             | Signup/login, roles, permissions, sessions, MFA, consent, org membership, onboarding, data export/deletion.                                                                                                                                            | WP2           |
| `modules/organization`                                                         | Organizations and locations, verification, provider profiles and capability portfolio, vendor profiles.                                                                                                                                                | WP3, WP6, WP7 |
| `modules/billing`                                                              | Plans, entitlements, manual plan assignment, trials, payment placeholder.                                                                                                                                                                              | WP3           |
| `modules/taxonomy`                                                             | Brands/models/series, service systems and tasks, parts, symptoms, review tags, mappings, synonyms.                                                                                                                                                     | WP4           |
| `modules/vehicle`                                                              | Vehicles, VIN, service records, documents, issues, maintenance reminders, OBDII placeholder.                                                                                                                                                           | WP5           |
| `modules/inventory`                                                            | Vendor inventory, fitment, CSV import, stock inquiries, price visibility, catalog quality.                                                                                                                                                             | WP7           |
| `modules/discovery`                                                            | Search queries, geo/semantic/contextual search, ranking, matching, match reasons.                                                                                                                                                                      | WP8           |
| `modules/trust`                                                                | Reviews, sub-ratings, responses, review requests, disputes, trust signals, badges.                                                                                                                                                                     | WP9           |
| `modules/appointment`                                                          | Appointment state machine, provider calendar, reminders, pre-visit reports.                                                                                                                                                                            | WP10          |
| `modules/fleet`                                                                | Fleet vehicles, drivers, approvals, cost logging, fleet reports and export.                                                                                                                                                                            | WP11          |
| `modules/community`                                                            | Follows, favorites, showcases, posts, Q&A, helpful reactions.                                                                                                                                                                                          | WP12          |
| `modules/media`                                                                | Uploads, thumbnails, EXIF stripping, malware scan, redaction, media consent.                                                                                                                                                                           | WP13          |
| `modules/notification`                                                         | In-app, email, push, and SMS notifications, preferences, delivery tracking.                                                                                                                                                                            | WP14          |
| `modules/admin`                                                                | Moderation queues, user/org admin, feature flags, AI kill switch.                                                                                                                                                                                      | WP15          |
| `modules/analytics`                                                            | Event collection, KPI and success-metric dashboards, audit log service.                                                                                                                                                                                | WP16          |
| `modules/ai-mcp`                                                               | Thin API facade for §21 AI operations through the MCP port (the MCP gateway and orchestrator live in `ai-mcp/`).                                                                                                                                       | WP17, WP18    |
| `workers/`                                                                     | Event consumers and background jobs (41 §2.4): `outbox-relay` (W1), `consumer-host` (every `EventConsumer`), `media-processor` (W6), `import-jobs` (W7), `scheduler` (W15, leader lock; module rules are providers of the `*-worker.module.ts` files). | WP7–WP16      |
| `tools/`                                                                       | Dev and build tooling: DB runtime and installer, contract generator, local Node setup. Never imported by deployable code.                                                                                                                              | WP1           |

Every module follows the layout of 41 §4.2 (`<name>.module.ts`, `interface/`, `api/`, `application/`, `domain/`, `infrastructure/`, `events/`, `projections/`, `tests/`); folders are created when a stage adds code to them. `pnpm lint` fails if one module imports another module's internals.

## Contract, sweep and OpenAPI

Docs/40 is the single source. `pnpm contract:generate` turns it into the registry (`libs/contract/generated/`); everything else is derived from that and checked in CI:

- **Router**: only registry routes exist on each host (the request pipeline above).
- **Contract sweep** (S9b, 40 Appendix C): `pnpm contract:tests` generates one suite per module (`apps/testing/contract/generated/<module>.contract.int.test.ts`, every HTTP route). For each route a hand-written **resolver** in `apps/testing/contract/resolvers/<module>.ts` builds real fixtures and describes the owner's call; the runner (`apps/testing/contract/runner.ts`) derives the checks from the sec line: closed schemas, the success response, admin-plane mechanics (purpose, reason, four-eyes), same-organization BFLA, fleet drivers without an assignment (SEC-AZ-7), BOLA (refusals other than 404 must name their code, carry no data and answer a non-existent record alike), the AI kill switch and SEC-OUT-1 projections. **Every new operation needs a resolver** — its generated suite fails without one — and a changed operation needs `pnpm contract:generate && pnpm contract:tests`. `pnpm vitest run apps/testing/contract --reporter=verbose` prints one stats line per module (owner calls, negatives, BFLA, fleet-driver, BOLA and existence-oracle checks).
- **OpenAPI**: `pnpm openapi:generate` writes `shared/api-contracts/openapi.yaml` (OpenAPI 3.1, JSON Schema 2020-12) from the registry and schemas plus the server-defined `Json<…>` schemas (AI payloads from `modules/ai-mcp/domain/payloads.ts`, analytics event properties from `modules/analytics/domain/events.ts`). Never edit it; `pnpm openapi:check` fails when it is stale, when a schema does not compile or a reference does not resolve, or when it and the router of any host disagree. Each operation carries `x-carpal-op-id`, `x-carpal-host`, `x-carpal-sec` (the raw sec line), `x-carpal-security` and `x-carpal-status` (`implemented`, `deferred-post-mvp`, `storage-listener`).
- **Coverage**: `pnpm contract:coverage --strict` — 406 of 407 operations are served (media.upload_put by the storage listener); `auth.social_start` answers 501 by decision (PM-01). A deferred operation is listed with its reason in `tools/contract/coverage.ts` (`DEFERRED_OPERATIONS`), never left silent.

## CI

`.github/workflows/backend-ci.yml` runs in lite mode on every push or pull request touching `backend/`, `Docs/` or `shared/api-contracts/`: a **static** job (lint, typecheck, build, format:check, contract:check, openapi:check, contract:coverage --strict, unit tests) and an **integration** job (embedded PostgreSQL, db:setup, db:codegen --verify, the integration project on one worker). Together they are `pnpm test:all`, about 8 minutes locally (the sweep ≈ 3.5 of them); the integration job allows 45 minutes. On Linux the `@embedded-postgres/linux-x64` package needs its install script (allowed in `package.json` `pnpm.onlyBuiltDependencies`).

## Authorization notes

- **Fleets** (SEC-AZ-7): fleet_owner, fleet_manager, fleet_maintenance_coordinator and fleet_viewer see the whole fleet; a **fleet_driver** sees only the vehicles assigned to them (one active assignment per vehicle, set by FC) — their vehicle and appointment reads (`DRV`), the media they uploaded or that is attached to an assigned vehicle's records, and no fleet AI records. Further fleet roles (operators, mechanics, dispatch) are an open decision (OQ-18, RCP-03).
- **Admin plane**: a `CarPal-Access-Purpose` is accepted for any open item in the staff member's queue; binding it to the record being read is planned (RCP-01). Until then, review `pii.read` audit entries against their purposes.
- **Reserved, not read yet** (PM-01, Google/Apple sign-in): `CARPAL_OIDC_GOOGLE_CLIENT_ID`, `CARPAL_OIDC_GOOGLE_CLIENT_SECRET`, `CARPAL_OIDC_APPLE_CLIENT_ID`, `CARPAL_OIDC_APPLE_TEAM_ID`, `CARPAL_OIDC_APPLE_KEY_ID`, `CARPAL_OIDC_APPLE_PRIVATE_KEY`.

## Conventions

- **Imports**: package.json subpath imports — `#libs/*`, `#modules/*`, `#workers/*`, `#apps/*` — with `.js` extensions (ESM). They resolve to TypeScript sources under the `source` condition (tsx, Vitest, tsc) and to `dist/` at runtime.
- **Contract first**: never hand-write routes, enums or error codes that 40 defines; use `#libs/contract/index.js`. After a change to Docs/40, run `pnpm contract:generate` (CI runs `contract:check`).
- **Database**: Docs/43 is authoritative; never edit generated files. Integration tests connect as the real login roles (`carpal_api`, …), never as superuser, so row-level security is always on.
- **Tests**: `*.test.ts` next to the code (unit, no DB); `*.int.test.ts` for anything that needs PostgreSQL. Integration tests share one database and never reset it: fixtures (`libs/testing`) use fresh UUIDv7 ids and `@test.carpal.app` emails, so tests assert only on their own rows. `apps/testing/test-app.ts` boots any host with ad-hoc handlers bound to contract operations.
- **Handlers**: one class per operation, `@Operation('<op.id>')`, `handle(ctx)` returns `{ status?, body, headers?, cache? }`. Use `ctx.tx`, never a pool; throw `ApiError(code)` with codes of the catalog only.
