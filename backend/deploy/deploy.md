# Deploying the CarPal backend on a VPS

This guide installs the CarPal backend on one Ubuntu server, deploys it from a staging folder that you fill with WinSCP, and updates it in a few commands. The scripts next to this file do the work. This guide explains what they do, in which order, and what to check.

> **Read "What this deployment is" first.** Today the backend can run in **lite mode** only: one Node.js process, the PostgreSQL that runs on the server, and no external mail, SMS or push service. That suits a test or pilot server. It is not yet a public production setup. The gaps are listed in [Known limitations](#known-limitations), and each one maps to an item of `dev_plan.json` → `next_iteration`.

Contents:

1. [What this deployment is](#what-this-deployment-is)
2. [Server layout](#server-layout)
3. [Server requirements](#server-requirements)
4. [What gets installed](#what-gets-installed)
5. [The scripts](#the-scripts)
6. [First deployment](#first-deployment)
7. [Updating](#updating)
8. [Database changes](#database-changes)
9. [Configuration](#configuration)
10. [Backups, restore and rollback](#backups-restore-and-rollback)
11. [Operations](#operations)
12. [Known limitations](#known-limitations)
13. [Troubleshooting](#troubleshooting)

---

## What this deployment is

```
            Internet (HTTPS)
                  │
        ┌─────────▼──────────┐   TLS (Let's Encrypt), per-client rate limits,
        │       nginx        │   body-size limits
        └─┬────────┬───────┬─┘
api.<domain>  id.<domain>  media.<domain>        (admin-api.<domain>: not published)
          │        │       │
   127.0.0.1:8080  :8082   :8083       :8081
        ┌─▼────────▼───────▼────────────▼─┐
        │  carpal-backend (systemd)       │  ONE Node.js process: api, auth, admin-api,
        │  node dist/apps/dev/main.js     │  worker (outbox, consumers, scheduler),
        └──────┬───────────────────┬──────┘  signed-URL storage listener
               │                   │
   PostgreSQL 16 (127.0.0.1:5432)  /carpal/data  (lite runtime files)
   data in /carpal/db              /carpal/upload (media objects)
```

- **One process.** The backend has four deployables (api, admin-api, auth, worker) plus a storage listener. In lite mode they share in-process adapters: key-value store, event bus, job queue and search index (GD-04). So they must run in **one** process, the same entry point `pnpm dev` uses. The full-mode adapters (Redis, NATS, OpenSearch, S3, SMTP, SMS, push) are still skeletons, so separate services are not possible yet.
- **External PostgreSQL.** The database is the Ubuntu PostgreSQL 16 service (`CARPAL_DB_MODE=external`), with its data directory under `/carpal/db`. The embedded PostgreSQL used on developer machines is not used here. `pnpm db:setup` installs `Docs/43.db_setup.sql` on the first run and applies pending migrations after that. This path was tested against a PostgreSQL 16 server during S9c.
- **Environment `staging`, strict authentication on.** It has real secrets, and responses are not re-validated against the contract. `CARPAL_STRICT_AUTH=1`: the consumer PWA's tokens are DPoP-bound and it authenticates with `private_key_jwt`. `prod` waits for the rest of NI-01 (see [Configuration](#environment-choice)).
- **Code, data and secrets are separate.** Code lives in `/carpal/backend/src`, data in `/carpal/data`, `/carpal/upload` and `/carpal/db`, and secrets in `/carpal/config`. An update replaces the code and never touches the data.

### Public hosts

Production uses `DOMAIN=carpals.ir`. Every host comes from `DOMAIN`, and `deploy.conf` can override each one.

| Host                   | Serves                              | Reached by                                                          |
| :--------------------- | :---------------------------------- | :------------------------------------------------------------------ |
| `api.carpals.ir`       | the backend API (8080)              | every client outside this server, such as the mobile app            |
| `id.carpals.ir`        | the authorization server (8082)     | the same clients, for sign-in and tokens                            |
| `media.carpals.ir`     | signed uploads and downloads (8083) | browsers and apps                                                   |
| `pwa.carpals.ir`       | the consumer PWA (3000)             | browsers                                                            |
| `carpals.ir`           | a 301 to `https://www.carpals.ir`   | browsers                                                            |
| `www.carpals.ir`       | the landing site (`landing/`)       | browsers and QR codes                                               |
| `fleet.carpals.ir`     | the web app's fleet view (later)    | will redirect to `web.`; shows the coming-soon page until then      |
| `web.carpals.ir`       | the business portal (not built yet) | named in `backend.env` only; no nginx block until the portal exists |
| `admin-api.carpals.ir` | the admin plane (8081)              | not published ([Admin plane](#admin-plane))                         |

`www.<DOMAIN>` and `<DOMAIN>` are the landing site, which runs on cPanel hosting (`landing/deploy/deploy.md`), so leave their DNS alone. That host also has a wildcard DNS record, which catches every name without its own record. So `pwa.`, `api.`, `id.` and `media.<DOMAIN>` each need their own A/AAAA record pointing at this server, or certbot fails.

`carpals.ir` is the Iran market's domain. Another market has its own domain and its own deployment, so keep hosts in `deploy.conf` and `backend.env` rather than in code.

A client on this server, such as the PWA's BFF, connects to `127.0.0.1:8080` directly. Its tokens and DPoP proofs still name `https://api.carpals.ir`, because `CARPAL_API_AUDIENCE` is the API's identity whichever way a client connects. A client on another server uses `https://api.carpals.ir`.

## Server layout

```
/carpal/                              root:root     755  (traversable; everything below is restricted)
├── backend/                          root:carpal   750
│   └── src/                          root:carpal   750  CODE — replaced by 1-sync.sh on every update
│       ├── backend/                                     the Node.js package (@carpal/backend)
│       │   ├── dist/                                    build output (2-build.sh)
│       │   ├── node_modules/                            dependencies (2-build.sh, kept between updates)
│       │   ├── deploy/                                  these scripts and templates
│       │   └── .data -> /carpal/data                    symlink (the backend's fixed data path)
│       ├── Docs/                                        contract (40), database baseline (43), taxonomy (44)
│       ├── shared/                                      region config, OpenAPI file
│       ├── database/                                    migrations
│       └── .release                                     what was synced, and when
├── config/                           root:carpal   750  SECRETS — never inside the code folder
│   ├── backend.env                   root:carpal   640  service environment (systemd EnvironmentFile)
│   ├── db-admin.env                  root:root     600  PostgreSQL superuser login (database tools only)
│   └── deploy.conf                   root:carpal   640  settings of these scripts
├── data/                             carpal:carpal 750  RUNTIME FILES (lite mode)
│   ├── outbox-mail.jsonl                                every e-mail the backend "sends"
│   ├── outbox-sms.jsonl, outbox-push.jsonl              every SMS / push message
│   ├── dead-letter.jsonl                                events no consumer could handle
│   └── objects -> /carpal/upload                        symlink
├── upload/                           carpal:carpal 750  MEDIA OBJECTS (uploads, thumbnails, exports)
├── db/                               postgres      700  POSTGRESQL DATA (16/main)
├── backups/                          root:root     700  one folder per 0-predeploy.sh run
│   └── 20261025-101500/                                 code.tar.gz, config.tar.gz, carpal.dump,
│                                                        carpal_analytics.dump, globals.sql, data.tar.gz,
│                                                        upload/, MANIFEST, SHA256SUMS
└── logs/                             root:root     750  deploy-YYYYMMDD.log (the service logs to journald)

/home/root/staging/                   root          700  WinSCP upload target: the whole repository
/etc/systemd/system/carpal-backend.service               installed from templates/carpal-backend.service
/etc/nginx/sites-available/carpal                        installed from templates/nginx-carpal.conf
/etc/nginx/snippets/carpal-proxy.conf                    shared proxy settings
/opt/node-v24.x.y-linux-x64, /opt/node                   Node.js; /usr/local/bin/{node,npm,npx,corepack,pnpm}
```

The service runs as the system user **`carpal`**. It can read the code and `backend.env`, and it can write only `/carpal/data` and `/carpal/upload`. systemd enforces this too: `ProtectSystem=strict`, with `ReadWritePaths` set to those two folders. `3-permissions.sh` checks it on every deployment. It also checks that the service user cannot read the superuser login or change the code.

Why the symlinks: the backend writes its lite-mode files to `backend/.data`. That path is fixed in the code (`libs/config/paths.ts`). Media objects go to `backend/.data/objects`. The links send both outside the code folder, and `1-sync.sh` never copies or deletes `.data`.

All paths come from `deploy.conf`, so change them there (see `deploy.conf.example`), not in the scripts.

## Server requirements

|           | Minimum                                                                        | Notes                                                                                                                        |
| :-------- | :----------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| OS        | **Ubuntu 24.04 LTS** (x86-64 or arm64)                                         | PostgreSQL 16 and pgvector come from the Ubuntu archive. Other releases need the PGDG repository.                            |
| CPU / RAM | 2 vCPU, **4 GB RAM** (or 2 GB plus 2 GB swap)                                  | `tsc` and the unit tests need memory during `2-build.sh`. Runtime needs much less.                                           |
| Disk      | 40 GB SSD                                                                      | Code with `node_modules` and the pnpm store is under 1 GB. Plan for uploads, the database and `KEEP_BACKUPS` copies of both. |
| DNS       | A/AAAA records for `api.`, `id.`, `media.` and `pwa.` (and later `admin-api.`) | Needed before `certbot`.                                                                                                     |
| Access    | SSH as root (or sudo), WinSCP with SFTP                                        |                                                                                                                              |
| Outbound  | HTTPS to `nodejs.org`, `registry.npmjs.org`, the Ubuntu mirrors, Let's Encrypt | For setup and `pnpm install`.                                                                                                |

Add swap on a small server:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## What gets installed

`server-setup.sh` installs and configures all of this:

| Component                      | Version / source                                                                 | Why                                                                                                                                     |
| :----------------------------- | :------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                        | `backend/.node-version` (24.x LTS), official tarball, SHA-256 checked, in `/opt` | Runtime and build (`engines: node >= 24.7`, `crypto.argon2`).                                                                           |
| pnpm                           | through corepack, the exact version in `backend/package.json` `packageManager`   | The project uses pnpm and `pnpm-lock.yaml`, not npm.                                                                                    |
| PostgreSQL 16 + pgvector       | Ubuntu packages `postgresql-16`, `postgresql-16-pgvector`                        | Database. With pgvector present, `ai_mcp.embeddings` uses real vectors instead of the lite shim. pg_trgm is part of the server package. |
| nginx                          | Ubuntu package                                                                   | TLS termination, per-client rate limits, body limits, host routing.                                                                     |
| certbot + nginx plugin         | Ubuntu packages                                                                  | Let's Encrypt certificates and renewal (systemd timer).                                                                                 |
| rsync, curl, openssl, xz-utils | Ubuntu packages                                                                  | Sync, health checks, secret generation, Node.js unpacking.                                                                              |
| ufw                            | Ubuntu package                                                                   | Firewall. Enabled only with `ENABLE_UFW=1`.                                                                                             |

Not installed, because lite mode doesn't use them: Docker, Redis, NATS, OpenSearch, MinIO, an SMTP server.

## The scripts

All scripts are in `backend/deploy/`. Run them as root with `bash <script>`. They need no execute bit, and each run is logged to `/carpal/logs/deploy-YYYYMMDD.log`.

| Script                          | When                  | What it does                                                                                                                                                                                                                                                                                                                      |
| :------------------------------ | :-------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server-setup.sh`               | Once (safe to re-run) | Installs packages, Node.js and pnpm. Creates the `carpal` user and the folder layout. Moves the PostgreSQL cluster to `/carpal/db`. Generates `backend.env` and `db-admin.env` with random secrets. Installs the systemd unit and the nginx site. Never overwrites existing secrets, config or databases.                         |
| `0-predeploy.sh`                | Every update          | Stops the service and makes the backup folder private. Backs up the code, the config, both databases, the roles, the runtime data and the uploads (uploads as hard-linked snapshots, so they are fast). Prunes old backups. `--no-stop` backs up while running.                                                                   |
| `1-sync.sh`                     | Every deployment      | Copies `backend/ Docs/ shared/ database/` from staging to `/carpal/backend/src` with `rsync --delete`. Never touches `node_modules`, `dist`, `.data`, `.tools`, `.env` or `.git`. Creates the data symlinks and fixes Windows line endings in the scripts. `--dry-run` shows the changes. Refuses to run while the service is up. |
| `2-build.sh`                    | Every deployment      | `pnpm install --frozen-lockfile`, a clean `pnpm build`, the contract checks (`contract:check`, `openapi:check`, `contract:coverage --strict`), `typecheck`, the unit tests, then `pnpm db:setup` and a check that no migration is left pending. Stops if `Docs/43` changed without a migration. `--skip-db`, `--quick`.           |
| `3-permissions.sh`              | Every deployment      | Owners and modes from the [layout](#server-layout), then an access check run as the service user.                                                                                                                                                                                                                                 |
| `4-start.sh`                    | Every deployment      | Restarts the service and waits for `/v1/health`. Then checks that auth, admin-api and storage answer, and that storage sends `Cross-Origin-Resource-Policy: cross-origin` (R-23). On failure it prints the last 80 log lines.                                                                                                     |
| `update.sh`                     | Every update          | Runs 0 → 1 → 2 → 3 → 4 and stops at the first failure.                                                                                                                                                                                                                                                                            |
| `staff-bootstrap.sh`            | Once, then as needed  | Creates the staff accounts of `/carpal/config/staff-bootstrap.json` that do not exist (initial password from `CARPAL_STAFF_INITIAL_PASSWORD`); `--reissue <email>` gives an expired initial password 7 more days ([Admin plane](#admin-plane)).                                                                                   |
| `staff-break-glass.sh`          | Emergencies           | Resets one staff account's security keys and recovery codes, with a reason ([Admin plane](#admin-plane)).                                                                                                                                                                                                                         |
| `mail-test.sh`                  | After mail changes    | Sends one test message with the `backend.env` mail settings from this server ([Email](#email)).                                                                                                                                                                                                                                   |
| `seed-consent-texts.sh`         | Once per text version | Loads the reviewed consent texts as drafts ([Consent texts](#consent-texts)).                                                                                                                                                                                                                                                     |
| `lib.sh`, `deploy.conf.example` | —                     | Shared helpers and default settings.                                                                                                                                                                                                                                                                                              |
| `templates/`                    | —                     | `backend.env`, `db-admin.env`, the systemd unit and the nginx site, with `@PLACEHOLDERS@`.                                                                                                                                                                                                                                        |

## First deployment

### 1. DNS

Add A/AAAA records for `api.<domain>`, `id.<domain>`, `media.<domain>` and `pwa.<domain>` (the consumer PWA) pointing at the server. Leave `www.<domain>` and the bare `<domain>` on the landing site's host ([Public hosts](#public-hosts)). `admin-api.<domain>` is optional (see [Admin plane](#admin-plane)).

### 2. Upload the repository and prepare the server

Upload the repository to `/home/root/staging/` once, as in [step 4](#4-upload-the-code-with-winscp), so the setup script is on the server. Then:

```bash
bash /home/root/staging/backend/deploy/server-setup.sh     # first run: creates /carpal/config/deploy.conf, stops
nano /carpal/config/deploy.conf                            # set DOMAIN, LETSENCRYPT_EMAIL (optional: ENABLE_UFW=1)
bash /home/root/staging/backend/deploy/server-setup.sh     # second run: installs everything
```

The second run ends with the next commands to type. If the Ubuntu package created a default PostgreSQL cluster under `/var/lib/postgresql`, the script replaces it with one in `/carpal/db`. It only does this while that cluster is empty. If it holds databases, the script stops (see [Troubleshooting](#troubleshooting)).

### 3. Review the secrets and public names

```bash
nano /carpal/config/backend.env
```

Check these values:

- `CARPAL_ISSUER`, `CARPAL_API_AUDIENCE`, `CARPAL_MEDIA_BASE_URL`: the public `https://` names. Tokens carry the issuer and audience, so changing them later signs everybody out.
- `CARPAL_OAUTH_REDIRECT_URIS`, `CARPAL_WEBAUTHN_RP_ID`, `CARPAL_WEBAUTHN_ORIGINS`: the exact app and web origins of your clients. The consumer PWA is `https://pwa.<domain>` (`WEB_HOST`) and the business portal is `https://web.<domain>` (`PORTAL_HOST`).
- `CARPAL_LINK_BASE_URL`, `CARPAL_MEDIA_CORS_ORIGINS`: emailed links open `<PWA origin>/l/…`, and the PWA's browsers upload to the media host. Both name the PWA origin.
- `CARPAL_SIGNIN_URL`: the hosted sign-in UI (a frontend). The default is `<issuer>/signin`.
- `CARPAL_MCP_MODE`: `unavailable` (AI answers 503, everything else works) or `stub` (deterministic demo results).

Copy `/carpal/config/backend.env` and `db-admin.env` to a password manager now. `CARPAL_MASTER_SECRET` derives the token signing keys **and the encryption key of private uploads**. Losing or changing it signs everybody out and makes encrypted media unreadable.

### 4. Upload the code with WinSCP

1. Connect with **SFTP** as root, and go to `/home/root/staging/`.
2. **Preferences → Transfer → Default → Transfer mode: Binary.** Text mode rewrites line endings, which breaks the contract checksum checks (`contract:check`) and the scripts.
3. Set a **file mask** that excludes local build output and data: `| node_modules/; .data/; .tools/; dist/; .git/; coverage/`. `backend/.data` on a developer machine holds a whole local database and its files. Never upload it.
4. Upload the **repository root**, the folder that holds `backend/`, `Docs/`, `shared/` and `database/`. Other folders (`frontend/`, `mobile/`, …) may come along; `1-sync.sh` ignores them.

For later updates, **Commands → Synchronize** (local → remote, with "Delete files", the same file mask, and comparison by time and size) uploads only what changed.

### 5. Build and start

```bash
bash /home/root/staging/backend/deploy/1-sync.sh
bash /carpal/backend/src/backend/deploy/2-build.sh       # first run: installs the Docs/43 baseline
bash /carpal/backend/src/backend/deploy/3-permissions.sh
bash /carpal/backend/src/backend/deploy/4-start.sh
```

On the first run, `2-build.sh` installs the database baseline: the cluster roles with the passwords from `backend.env`, both databases, all tables, row-level security, and the seeds for the environment. `4-start.sh` ends with `ok api: {"status":"ok"}`.

### 6. TLS

```bash
certbot --nginx -d api.<domain> -d id.<domain> -d media.<domain> -d pwa.<domain> --email <you> --agree-tos --redirect
```

certbot adds the TLS server blocks to `/etc/nginx/sites-available/carpal` and installs a renewal timer (`systemctl list-timers | grep certbot`). After that, `server-setup.sh` leaves the site file alone. If you change the template later, apply the change by hand.

### 7. Check from outside

```bash
curl -s https://api.<domain>/v1/health                               # {"status":"ok"}
curl -s https://id.<domain>/.well-known/openid-configuration | head -c 300
curl -sI https://api.<domain>/v1/health | grep -i -E 'strict-transport|carpal-contract'
```

## Updating

After uploading the new code to `/home/root/staging/` (WinSCP Synchronize):

```bash
bash /home/root/staging/backend/deploy/update.sh            # 0 → 1 → 2 → 3 → 4
```

Or step by step, which is useful when you want to look at the output between steps:

```bash
bash /home/root/staging/backend/deploy/0-predeploy.sh      # stop + backup
bash /home/root/staging/backend/deploy/1-sync.sh           # --dry-run first if unsure
bash /carpal/backend/src/backend/deploy/2-build.sh         # --quick skips checks and unit tests
bash /carpal/backend/src/backend/deploy/3-permissions.sh
bash /carpal/backend/src/backend/deploy/4-start.sh
```

Run steps 0 and 1 from the **staging** copy, so the newest scripts are used. Run steps 2 to 4 from the **production** copy, which `1-sync.sh` has just refreshed. `update.sh` does exactly this.

How long an update takes:

- **Downtime** runs from `0-predeploy.sh` to `4-start.sh`.
- **`pnpm install`** takes seconds when `node_modules` is kept and the lockfile didn't change.
- **The build and checks** take a few minutes.
- **`2-build.sh --quick`** skips the checks and unit tests. Use it for an urgent fix, when CI has already tested the commit.
- **If the build or the checks fail**, the service stays stopped. Fix the problem and re-run from `2-build.sh`, or [roll back](#rollback).

**Integration tests never run on the server.** They write test fixtures into whatever database they reach, and the embedded test cluster cannot run as root. GitHub Actions runs them on every push (`.github/workflows/backend-ci.yml`), so deploy commits whose CI run is green.

## Database changes

- `Docs/43.db_setup.sql` is the **baseline of a fresh install only**. `pnpm db:setup` records its SHA-256. Later runs apply only the numbered files in `database/migrations/` (`NNNN_name.sql`, see `database/migrations/README.md`), once each, in name order.
- During development the team changed Docs/43 in place and ran `pnpm db:reset`. **On the server, that would erase all data.** Once the server holds real data, every schema change needs a migration file. Keep Docs/43 and Docs/42 in step with it, so fresh installs match migrated ones.
- `2-build.sh` runs `pnpm db:status` first. If it reports `Docs/43.db_setup.sql changed since install` **and no migration is pending**, the build stops instead of starting code that expects a schema the database doesn't have. Add the migration and deploy again. Only set `ALLOW_BASELINE_DRIFT=1` when you know the change is already applied (for example, a comment-only edit). When migrations are pending, a changed Docs/43 is expected (each migration keeps it in step): the build applies them and goes on.
- After `pnpm db:setup`, `2-build.sh` runs `db:status` again and stops unless every migration is applied (`0 pending`) and the baseline reads `up to date`. A run that applies migrations records the Docs/43 it ran with (`core.schema_info` row `baseline.migrated_sha256`), so a migrated database counts as up to date until Docs/43 changes again.
- **The backend refinement (S13–S25b) adds migrations `0100` to `0115`** (`0100_s11_pilot_readiness.sql` … `0115_s25a_rules_and_delivery_health.sql`). A server installed before them takes all of them in name order on its next `update.sh`; a fresh install gets the same schema from Docs/43 and then runs them once (they are idempotent). Check afterwards: `Migrations: 16 applied, 0 pending` in the build log.
- `0-predeploy.sh` dumps both databases before every update, so a failed migration can be [rolled back](#rollback).

## Configuration

### Environment choice

| `CARPAL_ENV` | Use                     | What changes                                                                                                                                                      |
| :----------- | :---------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`        | Developer machines only | Public development master secret; responses validated against the contract; AI stub.                                                                              |
| `staging`    | **This server, today**  | Real secrets required; AI defaults to `unavailable`; strict authentication on (`CARPAL_STRICT_AUTH=1`, the PWA must match).                                       |
| `prod`       | Later                   | Waits for the rest of NI-01 (App Attest / Play Integrity, DPoP-Nonce on the API hosts, risk-based sign-in, breached passwords) and for real mail and SMS (NI-07). |

### Files

- `/carpal/config/backend.env`: everything the service reads. It uses `KEY=value` with JSON values in single quotes, so both systemd and bash read it. The template documents every key, and `backend/.env.example` lists the defaults. The backend validates the whole file at startup and refuses to start on an invalid value, naming the key.
- `/carpal/config/db-admin.env`: the PostgreSQL superuser login. Only `2-build.sh` uses it (for `pnpm db:setup` and `db:status`). The running service never sees it.
- `/carpal/config/deploy.conf`: the folders, host names, build switches and backup retention of these scripts. Defaults are in `deploy.conf.example`.

- `/carpal/config/oauth-client-keys.json`: the key pairs of `cp-web-consumer` and `cp-ssr`, root only. `server-setup.sh` makes it once. The public halves are in `backend.env` (`CARPAL_OAUTH_CLIENT_JWKS`), the private halves in `pwa.env` (`CARPAL_PWA_CLIENT_PRIVATE_JWKS`). Back it up with `backend.env`.
- `/carpal/config/oauth-admin-client-keys.json`: the key pair of `cp-web-admin` (the admin console, S12), root only, made once by `server-setup.sh`. It is a separate file because `pwa-setup.sh` copies `oauth-client-keys.json` whole into `pwa.env`: the PWA must never hold the staff client's key. Its public half is in `CARPAL_OAUTH_CLIENT_JWKS` too; the private half goes to the admin console's env (frontend/admin-console/deploy, stage AC11). Back it up with `backend.env`.
- `/carpal/config/staff-bootstrap.json`: the base staff accounts for `staff-bootstrap.sh` ([Admin plane](#admin-plane)), root only. Names and email addresses, no passwords.

After changing `backend.env`, restart: `bash /carpal/backend/src/backend/deploy/4-start.sh`.

### Client keys

To replace the keys, from the staging copy as root:

```bash
cd /carpal/config
node /home/root/staging/backend/deploy/gen-client-keys.mjs >oauth-client-keys.json && chmod 600 oauth-client-keys.json
node /home/root/staging/backend/deploy/gen-client-keys.mjs --public oauth-client-keys.json    # CARPAL_OAUTH_CLIENT_JWKS in backend.env, in single quotes
node /home/root/staging/backend/deploy/gen-client-keys.mjs --private oauth-client-keys.json   # CARPAL_PWA_CLIENT_PRIVATE_JWKS in pwa.env, in single quotes
# The admin console's key (S12) lives in its own file:
node /home/root/staging/backend/deploy/gen-client-keys.mjs --admin >oauth-admin-client-keys.json && chmod 600 oauth-admin-client-keys.json
node /home/root/staging/backend/deploy/gen-client-keys.mjs --public oauth-client-keys.json oauth-admin-client-keys.json   # CARPAL_OAUTH_CLIENT_JWKS with all three clients
```

Then restart the backend and run `pwa-update.sh`. Token requests fail between the two restarts.

### Exchange rate

Prices are stored in USD. `admin.exchange_rate_update` sets the USD → IRR rate that every client shows (GD-41), and the seed is a **placeholder (1,000,000 IRR per USD)**. If the IRR row is ever missing, the backend creates it at start from `CARPAL_DEFAULT_IRR_PER_USD` (default 1000000; audited as system, never overwriting a rate an administrator set), so `config.client` always serves a rate (backend S26a).

**Every morning (owner decision 2026-11-16).** The rial moves daily, so a platform admin sets the rate each morning. The rates list shows whether each rate was set today (Tehran time) and how old it is. When the rate was not set by `CARPAL_RATE_REMINDER_HOUR` (default 9, Tehran time), every active ADM gets one reminder that day, in the console and by email (staff notice `exchange_rate_reminder`); none once the rate is set. **A daily move of more than 20 % (a sharp devaluation) still waits for a second ADM** (four eyes): on such a day two administrators must be reachable in the morning. Set the real rate in the admin console ([Admin plane](#admin-plane)): a platform admin opens **Settings → Exchange rates**, chooses IRR, enters the amount per US dollar (the page previews sample prices at the current and the new rate) and saves it with a reason. The change is audited. Clients see it within five minutes (config.client). A change of more than 20 % waits until a **second** platform admin approves it on **Pending approvals** (up to 72 hours; the console asks the approver for their security key again when their last key check is older than 5 minutes, SEC-ADM-2). The first real rate is usually far from the placeholder, so two of the pilot's admins must be ready (the staff bootstrap below creates all four).

Fallback, only while the console is not reachable yet (before its deploy kit, stage AC11 of `frontend/admin-console/dev-plan.json`, or if it is down): the server operator sets the rate once in SQL, as root:

```bash
set -a; . /carpal/config/db-admin.env; set +a
PGPASSWORD="$CARPAL_DB_SUPERUSER_PASSWORD" psql -h 127.0.0.1 -U postgres carpal \
  -c "UPDATE admin.exchange_rates SET per_usd = 1050000, reason = 'Initial rate, ticket 1' WHERE currency = 'IRR'"
```

This skips the audit entry and the second approver of the staff operation, so use it for the bootstrap only.

### Email

Since backend S26a the backend sends mail through the **carpals.ir mailbox on the cPanel host** (authenticated SMTP submission to `mail.carpals.ir`), never from the API server itself: the domain's SPF record ends in `-all` and lists only the mail hosts, so mail sent directly from this server would be rejected or marked as spam. Roundcube (webmail) is only the reader of that mailbox; the backend does not use it. Step by step for cPanel: [email_setup_guide.md](email_setup_guide.md).

1. In cPanel → **Email Accounts**, create the sending mailbox (default `no-reply@carpals.ir`) with a long random password. Ask the host for the plan's **hourly sending limit**.
2. From this server, check that the mail server answers on 465 (or 587):

   ```bash
   openssl s_client -connect mail.carpals.ir:465 -servername mail.carpals.ir -brief </dev/null
   ```

   It must print `Verification: OK` and the mail server's banner. If it hangs, the hosting firewall blocks this server: ask the host to allow outgoing SMTP from `185.110.190.201`, or try 587 (`openssl s_client -starttls smtp -connect mail.carpals.ir:587`).

3. In `/carpal/config/backend.env` set `CARPAL_MAIL_TRANSPORT=smtp` and `CARPAL_SMTP_URL='smtps://no-reply%40carpals.ir:<password>@mail.carpals.ir:465'` (percent-encode `@ : / %` in the password: `%40 %3A %2F %25`), keep `CARPAL_MAIL_FROM='CarPal <no-reply@carpals.ir>'`, and set `CARPAL_MAIL_MAX_PER_HOUR` below the host's limit (default 300). Outside dev the backend refuses plain SMTP and a certificate that does not verify.
4. Send a test message from this server, then restart:

   ```bash
   sudo bash /carpal/backend/src/backend/deploy/mail-test.sh you@example.com
   sudo bash /carpal/backend/src/backend/deploy/4-start.sh
   ```

Above the hourly limit, normal notifications wait for the next hour; sign-in codes and security notices always go first. A failed send is retried (a 4xx answer or a lost connection) or recorded as failed for good (a 5xx answer); the admin console shows it in **Notifications → Delivery health** (provider `smtp`). **DNS:** SPF and DKIM are already published by cPanel (`default._domainkey.carpals.ir`); DMARC is `p=none` (monitoring); move it to `p=quarantine` once the pilot's reports are clean. Transactional mail only: the host's banner forbids bulk mail, so marketing mail needs its own provider later.

### SMS

Until the owner chooses an SMS provider (DQ-28), `CARPAL_SMS_PROVIDER=mock`: the SMS gateway behaves like a provider (message ids, delivery statuses, failures) but **no text message leaves the server**. One-time codes are only in `/carpal/data/outbox-sms.jsonl` (readable by root only), the backend log warns every hour, the admin console's System health shows the provider `mock`, and `config.client` tells the PWA to hide phone sign-up and sign-in (`auth.phone_signin_available = false`; people use email). Adding the chosen provider is one adapter in `libs/sms/providers/` (see `vendor-adapter.example.ts`) and its keys `CARPAL_SMS_API_KEY`, `CARPAL_SMS_SENDER_LINE`, `CARPAL_SMS_OTP_TEMPLATE`.

### Maps and address search (Neshan)

Since S26b (owner decision 2026-11-16, DQ-29) the basemap and the address search come from Neshan (www.neshan.org). Two keys, both created in the Neshan panel by the owner:

- **Service key** (backend, never sent to a client): `CARPAL_NESHAN_SERVICE_KEY` and `CARPAL_GEOCODER=neshan` in `/carpal/config/backend.env`. Without `CARPAL_GEOCODER` the backend uses the fixture list only when `CARPAL_ENV=dev` and answers 503 for address search otherwise (staging and prod never serve fixture addresses). `fixture` is refused outside dev. A Neshan outage answers 503 `UNAVAILABLE` (the location editor keeps working by typed address); results are cached for 24 hours. System health in the admin console shows the provider and the requests of today and of 30 days (quota and cost).
- **Web map key** (browsers): restricted in the Neshan panel to `pwa.carpals.ir`, `admin.carpals.ir`, `web.carpals.ir` and `fleet.carpals.ir`; the PWA reads it from `CARPAL_PWA_NESHAN_MAP_KEY`, the console from `CARPAL_ADMIN_NESHAN_MAP_KEY` (their own env files; not in `config.client`). The clients' CSP lists the origins of `region.map.origins`.

**Unverified:** Neshan's documentation answered 503 on 2026-11-16 and 2026-11-17, so the endpoints in `libs/geo/neshan-geocoder.ts` (and the test fixtures) come from earlier knowledge, not from a recording. Make one live check on staging with the real key (search, geocode, reverse) before go-live; the adapter header says what to change if an answer differs.

### Monthly odometer prompt

Rule field `odometer_prompt_days` (admin console, Notification rules: default 30, 0 = off, otherwise 14-90). The worker's hourly rule `vehicle.odometer_prompts` asks owners of active personal vehicles (not fleet vehicles, DQ-27) from the digest hour on (Asia/Tehran). Nothing to configure at deployment; migration 0117 is applied by the update script.

### Consent texts

The 13 consent texts are seeded from the owner's reviewed file (backend S26a.T5): review `database/seeds/consent-texts.template.json`, save the approved copy as `consent-texts.json` (`meta.status` `approved`, no `[bracketed]` placeholder left), copy it to `/carpal/config/consent-texts.json` and run, as root:

```bash
sudo bash /carpal/backend/src/backend/deploy/seed-consent-texts.sh
```

Each text becomes a **draft** version of its consent type's document; published versions are never changed, and a second run creates nothing. Then publish each draft in the admin console (**Policies**, A-POL-01): an effective date and a second administrator's approval (four eyes).

### Admin plane

`admin-api` listens on `127.0.0.1:8081` and is **not published**. SEC-ADM-1 puts it behind a private network. Staff use it through the admin console (frontend/admin-console, client `cp-web-admin`, host `admin.<domain>` = `ADMIN_CONSOLE_HOST` in `deploy.conf`): its BFF calls admin-api on the server itself, so admin-api stays unpublished. The console's deploy kit is stage AC11 of frontend/admin-console/dev-plan.json; until it exists there is no browser path. `backend.env` already registers the console's redirect URI (`https://<ADMIN_CONSOLE_HOST>/bff/oauth/callback`) and WebAuthn origin, and `CARPAL_OAUTH_CLIENT_JWKS` carries its public key (S12). Reach admin-api by hand through an SSH tunnel: `ssh -L 8081:127.0.0.1:8081 root@<server>`. To publish it to fixed addresses only, set `EXPOSE_ADMIN_API=1` and `ADMIN_ALLOW_IPS="203.0.113.10"` in `deploy.conf`, then re-run `server-setup.sh` before certbot, or edit the nginx site by hand after it.

**Staff accounts (first run).** The pilot has **four ADM** (owner decision DQ-16): three main administrators who do the daily admin work, and one **backup administrator** whose holder and credentials are not disclosed. Four-eyes changes need a second ADM, and recovering an ADM's lost key needs two other ADMs, so with four the platform keeps both working while one administrator is away or locked out. It also needs one MOD and one CRV (only CRV decides Path 2 review approvals); one person may hold several roles, but the backup administrator holds no other role.

**The backup administrator.** A normal ADM account in the system (it appears in the console's staff list to other ADMs, and everything it does is audited like any account), kept out of daily use. Only the owner knows who holds it. Its one-time password, its two security keys and its sheet of recovery codes are kept sealed and apart (for example the keys in one safe and the sheet in another), never in the staff spec's comments, chats or tickets. Use it only when fewer than two main ADMs can act: to approve a four-eyes change or a recovery, or to enable an administrator again. After each use, and once a quarter, the holder signs in once to check that the key still works (the sign-in is audited and the main ADMs can see it). If its sheet or a key may have been seen, create a new sheet and replace the key at once. Its email should be an address only the holder reads, because sign-in codes and security notices go there.

With four ADMs an ADM's lost key is recovered in the console by two other ADMs (backend S16b); the break-glass command below is only for when fewer than two other ADMs are active. Copy `templates/staff-bootstrap.json.example` to `/carpal/config/staff-bootstrap.json`, put the real names and addresses in it and run, as root:

```bash
sudo bash /carpal/backend/src/backend/deploy/staff-bootstrap.sh
```

It creates the accounts that do not exist; accounts that exist are reported and never changed, so it is safe to run again. The admin console's setup script runs it on its first install.

**Initial password (backend S26a, DQ-25).** The template lists the three main administrators `admin100@carpals.ir`, `admin200@carpals.ir` and `admin300@carpals.ir` (owner decision 2026-11-16; each mailbox must be read by its holder only, because the sign-in codes go there); fill in the backup ADM, the MOD and the CRV when they are named (the command warns while the pilot minimum is not met). Put the owner's initial password in `/carpal/config/backend.env` as `CARPAL_STAFF_INITIAL_PASSWORD='…'` **before** running the script: every account it creates gets that password (it is never printed, logged or written to git). Without it each new account gets a one-time password printed once. Give the password to each holder on a separate channel (not the email that receives the codes). Either way the password must be changed at the first console sign-in, within **7 days**: after the password the console asks for the code sent to the email and then a new password of at least 12 characters (not a known breached password, not the initial one); only then comes the security key. No token is issued before the change. After 7 days the initial password is refused like a wrong password; set a new one with:

```bash
sudo bash /carpal/backend/src/backend/deploy/staff-bootstrap.sh --reissue admin200@carpals.ir
```

(audited as `staff.initial_password_reissued`; refused for an account that already chose its own password, which recovers through the console or break glass). The initial password may stay in `backend.env` for the next staff accounts; remove it once every account has signed in.

On the first console sign-in a staff member enters the email and that password, then the code sent to the email (until real email is set up, [Email](#email), it is in `/carpal/data/outbox-mail.jsonl`), then a new password, then registers a **device-bound** passkey: a security key, or a platform passkey that is not synced (Windows Hello; synced iCloud or Google passkeys are refused, SEC-ADM-2). After that every sign-in is password + passkey at `aal3`. Later role changes go through the console (`admin.platform_role_grant`, four eyes).

**Recovery codes and backup keys (S16a).** The first key comes with a sheet of 10 recovery codes (`XXXX-XXXX-XXXX-XXXX-XXXX`), shown once: the staff member writes or prints it and keeps it sealed, apart from the keys. Staff who enrolled before S16a have none; the console asks them to create a set. In the console each staff member can add a backup key (plan two keys per person, OQ-14), remove a key (never the last one) and create a new sheet (the old one stops working). Each of these needs a sign-in within the last 5 minutes.

**Lost security key: recovery in the console (S16b).** The staff member opens "Lost my security key" on the console sign-in and gives their email, their password (or says it is forgotten), one code from their sheet and the code then sent to their email. Every other active ADM gets an email; it only points to the console's recovery queue, nothing can be approved from it. Two ADMs other than the requester each check the person outside CarPal (a call to a number you already know, in person or a video call; never a number or address given in the request), then approve in the console after signing in again; any ADM can reject. The request expires 24 hours after it was opened. The staff member then finishes on the same browser: a new password if it was forgotten, a new device-bound key, a new sheet of codes. Their old keys, codes and sessions stop working, and for 72 hours the account cannot approve changes, grant or revoke roles, enable staff or approve a recovery. Every step is in the audit log (actions `staff.recovery_*`). A disabled staff member cannot recover; enable them first (four eyes).

**Lost security key, fewer than two other admins (break glass).** A lost key normally comes back through the console's recovery flow, which two other ADMs approve (backend S16b). When fewer than two other ADMs are active, or the console cannot be used, the server operator resets the account's keys from the server shell, as root:

```bash
sudo bash /carpal/backend/src/backend/deploy/staff-break-glass.sh <staff email> "<who asked, how you checked it was them>"
```

It disables every security key and the open recovery codes of that account, writes an audit entry as actor `system` with your reason (action `staff.break_glass`), and the running backend then ends the account's sessions and emails the account and every other active ADM (event `staff.break_glass`; if the backend is stopped, at its next start). The next console sign-in asks for the password, a code sent to the account's email and a new device-bound key, and shows a new sheet of recovery codes. Check the person's identity out of band first (a call to a known number, in person), because the command trusts whoever can reach the account's email and password. It refuses unknown accounts and accounts without an active platform role (a disabled staff member is enabled in the console first, four eyes). This replaces the earlier "SQL on the server" fallback (R-08).

The baseline also seeds a bootstrap admin (`CARPAL_ADMIN_EMAIL`) without a password. Either leave it unused, or give it a password with a password reset (the reset link goes to the PWA's `/l/pr` page) and it enrols a passkey on its first console sign-in like the others. Listing its address in `staff-bootstrap.json` only reports it as existing.

## Backups, restore and rollback

`0-predeploy.sh` writes `/carpal/backups/<timestamp>/`:

| File                                   | Content                                                                                                 |
| :------------------------------------- | :------------------------------------------------------------------------------------------------------ |
| `code.tar.gz`                          | `/carpal/backend/src`, including `dist/`. `node_modules` is included only with `BACKUP_NODE_MODULES=1`. |
| `config.tar.gz`                        | `/carpal/config` (secrets: keep backups private)                                                        |
| `carpal.dump`, `carpal_analytics.dump` | `pg_dump -Fc` of both databases                                                                         |
| `globals.sql`                          | Roles and their password hashes (`pg_dumpall --globals-only`)                                           |
| `data.tar.gz`                          | `/carpal/data` (outbox files, dead letters)                                                             |
| `upload/`                              | Copy of `/carpal/upload`. Unchanged files are hard links to the previous backup, so they cost no space. |
| `MANIFEST`, `SHA256SUMS`               | When, what release, and checksums                                                                       |

The newest `KEEP_BACKUPS` folders are kept. They sit on the same disk, so also copy them off the server regularly, for example `rsync -a /carpal/backups/ backup-host:/carpal-backups/` from a cron job. The `upload/` folders are hard-linked, so use `rsync -aH` to keep them small.

Backups between updates: `bash /carpal/backend/src/backend/deploy/0-predeploy.sh --no-stop` (e.g. nightly from cron). `pg_dump` takes a consistent snapshot while the service runs.

### Rollback

Pick the backup taken just before the failed update:

```bash
B=/carpal/backups/20261025-101500           # the backup to return to
systemctl stop carpal-backend

# 1. Code (and its build)
mv /carpal/backend/src /carpal/backend/src.failed-$(date +%s)
mkdir -p /carpal/backend/src && tar -xzf $B/code.tar.gz -C /carpal/backend/src
ln -sfn /carpal/data /carpal/backend/src/backend/.data
bash /carpal/backend/src/backend/deploy/2-build.sh --quick --skip-db      # node_modules + dist for that code

# 2. Databases: only if the failed update migrated them
for db in carpal carpal_analytics; do
  runuser -u postgres -- dropdb --if-exists "$db"
  runuser -u postgres -- pg_restore --create -d postgres "$B/$db.dump"
done

# 3. Uploads: rarely needed (updates never change them)
# rsync -a --delete $B/upload/ /carpal/upload/

bash /carpal/backend/src/backend/deploy/3-permissions.sh
bash /carpal/backend/src/backend/deploy/4-start.sh
```

`pg_restore --create` recreates each database with its owner, locale and per-database role settings. The roles themselves are cluster-wide and survive an update. `globals.sql` restores them on a new server (`runuser -u postgres -- psql -f globals.sql`) before the dumps.

**Moving to a new server:** run `server-setup.sh`, then restore `config.tar.gz` into `/carpal`, then `globals.sql`, the two dumps, `data.tar.gz` into `/carpal/data` and `upload/` into `/carpal/upload`. Then run steps 1 to 4. Use the old `backend.env` (same master secret), or the encrypted uploads and existing sessions are lost.

## Operations

| Task                    | Command                                                                                                                                 |
| :---------------------- | :-------------------------------------------------------------------------------------------------------------------------------------- |
| Status                  | `systemctl status carpal-backend`                                                                                                       |
| Live log                | `journalctl -u carpal-backend -f` (JSON lines; pipe through `jq` if installed)                                                          |
| Errors of the last hour | `journalctl -u carpal-backend --since -1h -p warning`                                                                                   |
| Restart                 | `bash /carpal/backend/src/backend/deploy/4-start.sh` (or `systemctl restart carpal-backend`)                                            |
| Health                  | `curl -s http://127.0.0.1:8080/v1/health`                                                                                               |
| Mail the backend "sent" | `tail -n 5 /carpal/data/outbox-mail.jsonl` (verification links, codes, invitations)                                                     |
| Database status         | `cd /carpal/backend/src/backend && set -a && . /carpal/config/backend.env && . /carpal/config/db-admin.env && set +a && pnpm db:status` |
| psql                    | `runuser -u postgres -- psql -d carpal`                                                                                                 |
| Deploy logs             | `ls /carpal/logs/`                                                                                                                      |
| Disk                    | `du -sh /carpal/*`                                                                                                                      |
| Certificates            | `certbot certificates`, renewal test `certbot renew --dry-run`                                                                          |

Expected startup warnings in the log: `GD-06` (strict auth off), `GD-04` (lite infrastructure) and `GD-05` (501 for unimplemented operations). With `CARPAL_MCP_MODE=stub` you also get `GD-35`.

## Known limitations

These come from lite mode and the current state of the code. They are not caused by these scripts. Each one is tracked in `dev_plan.json` (`next_iteration`) or `risk_control_plan.json`.

1. **No outgoing SMS or push; mail only once set up.** Mail goes out through the cPanel mailbox once `CARPAL_MAIL_TRANSPORT=smtp` is set ([Email](#email)); until then it is written to `/carpal/data/outbox-mail.jsonl`. SMS runs on the mock provider ([SMS](#sms)) and push on the file sink: those messages are only in `/carpal/data/outbox-*.jsonl`. The SMS provider is DQ-28, push is NI-07.
2. **Restarts sign everybody out.** Sessions, rate-limit windows, idempotency records and queued jobs are in memory. A restart (every deployment) drops them. Events are safe: the outbox lives in PostgreSQL and is relayed after the restart. Media processing is re-queued by its sweep. Other background jobs that were waiting in the queue may have to be requested again. The search index is rebuilt from the database at startup (`CARPAL_SEARCH_REBUILD_ON_START`). Redis, NATS and OpenSearch adapters (full mode) are NI-06.
3. **Client IP behind nginx.** The backend reads the client address from the TCP socket only, so behind nginx every client looks like `127.0.0.1`. The per-IP windows of 40 §2.8 would then be shared by all users: 30 sign-ins per 15 minutes and 20 OTPs per hour for the whole platform. As a stopgap, `backend.env` raises only those three IP windows (`CARPAL_RATE_LIMITS`), and nginx enforces per-client limits with the contract's values (`templates/nginx-carpal.conf`). The proper fix is code: trust `X-Forwarded-For` from a configured proxy address in `libs/http-pipeline/pipeline.ts`. Until then, the backend's IP-prefix signals (abuse escalation, audit `ip_prefix`) record `127.0.0.0`.
4. **`prod` is not reachable yet** ([Environment choice](#environment-choice)). App attestation and the rest of NI-01, and the portal and admin BFFs (NI-08).
5. **The admin plane has no browser path** until the admin console is deployed (frontend/admin-console, stage AC11; [Admin plane](#admin-plane)). The backend side (S12: DPoP + `private_key_jwt` for `cp-web-admin`, staff passkey enrolment, `admin.staff_me`, the staff bootstrap) is in place.
6. **AI is off** (`CARPAL_MCP_MODE=unavailable`) until the real MCP gateway exists (NI-09). `stub` is fine for demos.
7. **Media domain.** 40 SEC-UP wants media on a separate registrable domain. Since S26b (NI-22) the planned media host is `media.carpals.ir`, a subdomain of the apps' own registrable domain, so the separation SEC-UP asks for is not there yet (owner point: register a second domain for media before public launch). `media.<domain>` works, but then user uploads are served from the same registrable domain as the apps, which weakens the origin isolation SEC-UP asks for. Whatever host serves media, it must answer `Cross-Origin-Resource-Policy: cross-origin` (the storage listener does; `4-start.sh` checks it). Never add `same-origin` in nginx or a CDN: the PWA and the admin console show display copies in `<img>` from another origin, and the browser would block them (R-23).
8. **One server, one process.** There is no high availability. Load scales only vertically, until full mode exists.
9. **Redacted images and a CDN (full mode, later).** In lite mode, `admin.case_action` `apply_redaction` replaces the display copy and the thumbnail on this server at once, and signed links are `no-store`. Once media is served through a CDN (full mode), the old display and thumbnail copies may stay in the CDN cache until they expire, because the backend does not purge the CDN yet (deferred to the next phase, NP-06 in `BR-update-plan.json` → `deferred_to_next_phase` and `dev_plan.json` → `next_iteration`). Until then, keep the CDN cache time of media short, or purge the two keys by hand after a redaction.

## Troubleshooting

| Symptom                                                                | Cause and fix                                                                                                                                                                                                                   |
| :--------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `$'\r': command not found`                                             | The scripts were saved or uploaded with Windows line endings. Set WinSCP to Binary mode, or run once: `sed -i 's/\r$//' /home/root/staging/backend/deploy/*.sh`. `backend/deploy/.gitattributes` keeps LF on Windows checkouts. |
| `contract:check` / `openapi:check` fail on the server but pass locally | Files changed in transfer (WinSCP Text mode), or the upload is incomplete. Re-upload in Binary mode.                                                                                                                            |
| `server-setup.sh`: cluster "holds databases"                           | The default cluster under `/var/lib/postgresql` is in use. Dump it, or move it with `pg_dropcluster`/`pg_createcluster -d /carpal/db/16/main` by hand.                                                                          |
| `2-build.sh`: `Docs/43.db_setup.sql changed since install`             | A schema change without a migration ([Database changes](#database-changes)).                                                                                                                                                    |
| `2-build.sh`: `JavaScript heap out of memory`                          | Too little RAM. Add swap, or lower the work: `RUN_TYPECHECK=0` in `deploy.conf`. CI type-checks every push.                                                                                                                     |
| `4-start.sh`: not healthy, log says `Invalid configuration:`           | A value in `backend.env` failed validation. The message names the key.                                                                                                                                                          |
| Log: `password authentication failed for user "carpal_api"`            | The role passwords in `backend.env` differ from the ones installed. Restore the old `backend.env`, or set the role password in psql (`ALTER ROLE carpal_api PASSWORD '…'`).                                                     |
| `502 Bad Gateway` from nginx                                           | The service is down or still starting: `systemctl status carpal-backend`, `journalctl -u carpal-backend -n 100`.                                                                                                                |
| `429` for many users at once                                           | The per-client nginx limits are too tight for users behind carrier NAT. Raise `rate`/`burst` in `/etc/nginx/sites-available/carpal`, then `nginx -t && systemctl reload nginx`.                                                 |
| Uploads fail with `413`                                                | Bigger than `client_max_body_size` on `media.<domain>` (105 MB). The backend's own limit is 100 MiB.                                                                                                                            |
| `3-permissions.sh`: `cannot write uploads`                             | `/carpal/data/objects` is not a link to `/carpal/upload`. Re-run `1-sync.sh`.                                                                                                                                                   |
