# Deploying the CarPal consumer PWA to production

This guide puts the consumer PWA (`pwa/`: the Next.js app, its BFF and the hosted sign-in pages) on an Ubuntu server next to the CarPal backend and keeps it up to date. You copy files to the server with WinSCP; two scripts do everything on the server:

| Script                     | When                                       | What it does                                                                                                                                                                                            |
| :------------------------- | :----------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pwa/deploy/pwa-setup.sh`  | once per server (safe to run again)        | system packages, Node.js + pnpm, the service user, folders, Redis, `pwa.env`, the systemd service, the nginx site, TLS (optional), a check of the backend's settings, then the first release            |
| `pwa/deploy/pwa-update.sh` | every new version (also the first release) | preflight, stop the service, keep the current release as a backup, copy the code from the staging folder, install, check and build, set permissions, start, health check, automatic rollback on failure |

`lib.sh`, `pwa-deploy.conf.example` and `templates/` are used by both scripts. The backend has its own kit in `backend/deploy/` (read `backend/deploy/deploy.md`); the two kits share the server layout (`/carpal`), `/carpal/config/deploy.conf` and the staging folder.

Contents: [How it fits together](#how-it-fits-together) · [Requirements](#requirements) · [Before a public launch](#before-a-public-launch) · [Server layout](#server-layout) · [Configuration](#configuration) · [First deployment](#first-deployment) · [Updates](#updates) · [After each deployment](#after-each-deployment) · [Rollback](#rollback) · [Operations](#operations) · [Changing the public host](#changing-the-public-host) · [Troubleshooting](#troubleshooting) · [Known limitations](#known-limitations)

---

## How it fits together

```
Browser ──https──▶ nginx :443 ── pwa.<DOMAIN> ──▶ next start 127.0.0.1:3000  (carpal-pwa: pages + BFF + /id sign-in)
   │                 │                              │  server side only:
   │                 │                              ├──▶ backend API  127.0.0.1:8080 (carpal-backend)
   │                 │                              ├──▶ backend auth 127.0.0.1:8082
   │                 │                              └──▶ Redis        127.0.0.1:6379 (BFF sessions)
   │                 └── <DOMAIN> ──▶ 301 to https://www.<DOMAIN> (the landing site, landing/deploy)
   └──https──▶ media.<DOMAIN> (signed uploads and downloads, straight from the browser to the backend's storage)
```

- The browser talks to **one origin**, `https://pwa.<DOMAIN>`. It never receives a token; it holds one cookie (`__Host-cp_sid`), and the BFF keeps the tokens in Redis.
- The PWA calls the backend over `127.0.0.1`, because both run on this server. The browser reaches the backend directly only for media files (`media.<DOMAIN>`).
- `https://api.<DOMAIN>` is the backend's public address, for clients outside this server. The BFF does not connect to it, but its tokens and DPoP proofs name it, so `CARPAL_API_AUDIENCE` must be `https://api.<DOMAIN>`.
- The hosted sign-in pages are served by the PWA under `/id/…`; the backend's `id.<DOMAIN>` stays the authorization server (OQ-03: built in the PWA codebase).

Production hosts (`DOMAIN=carpals.ir`):

| Host               | Serves                              | Reached by                                           |
| :----------------- | :---------------------------------- | :--------------------------------------------------- |
| `pwa.carpals.ir`   | the consumer PWA                    | browsers                                             |
| `api.carpals.ir`   | the backend API                     | clients outside this server; not the BFF on this one |
| `id.carpals.ir`    | the authorization server            | the same; browsers use the PWA's `/id` pages         |
| `media.carpals.ir` | signed uploads and downloads        | browsers                                             |
| `web.carpals.ir`   | the business portal (not built yet) | the PWA only links to it; no nginx block yet         |
| `carpals.ir`       | a 301 to `https://www.carpals.ir`   | browsers                                             |
| `www.carpals.ir`   | the landing site (`landing/`)       | browsers and QR codes                                |
| `fleet.carpals.ir` | the web app's fleet view (later)    | redirects to `web.` then; coming-soon page until     |

`www.<DOMAIN>` and `<DOMAIN>` are the landing site, which runs on cPanel hosting (`landing/deploy/deploy.md`), so leave their DNS alone. That host also has a wildcard DNS record, which catches every name without its own record. So `pwa.`, `api.`, `id.` and `media.<DOMAIN>` each need their own A/AAAA record pointing at this server, or certbot fails.

**A PWA on its own server** would use the public addresses instead: set `BACKEND_API_URL=https://api.<DOMAIN>`, `BACKEND_AUTH_URL=https://id.<DOMAIN>` and `BACKEND_HEALTH_URL=https://api.<DOMAIN>/v1/health` in `pwa-deploy.conf`, set `CARPAL_API_URL` and `CARPAL_AUTH_URL` to the same values in `pwa.env`, and raise nginx's `carpal_api` limit, because every BFF call then arrives from one address. This layout has not been tested.

## Requirements

**Server**

- Ubuntu 24.04 LTS, x86_64 or arm64, root access (SSH).
- 2 vCPU, **4 GB RAM + swap** at least for the build (`next build` and the type check). The running service uses about 300-500 MB. With the backend on the same server, 8 GB is comfortable.
- Disk: about 2 GB per release (`node_modules` and `.next`); the update keeps 5 releases (`KEEP_BACKUPS`).
- Outbound internet during setup and updates: Ubuntu packages, `nodejs.org` (Node.js), `registry.npmjs.org` (pnpm and the dependencies), `acme-v02.api.letsencrypt.org` (certificates).
- Ports 80 and 443 open to the internet; nothing else needs to be public.

**Backend**

- The CarPal backend deployed on the same server with `backend/deploy/` and running (`systemctl status carpal-backend`). It must serve **contract 1.2.0 or newer**: `curl -sI http://127.0.0.1:8080/v1/health | grep -i carpal-contract`. `pwa-update.sh` checks this and stops otherwise.
- Its environment (`/carpal/config/backend.env`) must know the PWA's origin. The backend's template already writes these values; `pwa-setup.sh` checks them and warns:

  | backend.env                  | value                                                                          |
  | :--------------------------- | :----------------------------------------------------------------------------- |
  | `CARPAL_OAUTH_REDIRECT_URIS` | `cp-web-consumer` lists `https://pwa.<DOMAIN>/bff/oauth/callback`              |
  | `CARPAL_WEBAUTHN_ORIGINS`    | contains `https://pwa.<DOMAIN>` (passkeys)                                     |
  | `CARPAL_WEBAUTHN_RP_ID`      | `<DOMAIN>`                                                                     |
  | `CARPAL_MEDIA_CORS_ORIGINS`  | contains `https://pwa.<DOMAIN>` (photo uploads, PDF preview)                   |
  | `CARPAL_LINK_BASE_URL`       | `https://pwa.<DOMAIN>/l` (links in emails)                                     |
  | `CARPAL_MEDIA_BASE_URL`      | `https://media.<DOMAIN>`                                                       |
  | `CARPAL_API_AUDIENCE`        | `https://api.<DOMAIN>` — the same value as the PWA's                           |
  | `CARPAL_STRICT_AUTH`         | the same value as the PWA's (`1`, see below)                                   |
  | `CARPAL_OAUTH_CLIENT_JWKS`   | the public keys of `cp-web-consumer` and `cp-ssr` (`server-setup.sh` sets it)  |
  | `CARPAL_SIGNIN_URL`          | **unset** (the default `<issuer>/signin` is what the PWA's `/id` proxy serves) |

**DNS** (A/AAAA records to the server): `pwa.<DOMAIN>` for the PWA, and the backend's `api.`, `id.` and `media.<DOMAIN>`. In production: `pwa.carpals.ir`, `api.carpals.ir`, `id.carpals.ir` and `media.carpals.ir`. Leave `www.` and the bare domain on the landing site's host.

**Your PC**: WinSCP (SFTP to the server as root, or as a sudo user who owns the staging folder) and a copy of the repository.

## Before a public launch

The scripts produce a working production deployment, but the scratch build left items that must be closed before real users arrive (`pwa/dev_plan.json`, `stages[P14].report.next_iteration`, priority `pilot_blocker`):

| Item                                 | What it means for this deployment                                                                                                                                                                                                                                                                                                    |
| :----------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict auth (done, backend S11)      | Both sides run `CARPAL_STRICT_AUTH=1`: tokens are DPoP-bound and the BFF authenticates with `private_key_jwt`. The backend's `server-setup.sh` makes the key pairs (`/carpal/config/oauth-client-keys.json`), and `pwa-setup.sh` copies the private halves into `pwa.env`. Run the backend kit first.                                |
| **NI-P13-12 legal texts and domain** | **Go-live waits** until legal fills every bracketed placeholder (entity, addresses, dates) in the Privacy Policy and User Agreement and the Persian translations are published (decided 2026-11-04). The production domain is **carpals.ir**: `support@carpals.ir` (pwa.env) must be a mailbox you read (MX records for carpals.ir). |
| Exchange rate                        | The seeded USD → IRR rate is a **placeholder**: set the real one before anyone sees prices (backend `deploy.md`, "Exchange rate").                                                                                                                                                                                                   |
| Web push (OQ-26, open)               | Leave `CARPAL_PWA_VAPID_PUBLIC_KEY` empty: no push controls are shown until a push sender exists.                                                                                                                                                                                                                                    |
| Map tiles (OQ-02)                    | Without a style URL the map uses the built-in style without a basemap (pins, no streets).                                                                                                                                                                                                                                            |

Keep `CARPAL_ENV=staging` on the backend until the rest of backend NI-01 and real mail and SMS (NI-07) are done.

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
| `/etc/nginx/sites-available/carpal-pwa`  | root 644            | only when the backend's nginx site does not already serve `pwa.<DOMAIN>`               |

## Configuration

Three files, read in this order (later wins):

1. `pwa/deploy/pwa-deploy.conf.example` — defaults, part of the upload. Do not edit it on the server.
2. `/carpal/config/deploy.conf` — shared with the backend: at least `DOMAIN`, `LETSENCRYPT_EMAIL`, `STAGING_DIR`. Production: `DOMAIN=carpals.ir`, which gives `pwa.carpals.ir` (the PWA), `carpals.ir` (redirect), `api.`, `id.` and `media.carpals.ir`. Host overrides (`WEB_HOST`, `PORTAL_HOST`) go here too, because the backend kit reads the same names.
3. `/carpal/config/pwa-deploy.conf` — optional PWA-only overrides, for example `RUN_UNIT_TESTS=0`, `KEEP_BACKUPS=3`, `RUN_CERTBOT=1`.

Main settings of `pwa-deploy.conf.example`:

| Setting                                         | Default                           | Meaning                                                                                  |
| :---------------------------------------------- | :-------------------------------- | :--------------------------------------------------------------------------------------- |
| `WEB_HOST`                                      | `pwa.<DOMAIN>`                    | the PWA's public host name                                                               |
| `PORTAL_HOST`                                   | `web.<DOMAIN>`                    | the business portal the PWA links to                                                     |
| `STAGING_DIR`                                   | `/home/root/staging`              | the WinSCP upload folder                                                                 |
| `PWA_PORT`                                      | `3000`                            | local port of `next start` (the backend's nginx template proxies `pwa.<DOMAIN>` to 3000) |
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
| `CARPAL_STRICT_AUTH`                                | `1` (same as the backend)                                                 |
| `CARPAL_PWA_CLIENT_PRIVATE_JWKS`                    | private keys for `private_key_jwt`; `pwa-setup.sh` writes them            |
| `CARPAL_PWA_ORIGIN`                                 | `https://pwa.<DOMAIN>`                                                    |
| `CARPAL_API_URL` / `CARPAL_AUTH_URL`                | `http://127.0.0.1:8080` / `http://127.0.0.1:8082`                         |
| `CARPAL_STORAGE_URL`                                | `https://media.<DOMAIN>` (https required)                                 |
| `CARPAL_API_AUDIENCE`                               | `https://api.<DOMAIN>` (equal to the backend's)                           |
| `CARPAL_PWA_SESSION_STORE` / `CARPAL_PWA_REDIS_URL` | `redis` / `redis://:<password>@127.0.0.1:6379/0` (filled in by the setup) |
| `CARPAL_PWA_DEFAULT_TIME_ZONE`                      | `Asia/Tehran`                                                             |
| `CARPAL_PWA_SUPPORT_EMAIL`                          | `support@<DOMAIN>` — change to a real mailbox                             |
| `CARPAL_PWA_PORTAL_URL` / `…_SIGNUP_URL`            | `https://web.<DOMAIN>` and `…/signup` (the portal is not built yet)       |
| `CARPAL_PWA_MAP_STYLE_URL`                          | empty (region config), or a vector style on your own host                 |
| `CARPAL_PWA_VAPID_PUBLIC_KEY`                       | empty (OQ-26)                                                             |
| `CARPAL_PWA_MAINTENANCE`                            | empty; `on` or an ISO time shows the 503 maintenance page                 |
| `CARPAL_PWA_DEMO`                                   | `0`                                                                       |

**A change of `pwa.env` needs a rebuild**, not just a restart: `next build` prerenders some pages (manifests, robots, sitemaps' shells) with these values. Run `sudo bash /home/root/staging/pwa/deploy/pwa-update.sh` (the staging copy may stay as it is). Only `CARPAL_PWA_MAINTENANCE` works with a plain `systemctl restart carpal-pwa`.

## First deployment

Order: backend first, then the PWA.

1. **DNS.** Add A/AAAA records for `pwa.<DOMAIN>`, `api.`, `id.` and `media.<DOMAIN>` pointing at the server. Leave `www.` and `<DOMAIN>` as they are. Wait until `dig +short pwa.<DOMAIN>` shows the server's address.

2. **Backend.** Follow `backend/deploy/deploy.md` (its `server-setup.sh` creates `/carpal/config/deploy.conf` with `DOMAIN`, the backend service and an nginx site that already contains the `pwa.<DOMAIN>` block; its certbot command includes `pwa.<DOMAIN>`). Check: `curl -sI http://127.0.0.1:8080/v1/health` answers `200` with `carpal-contract: 1.2.0`.

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

7. **TLS.** If the backend's certbot run already covered `pwa.<DOMAIN>`, nothing to do. Otherwise:

   ```sh
   certbot --nginx -d pwa.<DOMAIN> --email <LETSENCRYPT_EMAIL> --agree-tos --redirect
   ```

   (or set `RUN_CERTBOT=1` in `/carpal/config/pwa-deploy.conf` and run `pwa-setup.sh` again). Certbot renews automatically (`systemctl list-timers | grep certbot`).

8. **Check** with [After each deployment](#after-each-deployment).

9. **Landing site.** On cPanel, take `pwa` out of the coming-soon list in `.htaccess` (`landing/deploy/deploy.md`). Requests for `pwa.<DOMAIN>` now reach this server, so that's only tidying.

## Updates

1. Upload the new code with WinSCP to `/home/root/staging/` (step 3 above; only `pwa/` and `shared/` are used, but uploading the whole repository is fine).
2. If the new version needs a newer backend (a new contract version), deploy the backend first (`sudo bash /home/root/staging/backend/deploy/update.sh`, `backend/deploy/deploy.md`).
3. Run:

   ```sh
   sudo bash /home/root/staging/pwa/deploy/pwa-update.sh
   ```

What it does, in order:

| Step                     | Detail                                                                                                                                                                                                                                                                                                                                  |
| :----------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preflight                | the upload has `pwa/package.json`, `pnpm-lock.yaml` and `shared/`; `pwa.env` and the service exist; `CARPAL_PWA_DEMO` is not 1; `CARPAL_PWA_ORIGIN` is `https://pwa.<DOMAIN>` and `CARPAL_API_AUDIENCE` is `https://api.<DOMAIN>`; the backend answers and serves at least the contract version the upload was generated for; free disk |
| Copy                     | `pwa/` and `shared/` from staging to `/carpal/pwa/src.new/` (without `node_modules`, `.next`, test output, local `.env` files) — before the stop, so the site keeps running meanwhile                                                                                                                                                   |
| Stop                     | `systemctl stop carpal-pwa` — **the site is down from here until the health check passes** (nginx answers 502)                                                                                                                                                                                                                          |
| Keep the current release | `/carpal/pwa/src` → `/carpal/backups/pwa-<time>/` (a complete, runnable folder)                                                                                                                                                                                                                                                         |
| Swap                     | `/carpal/pwa/src.new` → `/carpal/pwa/src`                                                                                                                                                                                                                                                                                               |
| Install and build        | `pnpm install --frozen-lockfile` (the lockfile decides every version), `pnpm typecheck`, `pnpm test`, `pnpm lint` (if enabled), `pnpm build` with `pwa.env` loaded. Runs as root in a clean environment.                                                                                                                                |
| Permissions              | code root-owned and read-only for `carpal-web`; `.next/` owned by `carpal-web`                                                                                                                                                                                                                                                          |
| Start                    | the unit is re-rendered from this upload's template, `systemctl start carpal-pwa`                                                                                                                                                                                                                                                       |
| Health check             | `/fa` answers 200 (through the `pwa.<DOMAIN>` host name) within 120 s; a BFF session is written to Redis and read back                                                                                                                                                                                                                  |
| Rollback                 | if the build, the start or the health check fails: the failed release goes to `/carpal/backups/pwa-<time>-failed/`, the previous one is moved back and started, and the script exits with an error that says what failed                                                                                                                |
| Clean up                 | keeps the newest 5 backups                                                                                                                                                                                                                                                                                                              |

Plan updates for quiet hours: the downtime is the build time (3-8 minutes). Set `RUN_UNIT_TESTS=0` / `RUN_TYPECHECK=0` in `pwa-deploy.conf` to shorten it once the same code passed `pnpm check` on your PC.

**Before uploading**, on your PC (`pwa/README.md` "Testing"): `pnpm check` and `pnpm build` pass, and ideally `pnpm e2e` against a local backend.

## After each deployment

```sh
systemctl status carpal-pwa --no-pager
journalctl -u carpal-pwa -n 50 --no-pager
curl -sI https://pwa.<DOMAIN>/fa | head -n 20          # 200, strict-transport-security, content-security-policy
curl -sI https://<DOMAIN>/ | grep -i location          # 301 to https://www.<DOMAIN>/
curl -s https://pwa.<DOMAIN>/robots.txt                 # names the sitemap on https://pwa.<DOMAIN>
```

In a browser (both `/fa` and `/en`):

1. The landing page loads; the cookie banner appears once.
2. Search for a service: results, the filter panel with counts, the map pane.
3. Sign up with a real email address; the verification mail's link opens `https://pwa.<DOMAIN>/l/…`; sign in, sign out, sign in again.
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
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: pwa.<DOMAIN>' -H 'X-Forwarded-Proto: https' http://127.0.0.1:3000/fa
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

## Changing the public host

A new server needs none of this. It applies to a server already set up for another host, such as `www.<DOMAIN>`, which now belongs to the landing site (deploy that once this move is done). `backend.env`, `pwa.env` and any nginx site with TLS blocks are never overwritten, so the scripts cannot move them for you; `pwa-update.sh` stops until `pwa.env` matches.

1. **DNS.** Point `pwa.<DOMAIN>` at the server.
2. **`/carpal/config/deploy.conf`.** Remove any old `WEB_HOST` line.
3. **`/carpal/config/backend.env`.** Put the new origin in `CARPAL_OAUTH_REDIRECT_URIS` (`cp-web-consumer`), `CARPAL_WEBAUTHN_ORIGINS`, `CARPAL_MEDIA_CORS_ORIGINS` and `CARPAL_LINK_BASE_URL`. Keep `CARPAL_WEBAUTHN_RP_ID=<DOMAIN>`, so existing passkeys keep working. Restart the backend.
4. **`/carpal/config/pwa.env`.** Set `CARPAL_PWA_ORIGIN=https://pwa.<DOMAIN>`, and the portal URLs if they changed.
5. **nginx.** In `/etc/nginx/sites-available/carpal` (or `carpal-pwa`), change `server_name` of the PWA block, and set the `return 301` target of the `<DOMAIN>` block to `https://www.<DOMAIN>$request_uri`, in the TLS blocks too. Then `nginx -t && systemctl reload nginx`.
6. **Certificate.** Find its name with `certbot certificates`, then replace its host list: `certbot --nginx --cert-name <name> -d api.<DOMAIN> -d id.<DOMAIN> -d media.<DOMAIN> -d pwa.<DOMAIN>`.
7. **Release.** Run `pwa-update.sh`, which rebuilds with the new origin.

Users are signed out, because cookies belong to the old host, and an installed PWA stays on the old address until it is installed again. Links in emails already sent still name the old host.

## Troubleshooting

| Symptom                                                                      | Cause and fix                                                                                                                                                                                                                                    |
| :--------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash: …/pwa-setup.sh: /usr/bin/env: 'bash\r'` or `$'\r': command not found` | The scripts were uploaded with Windows line ends. Upload again in **Binary** mode, or fix on the server: `sed -i 's/\r$//' /home/root/staging/pwa/deploy/*.sh /home/root/staging/pwa/deploy/templates/* /home/root/staging/pwa/deploy/*.example` |
| `pwa.env CARPAL_PWA_ORIGIN is …, but this deployment serves …`               | `pwa.env` still names another host: [Changing the public host](#changing-the-public-host).                                                                                                                                                       |
| The service does not start; journal shows `Invalid PWA environment:`         | A value in `pwa.env` is wrong; the line names it (e.g. `CARPAL_STORAGE_URL: must be https in prod`). Fix it and run `pwa-update.sh`.                                                                                                             |
| `the backend serves contract 1.1.x; this PWA needs 1.2.0`                    | Deploy the backend first.                                                                                                                                                                                                                        |
| 502 Bad Gateway                                                              | The service is stopped (an update is building) or crashed: `journalctl -u carpal-pwa -n 100`.                                                                                                                                                    |
| Sign-in ends on an error page from the auth host                             | `backend.env` `CARPAL_OAUTH_REDIRECT_URIS` lacks `https://pwa.<DOMAIN>/bff/oauth/callback`, or `CARPAL_SIGNIN_URL` is set. Restart the backend after the change.                                                                                 |
| Passkeys fail                                                                | `CARPAL_WEBAUTHN_RP_ID` must be `<DOMAIN>` and `CARPAL_WEBAUTHN_ORIGINS` must contain `https://pwa.<DOMAIN>`.                                                                                                                                    |
| Photo upload fails (CORS)                                                    | `CARPAL_MEDIA_CORS_ORIGINS` lacks `https://pwa.<DOMAIN>`; `media.<DOMAIN>` needs a certificate.                                                                                                                                                  |
| Links in emails open the wrong host                                          | `CARPAL_LINK_BASE_URL` in `backend.env` must be `https://pwa.<DOMAIN>/l`.                                                                                                                                                                        |
| Sign-in fails, and the auth log says `client_assertion_refused`              | The keys of `pwa.env` and `backend.env` differ. Compare them with `oauth-client-keys.json` (backend `deploy.md`, "Client keys").                                                                                                                 |
| Every signed-in action answers 401 "DPoP proof required"                     | `CARPAL_STRICT_AUTH` differs between `backend.env` and `pwa.env`. Set both to the same value and restart both.                                                                                                                                   |
| Many "Too many requests" at sign-in                                          | All sign-ins reach the auth host from 127.0.0.1 (DI-25): raise the backend's IP windows (its `CARPAL_RATE_LIMITS`, already raised by the backend template); nginx limits each real client address.                                               |
| Build killed / `JavaScript heap out of memory`                               | Add swap (`fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`, plus a line in `/etc/fstab`) or lower `BUILD_MEMORY_MB` with `RUN_UNIT_TESTS=0`.                                                           |
| `pnpm install --frozen-lockfile` fails                                       | `pwa/package.json` and `pnpm-lock.yaml` do not match in the upload: run `pnpm install` on your PC, commit both, upload again.                                                                                                                    |
| `GET /bff/csrf issued no session` / `not stored in Redis`                    | Redis is down or the password in `CARPAL_PWA_REDIS_URL` differs from `/etc/redis/carpal-pwa.conf`: `systemctl status redis-server`; run `pwa-setup.sh` again (it warns about a mismatch).                                                        |
| `nginx: [warn] conflicting server name "pwa.<DOMAIN>"`                       | Both the backend's site and `carpal-pwa` serve the host: `rm /etc/nginx/sites-enabled/carpal-pwa && nginx -t && systemctl reload nginx` (`pwa-setup.sh` does this when it finds the backend's block).                                            |

## Known limitations

- **Downtime during updates.** The release is built in place, because the Next.js build records its folder; the site is down for the build time (3-8 minutes). A second port with a switch in nginx would remove it (next iteration).
- **One PWA instance.** The BFF serializes token refreshes per process. A second instance (another server, or a second port behind nginx) needs the refresh lock in Redis first (NI-P13-03). Redis itself is already shared-ready.
- **The Redis session store had not met a real Redis before this deployment** (NI-P13-03); `pwa-update.sh` therefore writes and reads a session on every release and rolls back if that fails.
- **Rate limits** behind the BFF and nginx are per server address on the backend side (DI-25, DI-26, DI-28); nginx enforces per-client limits on the sign-in endpoints.
- **Web push** is not offered (OQ-26); **map tiles** fall back to the built-in style (OQ-02).
