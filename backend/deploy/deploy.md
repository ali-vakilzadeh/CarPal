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
- **Environment `staging`.** It has real secrets, and responses are not re-validated against the contract. `prod` requires strict authentication (`CARPAL_STRICT_AUTH=1`), which needs the BFFs and app attestation. They don't exist yet (see [Configuration](#environment-choice)).
- **Code, data and secrets are separate.** Code lives in `/carpal/backend/src`, data in `/carpal/data`, `/carpal/upload` and `/carpal/db`, and secrets in `/carpal/config`. An update replaces the code and never touches the data.

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

|           | Minimum                                                                            | Notes                                                                                                                        |
| :-------- | :--------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| OS        | **Ubuntu 24.04 LTS** (x86-64 or arm64)                                             | PostgreSQL 16 and pgvector come from the Ubuntu archive. Other releases need the PGDG repository.                            |
| CPU / RAM | 2 vCPU, **4 GB RAM** (or 2 GB plus 2 GB swap)                                      | `tsc` and the unit tests need memory during `2-build.sh`. Runtime needs much less.                                           |
| Disk      | 40 GB SSD                                                                          | Code with `node_modules` and the pnpm store is under 1 GB. Plan for uploads, the database and `KEEP_BACKUPS` copies of both. |
| DNS       | A/AAAA records for `api.`, `id.`, `media.` (and later `admin-api.`) of your domain | Needed before `certbot`.                                                                                                     |
| Access    | SSH as root (or sudo), WinSCP with SFTP                                            |                                                                                                                              |
| Outbound  | HTTPS to `nodejs.org`, `registry.npmjs.org`, the Ubuntu mirrors, Let's Encrypt     | For setup and `pnpm install`.                                                                                                |

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
| `2-build.sh`                    | Every deployment      | `pnpm install --frozen-lockfile`, a clean `pnpm build`, the contract checks (`contract:check`, `openapi:check`, `contract:coverage --strict`), `typecheck`, the unit tests, then `pnpm db:setup`. Stops if `Docs/43` changed without a migration. `--skip-db`, `--quick`.                                                         |
| `3-permissions.sh`              | Every deployment      | Owners and modes from the [layout](#server-layout), then an access check run as the service user.                                                                                                                                                                                                                                 |
| `4-start.sh`                    | Every deployment      | Restarts the service and waits for `/v1/health`. Then checks that auth, admin-api and storage answer. On failure it prints the last 80 log lines.                                                                                                                                                                                 |
| `update.sh`                     | Every update          | Runs 0 → 1 → 2 → 3 → 4 and stops at the first failure.                                                                                                                                                                                                                                                                            |
| `lib.sh`, `deploy.conf.example` | —                     | Shared helpers and default settings.                                                                                                                                                                                                                                                                                              |
| `templates/`                    | —                     | `backend.env`, `db-admin.env`, the systemd unit and the nginx site, with `@PLACEHOLDERS@`.                                                                                                                                                                                                                                        |

## First deployment

### 1. DNS

Point `api.<domain>`, `id.<domain>` and `media.<domain>` at the server. `admin-api.<domain>` is optional (see [Admin plane](#admin-plane)).

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
- `CARPAL_OAUTH_REDIRECT_URIS`, `CARPAL_WEBAUTHN_RP_ID`, `CARPAL_WEBAUTHN_ORIGINS`: the exact app and web origins of your clients.
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
certbot --nginx -d api.<domain> -d id.<domain> -d media.<domain> --email <you> --agree-tos --redirect
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
- `2-build.sh` runs `pnpm db:status` first. If it reports `Docs/43.db_setup.sql changed since install`, the build stops instead of starting code that expects a schema the database doesn't have. Add the migration and deploy again. Only set `ALLOW_BASELINE_DRIFT=1` when you know the change is already applied (for example, a comment-only edit).
- `0-predeploy.sh` dumps both databases before every update, so a failed migration can be [rolled back](#rollback).

## Configuration

### Environment choice

| `CARPAL_ENV` | Use                     | What changes                                                                                                                                                                                                                 |
| :----------- | :---------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`        | Developer machines only | Public development master secret; responses validated against the contract; AI stub.                                                                                                                                         |
| `staging`    | **This server, today**  | Real secrets required; AI defaults to `unavailable`; strict authentication off. The service logs deviation GD-06 at startup.                                                                                                 |
| `prod`       | Later                   | Requires `CARPAL_STRICT_AUTH=1`. That enforces DPoP binding, mTLS-bound BFF tokens and app attestation. The BFFs (NI-08) and attestation verification (NI-01) don't exist yet, so clients cannot sign in under `prod` today. |

### Files

- `/carpal/config/backend.env`: everything the service reads. It uses `KEY=value` with JSON values in single quotes, so both systemd and bash read it. The template documents every key, and `backend/.env.example` lists the defaults. The backend validates the whole file at startup and refuses to start on an invalid value, naming the key.
- `/carpal/config/db-admin.env`: the PostgreSQL superuser login. Only `2-build.sh` uses it (for `pnpm db:setup` and `db:status`). The running service never sees it.
- `/carpal/config/deploy.conf`: the folders, host names, build switches and backup retention of these scripts. Defaults are in `deploy.conf.example`.

After changing `backend.env`, restart: `bash /carpal/backend/src/backend/deploy/4-start.sh`.

### Admin plane

`admin-api` listens on `127.0.0.1:8081` and is **not published**. SEC-ADM-1 puts it behind a private network, and staff sessions need WebAuthn `aal3` through the admin BFF, which doesn't exist yet. Reach it through an SSH tunnel: `ssh -L 8081:127.0.0.1:8081 root@<server>`. To publish it to fixed addresses only, set `EXPOSE_ADMIN_API=1` and `ADMIN_ALLOW_IPS="203.0.113.10"` in `deploy.conf`, then re-run `server-setup.sh` before certbot, or edit the nginx site by hand after it.

The baseline seeds a bootstrap admin (`CARPAL_ADMIN_EMAIL`). Completing its sign-up needs a password reset and a WebAuthn registration through the admin console.

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

1. **No outgoing mail, SMS or push.** The lite adapters write every message to `/carpal/data/outbox-*.jsonl`. Sign-up verification, one-time codes, password resets and invitations only reach a user if you forward them by hand. Real providers are NI-07.
2. **Restarts sign everybody out.** Sessions, rate-limit windows, idempotency records and queued jobs are in memory. A restart (every deployment) drops them. Events are safe: the outbox lives in PostgreSQL and is relayed after the restart. Media processing is re-queued by its sweep. Other background jobs that were waiting in the queue may have to be requested again. The search index is rebuilt from the database at startup (`CARPAL_SEARCH_REBUILD_ON_START`). Redis, NATS and OpenSearch adapters (full mode) are NI-06.
3. **Client IP behind nginx.** The backend reads the client address from the TCP socket only, so behind nginx every client looks like `127.0.0.1`. The per-IP windows of 40 §2.8 would then be shared by all users: 30 sign-ins per 15 minutes and 20 OTPs per hour for the whole platform. As a stopgap, `backend.env` raises only those three IP windows (`CARPAL_RATE_LIMITS`), and nginx enforces per-client limits with the contract's values (`templates/nginx-carpal.conf`). The proper fix is code: trust `X-Forwarded-For` from a configured proxy address in `libs/http-pipeline/pipeline.ts`. Until then, the backend's IP-prefix signals (abuse escalation, audit `ip_prefix`) record `127.0.0.0`.
4. **`prod` is not reachable yet** ([Environment choice](#environment-choice)). Strict authentication, BFFs and app attestation are NI-01 and NI-08.
5. **The admin plane has no browser path** until the admin BFF exists ([Admin plane](#admin-plane)).
6. **AI is off** (`CARPAL_MCP_MODE=unavailable`) until the real MCP gateway exists (NI-09). `stub` is fine for demos.
7. **Media domain.** 40 SEC-UP wants media on a separate registrable domain (`media.carpal-usercontent.app`). `media.<domain>` works, but then user uploads are served from the same registrable domain as the apps, which weakens the origin isolation SEC-UP asks for.
8. **One server, one process.** There is no high availability. Load scales only vertically, until full mode exists.

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
