# Deploying the CarPal consumer PWA to production

This guide puts the consumer PWA (`pwa/`: the Next.js app, its BFF and the hosted sign-in pages) on an Ubuntu server next to the CarPal backend and keeps it up to date. You copy files to the server with WinSCP; two scripts do everything on the server:

| Script                     | When                                       | What it does                                                                                                                                                                                            |
| :------------------------- | :----------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pwa/deploy/pwa-setup.sh`  | once per server (safe to run again)        | system packages, Node.js + pnpm, the service user, folders, Redis, `pwa.env`, the systemd service, the nginx site, TLS (optional), a check of the backend's settings, then the first release            |
| `pwa/deploy/pwa-update.sh` | every new version (also the first release) | preflight, stop the service, keep the current release as a backup, copy the code from the staging folder, install, check and build, set permissions, start, health check, automatic rollback on failure |

`lib.sh`, `pwa-deploy.conf.example` and `templates/` are used by both scripts. The backend has its own kit in `backend/deploy/` (read `backend/deploy/deploy.md`); the two kits share the server layout (`/carpal`), `/carpal/config/deploy.conf` and the staging folder.

Contents: [How it fits together](#how-it-fits-together) · [Requirements](#requirements) · [Before a public launch](#before-a-public-launch) · [Server layout](#server-layout) · [Configuration](#configuration) · [First deployment](#first-deployment) · [Updates](#updates) · [After each deployment](#after-each-deployment) · [Rollback](#rollback) · [Operations](#operations) · [Troubleshooting](#troubleshooting) · [Known limitations](#known-limitations)

---

## How it fits together

```
Browser ──https──▶ nginx :443 ── www.<DOMAIN> ──▶ next start 127.0.0.1:3000  (carpal-pwa: pages + BFF + /id sign-in)
   │                 │                              │  server side only:
   │                 │                              ├──▶ backend API  127.0.0.1:8080 (carpal-backend)
   │                 │                              ├──▶ backend auth 127.0.0.1:8082
   │                 │                              └──▶ Redis        127.0.0.1:6379 (BFF sessions)
   │                 └── <DOMAIN> ──▶ 301 to https://www.<DOMAIN>
   └──https──▶ media.<DOMAIN> (signed uploads and downloads, straight from the browser to the backend's storage)
```

- The browser talks to **one origin**, `https://www.<DOMAIN>`. It never receives a token; it holds one cookie (`__Host-cp_sid`), and the BFF keeps the tokens in Redis.
- The PWA calls the backend over `127.0.0.1`. The browser reaches the backend directly only for media files (`media.<DOMAIN>`).
- The hosted sign-in pages are served by the PWA under `/id/…`; the backend's `id.<DOMAIN>` stays the authorization server (OQ-03: built in the PWA codebase).

## Requirements

**Server**

- Ubuntu 24.04 LTS, x86_64 or arm64, root access (SSH).
- 2 vCPU, **4 GB RAM + swap** at least for the build (`next build` and the type check). The running service uses about 300-500 MB. With the backend on the same server, 8 GB is comfortable.
- Disk: about 2 GB per release (`node_modules` and `.next`); the update keeps 5 releases (`KEEP_BACKUPS`).
- Outbound internet during setup and updates: Ubuntu packages, `nodejs.org` (Node.js), `registry.npmjs.org` (pnpm and the dependencies), `acme-v02.api.letsencrypt.org` (certificates).
- Ports 80 and 443 open to the internet; nothing else needs to be public.

**Backend**

- The CarPal backend deployed on the same server with `backend/deploy/` and running (`systemctl status carpal-backend`). It must serve **contract 1.1.0 or newer**: `curl -sI http://127.0.0.1:8080/v1/health | grep -i carpal-contract`. `pwa-update.sh` checks this and stops otherwise.
- Its environment (`/carpal/config/backend.env`) must know the PWA's origin. The backend's template already writes these values; `pwa-setup.sh` checks them and warns:

  | backend.env                  | value                                                                          |
  | :--------------------------- | :----------------------------------------------------------------------------- |
  | `CARPAL_OAUTH_REDIRECT_URIS` | `cp-web-consumer` lists `https://www.<DOMAIN>/bff/oauth/callback`              |
  | `CARPAL_WEBAUTHN_ORIGINS`    | contains `https://www.<DOMAIN>` (passkeys)                                     |
  | `CARPAL_WEBAUTHN_RP_ID`      | `<DOMAIN>`                                                                     |
  | `CARPAL_MEDIA_CORS_ORIGINS`  | contains `https://www.<DOMAIN>` (photo uploads, PDF preview)                   |
  | `CARPAL_LINK_BASE_URL`       | `https://www.<DOMAIN>/l` (links in emails)                                     |
  | `CARPAL_MEDIA_BASE_URL`      | `https://media.<DOMAIN>`                                                       |
  | `CARPAL_API_AUDIENCE`        | `https://api.<DOMAIN>` — the same value as the PWA's                           |
  | `CARPAL_STRICT_AUTH`         | the same value as the PWA's (`0` today, see below)                             |
  | `CARPAL_SIGNIN_URL`          | **unset** (the default `<issuer>/signin` is what the PWA's `/id` proxy serves) |

**DNS** (A/AAAA records to the server): `www.<DOMAIN>` and `<DOMAIN>` for the PWA, and the backend's `api.`, `id.` and `media.<DOMAIN>`.

**Your PC**: WinSCP (SFTP to the server as root, or as a sudo user who owns the staging folder) and a copy of the repository.

## Before a public launch

The scripts produce a working production deployment, but the scratch build left items that must be closed before real users arrive (`pwa/dev_plan.json`, `stages[P14].report.next_iteration`, priority `pilot_blocker`):

| Item                                      | What it means for this deployment                                                                                                                                                                                                                                                                                                                                                                            |
| :---------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NI-P13-01 strict auth**                 | The backend runs with `CARPAL_STRICT_AUTH=0` (`CARPAL_ENV=staging` in `backend.env`) until it accepts DPoP-bound tokens for the BFF's confidential clients (`cp-web-consumer`, `cp-ssr`) — **decided 2026-11-04: DPoP, no mTLS at the edge**. Keep the PWA at `CARPAL_STRICT_AUTH=0` to match; with `1` every signed-in call answers 401. After the backend change, set both to `1` and run `pwa-update.sh`. |
| **NI-P13-12 legal texts and domain**      | **Go-live waits** until legal fills every bracketed placeholder (entity, addresses, dates) in the Privacy Policy and User Agreement and the Persian translations are published (decided 2026-11-04). The production domain is **carpals.ir**: `support@carpals.ir` (pwa.env) must be a mailbox you read (MX records for carpals.ir).                                                                         |
| **NI-P13-08 profile and settings fields** | **Pilot blocker** (confirmed 2026-11-04): some Settings elements wait for backend fields (photo, country, deactivation, AI switches, quiet hours, SMS…).                                                                                                                                                                                                                                                     |
| Web push (OQ-26, open)                    | Leave `CARPAL_PWA_VAPID_PUBLIC_KEY` empty: no push controls are shown until a push sender exists.                                                                                                                                                                                                                                                                                                            |
| Map tiles (OQ-02)                         | Without a style URL the map uses the built-in style without a basemap (pins, no streets).                                                                                                                                                                                                                                                                                                                    |

Do not set `CARPAL_ENV=prod` on the backend before NI-P13-01: the backend's prod mode requires strict auth.

## Server layout

| Path                                     | Owner / mode        | Content                                                                                |
| :--------------------------------------- | :------------------ | :------------------------------------------------------------------------------------- |
| `/home/root/staging/`                    | root 700            | what WinSCP uploads: the repository (`pwa/`, `shared/`, `backend/`, `Docs/` …)         |
| `/carpal/pwa/src/`                       | root:carpal-web 750 | the running release: `pwa/` (the app, with `node_modules/` and `.next/`) and `shared/` |
| `/carpal/pwa/src/pwa/.next/`             | carpal-web          | the build; the service writes its cache and regenerated pages here                     |
| `/carpal/config/pwa.env`                 | root:carpal-web 640 | the service environment (contains the Redis password)                                  |
| `/carpal/config/deploy.conf`             | root 640            | shared settings of both kits (`DOMAIN`, `LETSENCRYPT_EMAIL`, `STAGING_DIR`)            |
| `/carpal/config/pwa-deploy.conf`         | root 640 (optional) | PWA-only overrides of `pwa-deploy.conf.example`                                        |
| `/carpal/backups/pwa-<time>/`            | root 700            | previous releases (whole folder, ready to move back)                                   |
| `/carpal/logs/pwa-deploy-<date>.log`     | root 750            | output of every script run                                                             |
| `/etc/systemd/system/carpal-pwa.service` | root 644            | the service (user `carpal-web`, `next start` on 127.0.0.1:3000)                        |
| `/etc/redis/carpal-pwa.conf`             | root:redis 640      | Redis settings: local only, password, 256 MB, sessions evicted oldest-first            |
| `/etc/nginx/sites-available/carpal-pwa`  | root 644            | only when the backend's nginx site does not already serve `www.<DOMAIN>`               |

## Configuration

Three files, read in this order (later wins):

1. `pwa/deploy/pwa-deploy.conf.example` — defaults, part of the upload. Do not edit it on the server.
2. `/carpal/config/deploy.conf` — shared with the backend: at least `DOMAIN`, `LETSENCRYPT_EMAIL`, `STAGING_DIR`. Production: `DOMAIN=carpals.ir`, which gives `www.carpals.ir` (the PWA), `carpals.ir` (redirect), `api.`, `id.` and `media.carpals.ir`.
3. `/carpal/config/pwa-deploy.conf` — optional PWA overrides, for example `WEB_HOST=app.example.com`, `RUN_UNIT_TESTS=0`, `KEEP_BACKUPS=3`, `RUN_CERTBOT=1`.

Main settings of `pwa-deploy.conf.example`:

| Setting                                         | Default                           | Meaning                                                                                  |
| :---------------------------------------------- | :-------------------------------- | :--------------------------------------------------------------------------------------- |
| `WEB_HOST`                                      | `www.<DOMAIN>`                    | the PWA's public host name                                                               |
| `STAGING_DIR`                                   | `/home/root/staging`              | the WinSCP upload folder                                                                 |
| `PWA_PORT`                                      | `3000`                            | local port of `next start` (the backend's nginx template proxies `www.<DOMAIN>` to 3000) |
| `BACKEND_API_URL` / `BACKEND_AUTH_URL`          | `http://127.0.0.1:8080` / `:8082` | where the BFF reaches the backend                                                        |
| `REQUIRE_BACKEND`                               | `1`                               | an update stops when the backend is down or serves an older contract                     |
| `RUN_TYPECHECK` / `RUN_UNIT_TESTS` / `RUN_LINT` | `1` / `1` / `0`                   | checks before `next build`                                                               |
| `BUILD_MEMORY_MB`                               | `3072`                            | Node heap for the build                                                                  |
| `AUTO_ROLLBACK`                                 | `1`                               | a failed release is replaced by the previous one                                         |
| `RUN_CERTBOT`                                   | `0`                               | `1` = `pwa-setup.sh` requests the certificate itself                                     |
| `FIRST_DEPLOY`                                  | `1`                               | `pwa-setup.sh` ends by running `pwa-update.sh`                                           |

**`/carpal/config/pwa.env`** is written once by `pwa-setup.sh` from `templates/pwa.env.template` and never overwritten. Every variable is validated when the service starts (`pwa/src/server/env.ts`); a bad value stops the start and `journalctl -u carpal-pwa` names it. With `CARPAL_ENV=prod` the PWA refuses http origins, the in-memory session store, demo pages and the dev redirect shim.

| Variable                                            | Production value                                                          |
| :-------------------------------------------------- | :------------------------------------------------------------------------ |
| `CARPAL_ENV`                                        | `prod`                                                                    |
| `CARPAL_STRICT_AUTH`                                | `0` (same as the backend)                                                 |
| `CARPAL_PWA_ORIGIN`                                 | `https://www.<DOMAIN>`                                                    |
| `CARPAL_API_URL` / `CARPAL_AUTH_URL`                | `http://127.0.0.1:8080` / `http://127.0.0.1:8082`                         |
| `CARPAL_STORAGE_URL`                                | `https://media.<DOMAIN>` (https required)                                 |
| `CARPAL_API_AUDIENCE`                               | `https://api.<DOMAIN>` (equal to the backend's)                           |
| `CARPAL_PWA_SESSION_STORE` / `CARPAL_PWA_REDIS_URL` | `redis` / `redis://:<password>@127.0.0.1:6379/0` (filled in by the setup) |
| `CARPAL_PWA_DEFAULT_TIME_ZONE`                      | `Asia/Tehran`                                                             |
| `CARPAL_PWA_SUPPORT_EMAIL`                          | `support@<DOMAIN>` — change to a real mailbox                             |
| `CARPAL_PWA_PORTAL_URL` / `…_SIGNUP_URL`            | the business portal (placeholders until it exists)                        |
| `CARPAL_PWA_MAP_STYLE_URL`                          | empty (region config), or a vector style on your own host                 |
| `CARPAL_PWA_VAPID_PUBLIC_KEY`                       | empty (OQ-26)                                                             |
| `CARPAL_PWA_MAINTENANCE`                            | empty; `on` or an ISO time shows the 503 maintenance page                 |
| `CARPAL_PWA_DEMO`                                   | `0`                                                                       |

**A change of `pwa.env` needs a rebuild**, not just a restart: `next build` prerenders some pages (manifests, robots, sitemaps' shells) with these values. Run `sudo bash /home/root/staging/pwa/deploy/pwa-update.sh` (the staging copy may stay as it is). Only `CARPAL_PWA_MAINTENANCE` works with a plain `systemctl restart carpal-pwa`.

## First deployment

Order: backend first, then the PWA.

1. **DNS.** Point `www.<DOMAIN>`, `<DOMAIN>`, `api.`, `id.` and `media.<DOMAIN>` at the server. Wait until `dig +short www.<DOMAIN>` shows the server's address.

2. **Backend.** Follow `backend/deploy/deploy.md` (its `server-setup.sh` creates `/carpal/config/deploy.conf` with `DOMAIN`, the backend service and an nginx site that already contains the `www.<DOMAIN>` and `<DOMAIN>` blocks; its certbot command includes `www.<DOMAIN>` and `<DOMAIN>`). Check: `curl -sI http://127.0.0.1:8080/v1/health` answers `200` with `carpal-contract: 1.1.0`.

3. **Upload with WinSCP.** Connect with SFTP. In _Preferences → Transfer_ choose **Binary** (keeps the scripts' Linux line ends). Upload the repository folder's content to `/home/root/staging/` so that `/home/root/staging/pwa/package.json` and `/home/root/staging/shared/` exist. Leave out build output with a file mask in the transfer settings:

   ```
   | node_modules/; .next/; .data/; .tools/; dist/; test-results/; playwright-report/; .git/; public/ds/
   ```

   (_Synchronize_ with _Mirror files_ and this mask does the same faster on later uploads.)

4. **Run the setup** in an SSH session:

   ```sh
   sudo bash /home/root/staging/pwa/deploy/pwa-setup.sh
   ```

   - If `/carpal/config/deploy.conf` does not exist yet (PWA without the backend kit), the first run creates it and stops: set `DOMAIN` and `LETSENCRYPT_EMAIL`, then run it again.
   - It installs and configures everything (see the table at the top), prints a warning for every backend setting from [Requirements](#requirements) that does not match, and — with `FIRST_DEPLOY=1` — continues with `pwa-update.sh` (next step).
   - Read the warnings. Fix `backend.env` if needed and restart the backend (`systemctl restart carpal-backend`).

5. **Review `/carpal/config/pwa.env`.** At least `CARPAL_PWA_SUPPORT_EMAIL`. If you change anything, run the update again (step 6).

6. **First release** (already done by step 4 with `FIRST_DEPLOY=1`; otherwise):

   ```sh
   sudo bash /home/root/staging/pwa/deploy/pwa-update.sh
   ```

   It takes 3-8 minutes (install, type check, unit tests, build) and ends with "Release … runs".

7. **TLS.** If the backend's certbot run already covered `www.<DOMAIN>` and `<DOMAIN>`, nothing to do. Otherwise:

   ```sh
   certbot --nginx -d www.<DOMAIN> -d <DOMAIN> --email <LETSENCRYPT_EMAIL> --agree-tos --redirect
   ```

   (or set `RUN_CERTBOT=1` in `/carpal/config/pwa-deploy.conf` and run `pwa-setup.sh` again). Certbot renews automatically (`systemctl list-timers | grep certbot`).

8. **Check** with [After each deployment](#after-each-deployment).

## Updates

1. Upload the new code with WinSCP to `/home/root/staging/` (step 3 above; only `pwa/` and `shared/` are used, but uploading the whole repository is fine).
2. If the new version needs a newer backend (a new contract version), deploy the backend first (`sudo bash /home/root/staging/backend/deploy/update.sh`, `backend/deploy/deploy.md`).
3. Run:

   ```sh
   sudo bash /home/root/staging/pwa/deploy/pwa-update.sh
   ```

What it does, in order:

| Step                     | Detail                                                                                                                                                                                                                               |
| :----------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preflight                | the upload has `pwa/package.json`, `pnpm-lock.yaml` and `shared/`; `pwa.env` and the service exist; `CARPAL_PWA_DEMO` is not 1; the backend answers and serves at least the contract version the upload was generated for; free disk |
| Copy                     | `pwa/` and `shared/` from staging to `/carpal/pwa/src.new/` (without `node_modules`, `.next`, test output, local `.env` files) — before the stop, so the site keeps running meanwhile                                                |
| Stop                     | `systemctl stop carpal-pwa` — **the site is down from here until the health check passes** (nginx answers 502)                                                                                                                       |
| Keep the current release | `/carpal/pwa/src` → `/carpal/backups/pwa-<time>/` (a complete, runnable folder)                                                                                                                                                      |
| Swap                     | `/carpal/pwa/src.new` → `/carpal/pwa/src`                                                                                                                                                                                            |
| Install and build        | `pnpm install --frozen-lockfile` (the lockfile decides every version), `pnpm typecheck`, `pnpm test`, `pnpm lint` (if enabled), `pnpm build` with `pwa.env` loaded. Runs as root in a clean environment.                             |
| Permissions              | code root-owned and read-only for `carpal-web`; `.next/` owned by `carpal-web`                                                                                                                                                       |
| Start                    | the unit is re-rendered from this upload's template, `systemctl start carpal-pwa`                                                                                                                                                    |
| Health check             | `/fa` answers 200 (through the `www.<DOMAIN>` host name) within 120 s; a BFF session is written to Redis and read back                                                                                                               |
| Rollback                 | if the build, the start or the health check fails: the failed release goes to `/carpal/backups/pwa-<time>-failed/`, the previous one is moved back and started, and the script exits with an error that says what failed             |
| Clean up                 | keeps the newest 5 backups                                                                                                                                                                                                           |

Plan updates for quiet hours: the downtime is the build time (3-8 minutes). Set `RUN_UNIT_TESTS=0` / `RUN_TYPECHECK=0` in `pwa-deploy.conf` to shorten it once the same code passed `pnpm check` on your PC.

**Before uploading**, on your PC (`pwa/README.md` "Testing"): `pnpm check` and `pnpm build` pass, and ideally `pnpm e2e` against a local backend.

## After each deployment

```sh
systemctl status carpal-pwa --no-pager
journalctl -u carpal-pwa -n 50 --no-pager
curl -sI https://www.<DOMAIN>/fa | head -n 20          # 200, strict-transport-security, content-security-policy
curl -sI https://<DOMAIN>/ | grep -i location          # 301 to https://www.<DOMAIN>/
curl -s https://www.<DOMAIN>/robots.txt                 # names the sitemap on https://www.<DOMAIN>
```

In a browser (both `/fa` and `/en`):

1. The landing page loads; the cookie banner appears once.
2. Search for a service: results, the filter panel with counts, the map pane.
3. Sign up with a real email address; the verification mail's link opens `https://www.<DOMAIN>/l/…`; sign in, sign out, sign in again.
4. Add a vehicle and a photo in My Garage (the upload goes to `media.<DOMAIN>`; a CORS error in the browser console means `CARPAL_MEDIA_CORS_ORIGINS` lacks the origin).
5. Reload a search result page: the same results come back (search session re-read).
6. DevTools → Application: the manifest is valid and the service worker is activated.

## Rollback

The update rolls back on its own when the new release fails. To go back to an earlier release by hand:

```sh
ls -1dt /carpal/backups/pwa-*                          # newest first; *-failed are releases that never ran
sudo systemctl stop carpal-pwa
sudo mv /carpal/pwa/src /carpal/backups/pwa-$(date +%Y%m%d-%H%M%S)-rolled-back
sudo mv /carpal/backups/pwa-<time> /carpal/pwa/src
sudo systemctl start carpal-pwa
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: www.<DOMAIN>' -H 'X-Forwarded-Proto: https' http://127.0.0.1:3000/fa
```

A backup holds its own `node_modules` and `.next`, so nothing has to be built. If `pwa.env` changed since that release, put the old values back first (a release is built with the `pwa.env` of its time).

## Operations

| Task                 | Command                                                                                                                                                                      |
| :------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status / logs        | `systemctl status carpal-pwa`, `journalctl -u carpal-pwa -f` (the PWA logs no request bodies, tokens or user URLs)                                                           |
| Restart (no rebuild) | `sudo systemctl restart carpal-pwa` — sessions stay in Redis, users stay signed in                                                                                           |
| Maintenance page     | set `CARPAL_PWA_MAINTENANCE=on` (or an ISO end time) in `pwa.env`, `systemctl restart carpal-pwa`; empty it and restart again                                                |
| Deploy script logs   | `/carpal/logs/pwa-deploy-<date>.log`                                                                                                                                         |
| Redis                | `systemctl status redis-server`; key count: `REDISCLI_AUTH=<password> redis-cli --scan --pattern 'cp:bff:sess:*' \| wc -l` (the password is in `/etc/redis/carpal-pwa.conf`) |
| Sign everybody out   | `REDISCLI_AUTH=<password> redis-cli --scan --pattern 'cp:bff:sess:*' \| xargs -r -n 100 env REDISCLI_AUTH=<password> redis-cli del`                                          |
| Certificates         | `certbot certificates`; renewal is automatic                                                                                                                                 |
| Backup               | `/carpal/config/pwa.env` and `/etc/redis/carpal-pwa.conf` (with the backend's config folder). Sessions need no backup: losing them only signs users out.                     |

## Troubleshooting

| Symptom                                                                      | Cause and fix                                                                                                                                                                                                                                    |
| :--------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash: …/pwa-setup.sh: /usr/bin/env: 'bash\r'` or `$'\r': command not found` | The scripts were uploaded with Windows line ends. Upload again in **Binary** mode, or fix on the server: `sed -i 's/\r$//' /home/root/staging/pwa/deploy/*.sh /home/root/staging/pwa/deploy/templates/* /home/root/staging/pwa/deploy/*.example` |
| The service does not start; journal shows `Invalid PWA environment:`         | A value in `pwa.env` is wrong; the line names it (e.g. `CARPAL_STORAGE_URL: must be https in prod`). Fix it and run `pwa-update.sh`.                                                                                                             |
| `the backend serves contract 1.0.x; this PWA needs 1.1.0`                    | Deploy the backend first.                                                                                                                                                                                                                        |
| 502 Bad Gateway                                                              | The service is stopped (an update is building) or crashed: `journalctl -u carpal-pwa -n 100`.                                                                                                                                                    |
| Sign-in ends on an error page from the auth host                             | `backend.env` `CARPAL_OAUTH_REDIRECT_URIS` lacks `https://www.<DOMAIN>/bff/oauth/callback`, or `CARPAL_SIGNIN_URL` is set. Restart the backend after the change.                                                                                 |
| Passkeys fail                                                                | `CARPAL_WEBAUTHN_RP_ID` must be `<DOMAIN>` and `CARPAL_WEBAUTHN_ORIGINS` must contain `https://www.<DOMAIN>`.                                                                                                                                    |
| Photo upload fails (CORS)                                                    | `CARPAL_MEDIA_CORS_ORIGINS` lacks `https://www.<DOMAIN>`; `media.<DOMAIN>` needs a certificate.                                                                                                                                                  |
| Links in emails open the wrong host                                          | `CARPAL_LINK_BASE_URL` in `backend.env` must be `https://www.<DOMAIN>/l`.                                                                                                                                                                        |
| Every signed-in action answers 401 "token is not sender-constrained"         | Strict mode is on (`CARPAL_STRICT_AUTH=1`) on the backend or the PWA. Set both to 0 (NI-P13-01).                                                                                                                                                 |
| Many "Too many requests" at sign-in                                          | All sign-ins reach the auth host from 127.0.0.1 (DI-25): raise the backend's IP windows (its `CARPAL_RATE_LIMITS`, already raised by the backend template); nginx limits each real client address.                                               |
| Build killed / `JavaScript heap out of memory`                               | Add swap (`fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`, plus a line in `/etc/fstab`) or lower `BUILD_MEMORY_MB` with `RUN_UNIT_TESTS=0`.                                                           |
| `pnpm install --frozen-lockfile` fails                                       | `pwa/package.json` and `pnpm-lock.yaml` do not match in the upload: run `pnpm install` on your PC, commit both, upload again.                                                                                                                    |
| `GET /bff/csrf issued no session` / `not stored in Redis`                    | Redis is down or the password in `CARPAL_PWA_REDIS_URL` differs from `/etc/redis/carpal-pwa.conf`: `systemctl status redis-server`; run `pwa-setup.sh` again (it warns about a mismatch).                                                        |
| `nginx: [warn] conflicting server name "www.<DOMAIN>"`                       | Both the backend's site and `carpal-pwa` serve the host: `rm /etc/nginx/sites-enabled/carpal-pwa && nginx -t && systemctl reload nginx` (`pwa-setup.sh` does this when it finds the backend's block).                                            |

## Known limitations

- **Downtime during updates.** The release is built in place, because the Next.js build records its folder; the site is down for the build time (3-8 minutes). A second port with a switch in nginx would remove it (next iteration).
- **One PWA instance.** The BFF serializes token refreshes per process. A second instance (another server, or a second port behind nginx) needs the refresh lock in Redis first (NI-P13-03). Redis itself is already shared-ready.
- **The Redis session store had not met a real Redis before this deployment** (NI-P13-03); `pwa-update.sh` therefore writes and reads a session on every release and rolls back if that fails.
- **Strict authentication** is off on both sides until the backend accepts the BFF's client authentication (NI-P13-01).
- **Rate limits** behind the BFF and nginx are per server address on the backend side (DI-25, DI-26, DI-28); nginx enforces per-client limits on the sign-in endpoints.
- **Web push** is not offered (OQ-26); **map tiles** fall back to the built-in style (OQ-02).
