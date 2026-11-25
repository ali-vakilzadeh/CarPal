# Deploying the CarPal admin console

This guide puts the staff console (`frontend/admin-console/`: the Next.js app, its BFF and the staff sign-in pages) on
the Ubuntu server that runs the CarPal backend, and keeps it up to date. You copy files to the server with WinSCP; two
scripts do the work on the server:

| Script                                          | When                                       | What it does                                                                                                                                                                                                                                                                                        |
| :---------------------------------------------- | :----------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/admin-console/deploy/admin-setup.sh`  | once per server (safe to run again)        | system packages, Node.js + pnpm, the service user `carpal-admin`, folders, `admin.env` with the staff client key, the systemd service, the nginx site with the access gate, TLS (optional), a check of the backend's settings, the base staff accounts on the first install, then the first release |
| `frontend/admin-console/deploy/admin-update.sh` | every new version (also the first release) | preflight, copy the code from the staging folder, stop the service, keep the current release as a backup, install, check and build, set permissions, start, health and header checks, automatic rollback on failure                                                                                 |

`lib.sh`, `admin-deploy.conf.example` and `templates/` are used by both scripts. The backend (`backend/deploy/`), the
PWA (`pwa/deploy/`) and the landing site (`landing/deploy/`) have their own kits; all of them share the server layout
(`/carpal`), `/carpal/config/deploy.conf` and the staging folder. Staff accounts, first sign-in, lost keys and the
daily routine are in [runbook.md](runbook.md).

Contents: [How it fits together](#how-it-fits-together) · [Requirements](#requirements) ·
[Server layout](#server-layout) · [Configuration](#configuration) · [Access gate](#access-gate) ·
[First deployment](#first-deployment) · [Updates](#updates) · [After each deployment](#after-each-deployment) ·
[Rollback](#rollback) · [Operations](#operations) · [Changing the host](#changing-the-host) ·
[Troubleshooting](#troubleshooting) · [Known limitations](#known-limitations)

---

## How it fits together

```
Staff browser ──https──▶ nginx :443 ── admin.<DOMAIN> ──▶ next start 127.0.0.1:3200  (carpal-admin: pages + BFF + /id sign-in)
     │                      (gate, rate limits)               │  server side only:
     │                                                        ├──▶ backend admin-api 127.0.0.1:8081 (never published)
     │                                                        └──▶ backend auth      127.0.0.1:8082
     └──https──▶ media.<DOMAIN> (5-minute signed display copies shown in the case and verification screens)
```

- The browser talks to **one origin**, `https://admin.<DOMAIN>`. It never receives a token. It holds one cookie
  (`__Host-cpa_sid`), plus `__Host-cpa_rcv` while a lost-key recovery waits. The BFF keeps the DPoP-bound tokens, the
  DPoP key and the staff profile in its own memory.
- `admin-api` stays unpublished (SEC-ADM-1): the BFF calls it on `127.0.0.1`. Its public name
  `https://admin-api.<DOMAIN>` (`ADMIN_HOST`) is only the audience of the tokens and DPoP proofs.
- Staff sign in on the console's own `/id/signin` (password, then a device-bound security key, aal3). The backend's
  `id.<DOMAIN>` stays the authorization server.
- The console listens on `127.0.0.1` only, behind exactly one nginx that appends the client address to
  `X-Forwarded-For`. The BFF tells the backend who the visitor is in a signed `CarPal-Forwarded-Client` header taken
  from that last hop (D-110). Never put a second proxy in front without changing that.

Host names (`DOMAIN=carpals.ir`): the console is `admin.carpals.ir` (`ADMIN_CONSOLE_HOST`). Careful: in the shared
`deploy.conf`, **`ADMIN_HOST` is the backend's admin-api host** (`admin-api.carpals.ir`), not the console.
`admin.carpals.ir` is not publicised and the landing site does not link to it.

## Requirements

**Server.** The backend's server (Ubuntu 24.04 LTS, root access). The console's build needs about **4 GB RAM + swap**
(`next build` and the type check); the running service uses 200-400 MB. Disk: about 1.5 GB per release, 5 releases
kept. Outbound internet during setup and updates (Ubuntu packages, `nodejs.org`, `registry.npmjs.org`, Let's Encrypt).

**Backend.** Deployed with `backend/deploy/` and running, serving **contract 1.5.0 or newer**
(`curl -sI http://127.0.0.1:8080/v1/health | grep -i carpal-contract`; `admin-update.sh` checks it against the
version the upload was generated for). Its `server-setup.sh` made `/carpal/config/oauth-admin-client-keys.json`, the
key pair of the console's OAuth client `cp-web-admin`. `backend.env` must know the console; the backend's template
already writes these values and `admin-setup.sh` checks them:

| backend.env                  | value                                                                                       |
| :--------------------------- | :------------------------------------------------------------------------------------------ |
| `CARPAL_OAUTH_REDIRECT_URIS` | `cp-web-admin` lists `https://admin.<DOMAIN>/bff/oauth/callback`                            |
| `CARPAL_WEBAUTHN_ORIGINS`    | contains `https://admin.<DOMAIN>` (staff security keys)                                     |
| `CARPAL_WEBAUTHN_RP_ID`      | `<DOMAIN>`                                                                                  |
| `CARPAL_AUTH_WEB_ORIGINS`    | unset, or a list that contains `https://admin.<DOMAIN>`                                     |
| `CARPAL_OAUTH_CLIENT_JWKS`   | carries the public key of `cp-web-admin` (`server-setup.sh` sets it)                        |
| `CARPAL_ADMIN_API_AUDIENCE`  | `https://admin-api.<DOMAIN>`, the same value as the console's                               |
| `CARPAL_STRICT_AUTH`         | `1`, the same value as the console's                                                        |
| `CARPAL_SIGNIN_URL`          | **unset** (the console's `/id` proxy serves `<issuer>/signin`)                              |
| `CARPAL_MAIL_TRANSPORT`      | `smtp` once the mailbox exists (sign-in codes); until then the codes are in the mail outbox |

**DNS.** An A/AAAA record for `admin.<DOMAIN>` pointing at the server. The landing site's host has a wildcard record
that catches every name without its own, so without this record `admin.<DOMAIN>` reaches cPanel and certbot fails.

**Your PC.** WinSCP (SFTP as root, or as a sudo user who owns the staging folder) and a copy of the repository.

## Server layout

| Path                                              | Owner / mode          | Content                                                                                       |
| :------------------------------------------------ | :-------------------- | :-------------------------------------------------------------------------------------------- |
| `/home/root/staging/`                             | root 700              | what WinSCP uploads: the repository (`frontend/`, `shared/`, `backend/`, …)                   |
| `/carpal/admin/src/`                              | root:carpal-admin 750 | the running release: `frontend/admin-console/` (with `node_modules/`, `.next/`) and `shared/` |
| `/carpal/admin/src/frontend/admin-console/.next/` | carpal-admin          | the build; the service writes its cache here                                                  |
| `/carpal/config/admin.env`                        | root:carpal-admin 640 | the service environment, with the private key of `cp-web-admin`                               |
| `/carpal/config/oauth-admin-client-keys.json`     | root 600              | the key pair (backend kit); `admin.env` holds a copy of it                                    |
| `/carpal/config/deploy.conf`                      | root 640              | shared settings of all kits (`DOMAIN`, `LETSENCRYPT_EMAIL`, `STAGING_DIR`, host overrides)    |
| `/carpal/config/admin-deploy.conf`                | root 640 (optional)   | console-only overrides of `admin-deploy.conf.example`                                         |
| `/carpal/admin/.staff-bootstrap-done`             | root                  | the date `admin-setup.sh` ran the staff bootstrap (it runs once)                              |
| `/carpal/backups/admin-<time>/`                   | root 700              | previous releases (whole folder, ready to move back)                                          |
| `/carpal/logs/admin-deploy-<date>.log`            | root 750              | output of every script run                                                                    |
| `/etc/systemd/system/carpal-admin.service`        | root 644              | the service (user `carpal-admin`, `next start` on 127.0.0.1:3200)                             |
| `/etc/nginx/sites-available/carpal-admin`         | root 644              | the `admin.<DOMAIN>` server block with the gate and rate limits                               |

The console runs as its own user, `carpal-admin`, not as the PWA's `carpal-web`, so the PWA's process can never read
the staff client's key.

## Configuration

Three files, read in this order (later wins):

1. `deploy/admin-deploy.conf.example` — defaults, part of the upload. Do not edit it on the server.
2. `/carpal/config/deploy.conf` — shared: at least `DOMAIN`, `LETSENCRYPT_EMAIL`, `STAGING_DIR`. Host overrides
   (`ADMIN_CONSOLE_HOST`, `ADMIN_HOST`, `WEB_HOST`, `MEDIA_HOST`) go here, because the backend kit reads the same names.
3. `/carpal/config/admin-deploy.conf` — optional console-only overrides, for example `ADMIN_GATE=ip_allowlist`,
   `RUN_UNIT_TESTS=0`, `RUN_CERTBOT=1`.

Main settings of `admin-deploy.conf.example`:

| Setting                                         | Default                           | Meaning                                                                                    |
| :---------------------------------------------- | :-------------------------------- | :----------------------------------------------------------------------------------------- |
| `ADMIN_CONSOLE_HOST`                            | `admin.<DOMAIN>`                  | the console's host name                                                                    |
| `ADMIN_GATE` / `ADMIN_GATE_ALLOW`               | `none` / empty                    | [Access gate](#access-gate)                                                                |
| `ADMIN_ENV`                                     | `prod`                            | the environment badge on every page (`prod` or `staging`); the pilot server has real data  |
| `ADMIN_PORT`                                    | `3200`                            | local port of `next start` (127.0.0.1 only)                                                |
| `BACKEND_ADMIN_API_URL` / `BACKEND_AUTH_URL`    | `http://127.0.0.1:8081` / `:8082` | where the BFF reaches the backend                                                          |
| `REQUIRE_BACKEND`                               | `1`                               | an update stops when the backend is down or serves an older contract                       |
| `RUN_TYPECHECK` / `RUN_UNIT_TESTS` / `RUN_LINT` | `1` / `1` / `0`                   | checks before `next build`                                                                 |
| `BUILD_ATTEMPTS`                                | `2`                               | `next build` sometimes stops after a good compile (Next.js advisory check); a rerun passes |
| `AUTO_ROLLBACK`                                 | `1`                               | a failed release is replaced by the previous one                                           |
| `RUN_CERTBOT`                                   | `0`                               | `1` = `admin-setup.sh` requests the certificate itself                                     |
| `RUN_STAFF_BOOTSTRAP`                           | `1`                               | on the first install, run the backend's `staff-bootstrap.sh` when the staff spec exists    |
| `FIRST_DEPLOY`                                  | `1`                               | `admin-setup.sh` ends by running `admin-update.sh`                                         |

**`/carpal/config/admin.env`** is written once by `admin-setup.sh` from `templates/admin.env.template` and never
overwritten. Every variable is validated when the service starts (`src/server/env.ts`); a bad value stops the start and
`journalctl -u carpal-admin` names it. Outside dev the console refuses http origins, strict mode off, a missing client
key and the dev redirect shim.

| Variable                                      | Production value                                                                  |
| :-------------------------------------------- | :-------------------------------------------------------------------------------- |
| `CARPAL_ADMIN_ENV`                            | `prod` (the badge; `staging` on a test server)                                    |
| `CARPAL_STRICT_AUTH`                          | `1` (same as the backend)                                                         |
| `CARPAL_ADMIN_CLIENT_PRIVATE_JWKS`            | the content of `oauth-admin-client-keys.json`; `admin-setup.sh` writes it         |
| `CARPAL_ADMIN_ORIGIN`                         | `https://admin.<DOMAIN>`                                                          |
| `CARPAL_ADMIN_API_URL` / `CARPAL_AUTH_URL`    | `http://127.0.0.1:8081` / `http://127.0.0.1:8082`                                 |
| `CARPAL_ADMIN_API_AUDIENCE`                   | `https://admin-api.<DOMAIN>` (equal to the backend's)                             |
| `CARPAL_STORAGE_URL`                          | `https://media.<DOMAIN>` (the page CSP allows it for images and video)            |
| `CARPAL_ADMIN_PUBLIC_WEB_URL`                 | `https://pwa.<DOMAIN>` ("Open the public page" links)                             |
| `CARPAL_ADMIN_SESSION_STORE`                  | `lite` (in this process; see [Known limitations](#known-limitations))             |
| `CARPAL_ADMIN_DEFAULT_LOCALE` / `…_TIME_ZONE` | `fa` / `Asia/Tehran`                                                              |
| `CARPAL_ADMIN_MAP_STYLE_URL`                  | unset: no basemap in the console; the Locations tab opens a pin in Neshan (OQ-16) |
| `CARPAL_ADMIN_OAUTH_REDIRECT_URI`             | must stay unset (dev and E2E only)                                                |

A change of `admin.env` needs only `systemctl restart carpal-admin` (the console renders every page per request), but
running `admin-update.sh` again is just as good.

## Access gate

`ADMIN_GATE` decides who can reach `admin.<DOMAIN>` at all (SEC-ADM-1). Whatever the gate, every staff sign-in needs
the password and a device-bound security key (aal3), and the pages, the BFF and the sign-in endpoints are rate-limited
per client address.

| `ADMIN_GATE`   | Effect                                                                                                                                                                                                               |
| :------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`         | **Default** (OQ-02, owner 2026-11-12: passkey only). Anyone can open the sign-in page.                                                                                                                               |
| `ip_allowlist` | Only `ADMIN_GATE_ALLOW` (space-separated addresses or CIDRs) reach the console; others get nginx's 403. Every location of the site gets the `allow`/`deny` lines, so certbot's own challenge location keeps working. |

`admin-setup.sh` renders the site with the gate while the site has no TLS block. After certbot has added TLS the
script leaves the site alone (and warns when the file and `ADMIN_GATE` disagree): edit
`/etc/nginx/sites-available/carpal-admin` by hand, putting the same lines into every `location` of both server blocks:

```nginx
        allow 203.0.113.10;
        allow 198.51.100.0/24;
        deny all;
```

then `nginx -t && systemctl reload nginx`. Staff then work from those addresses only (office network or VPN); a
mobile connection will not do.

## First deployment

Order: backend, then the console (the PWA may come before or after).

1. **DNS.** Add the A/AAAA record for `admin.<DOMAIN>`. Wait until `dig +short admin.<DOMAIN>` shows the server.

2. **Backend.** Follow `backend/deploy/deploy.md`. Check: `curl -sI http://127.0.0.1:8080/v1/health` answers `200`
   with `carpal-contract: 1.5.0` (or newer), and `/carpal/config/oauth-admin-client-keys.json` exists.

3. **Staff spec** (optional now, needed before anyone signs in): copy
   `backend/deploy/templates/staff-bootstrap.json.example` to `/carpal/config/staff-bootstrap.json`, fill in the real
   names and addresses, and put the owner's initial password in `backend.env` (`CARPAL_STAFF_INITIAL_PASSWORD`).
   [runbook.md](runbook.md) "First staff accounts" explains both. With the file in place, `admin-setup.sh` creates
   the accounts on its first run.

4. **Upload with WinSCP.** SFTP, _Preferences → Transfer_ **Binary** (keeps the scripts' Linux line ends). Upload the
   repository to `/home/root/staging/` so that `/home/root/staging/frontend/admin-console/package.json` and
   `/home/root/staging/shared/` exist. Leave out build output with a file mask:

   ```
   | node_modules/; .next/; .data/; .tools/; dist/; test-results/; playwright-report/; .git/; public/ds/; secrets/
   ```

5. **Run the setup** in an SSH session:

   ```sh
   sudo bash /home/root/staging/frontend/admin-console/deploy/admin-setup.sh
   ```

   - If `/carpal/config/deploy.conf` does not exist yet, the first run creates it and stops: set `DOMAIN` and
     `LETSENCRYPT_EMAIL`, then run it again.
   - It prints a warning for every backend setting from [Requirements](#requirements) that does not match. Fix
     `backend.env` and restart the backend (`sudo bash /carpal/backend/src/backend/deploy/4-start.sh`) if needed.
   - With `FIRST_DEPLOY=1` it continues with `admin-update.sh` (3-8 minutes) and ends with "Release … runs".

6. **Review `/carpal/config/admin.env`.** If you change anything, `systemctl restart carpal-admin`.

7. **TLS.** `certbot --nginx -d admin.<DOMAIN> --email <LETSENCRYPT_EMAIL> --agree-tos --redirect` (or
   `RUN_CERTBOT=1` in `admin-deploy.conf` and run `admin-setup.sh` again). `--redirect` makes port 80 answer with a
   redirect to https (OQ-11); the console itself sends HSTS.

8. **Check** with [After each deployment](#after-each-deployment), then hand over the accounts
   ([runbook.md](runbook.md)).

## Updates

1. Upload the new code with WinSCP to `/home/root/staging/` (only `frontend/admin-console/` and `shared/` are used).
2. If the console needs a newer backend contract, deploy the backend first (`backend/deploy/deploy.md`).
3. Look at **Recovery requests** in the console: the update signs everybody out and forgets a lost-key recovery that
   is waiting for its approvals (the requester would have to start again). Prefer a moment without one.
4. Run:

   ```sh
   sudo bash /home/root/staging/frontend/admin-console/deploy/admin-update.sh
   ```

| Step                     | Detail                                                                                                                                                                                                                                                                               |
| :----------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preflight                | the upload has the app, its lockfile and `shared/`; `admin.env` and the service exist; `CARPAL_ADMIN_ORIGIN` is `https://<ADMIN_CONSOLE_HOST>`, the audience is `https://<ADMIN_HOST>`, no dev settings; the backend answers with at least the console's contract version; free disk |
| Copy                     | `frontend/admin-console/` and `shared/` to `/carpal/admin/src.new/` (without `node_modules`, `.next`, test output, local `.env` and key files) — before the stop, so the console keeps running meanwhile                                                                             |
| Stop                     | `systemctl stop carpal-admin` — **the console is down from here until the health check passes** (nginx answers 502), and every staff member is signed out                                                                                                                            |
| Keep the current release | `/carpal/admin/src` → `/carpal/backups/admin-<time>/`                                                                                                                                                                                                                                |
| Install and build        | `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm lint` (if enabled), `pnpm build` with `admin.env` loaded (a second attempt after a failed build, `BUILD_ATTEMPTS`)                                                                                            |
| Permissions              | code root-owned and read-only for `carpal-admin`; `.next/` owned by `carpal-admin`                                                                                                                                                                                                   |
| Start                    | the unit is re-rendered from this upload's template, `systemctl start carpal-admin`                                                                                                                                                                                                  |
| Health check             | `/id/signed-out` answers 200 (through the console's host name) within 120 s; `/bff/csrf` issues a session and reads it back; the page carries CSP, HSTS, `no-store` and `noindex`                                                                                                    |
| Rollback                 | if the build, the start or a check fails: the failed release goes to `/carpal/backups/admin-<time>-failed/`, the previous one is moved back and started, and the script names what failed                                                                                            |
| Clean up                 | keeps the newest 5 backups                                                                                                                                                                                                                                                           |

**Before uploading**, on your PC (`README.md` "Commands"): `pnpm check` and `pnpm build` pass, and the pilot E2E
suite (`pnpm e2e:pilot`, README "End-to-end tests") passes against a local strict backend. For a release that changes
screens, run the whole suite (`pnpm exec playwright test`: role journeys, accessibility, RTL screenshots and the
security review, AC15) and `pnpm audit --prod` (no high or critical advisory; `security-pass.md` lists the accepted
ones).

## After each deployment

```sh
systemctl status carpal-admin --no-pager
journalctl -u carpal-admin -n 50 --no-pager
curl -sI https://admin.<DOMAIN>/id/signed-out | head -n 20   # 200, strict-transport-security, content-security-policy, cache-control: private, no-store
curl -sI http://admin.<DOMAIN>/ | grep -i location          # 301 to https://admin.<DOMAIN>/
curl -s -o /dev/null -w '%{http_code}\n' https://admin.<DOMAIN>/api/v1/admin/me   # 401 (no session)
```

In a browser (a staff account with its security key at hand):

1. `https://admin.<DOMAIN>/` goes to the sign-in. The environment badge shows **PROD** (or STAGING).
2. Sign in with password and security key; My work loads with the tiles of your roles.
3. Open **Exchange rates**: the list loads (an admin-api read through the BFF works).
4. Open a moderation case or a verification with a document: the display copy shows (the media host answers
   `Cross-Origin-Resource-Policy: cross-origin`; a blank viewer means it does not, R-23).
5. Sign out; the browser lands on the signed-out page.

## Rollback

The update rolls back on its own when the new release fails. By hand:

```sh
ls -1dt /carpal/backups/admin-*                       # newest first; *-failed never ran
sudo systemctl stop carpal-admin
sudo mv /carpal/admin/src /carpal/backups/admin-$(date +%Y%m%d-%H%M%S)-rolled-back
sudo mv /carpal/backups/admin-<time> /carpal/admin/src
sudo systemctl start carpal-admin
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: admin.<DOMAIN>' -H 'X-Forwarded-Proto: https' http://127.0.0.1:3200/id/signed-out
```

A backup holds its own `node_modules` and `.next`, so nothing has to be built. An older release may need an older
backend contract; check the backend's version first.

## Operations

| Task               | Command                                                                                                                          |
| :----------------- | :------------------------------------------------------------------------------------------------------------------------------- |
| Status / logs      | `systemctl status carpal-admin`, `journalctl -u carpal-admin -f` (the console logs no bodies, tokens or URLs with personal data) |
| Restart            | `sudo systemctl restart carpal-admin` — signs every staff member out                                                             |
| Sign everybody out | the same restart (sessions live only in the process)                                                                             |
| Deploy script logs | `/carpal/logs/admin-deploy-<date>.log`                                                                                           |
| Certificates       | `certbot certificates`; renewal is automatic                                                                                     |
| Backup             | `/carpal/config/admin.env` with the backend's config folder. Sessions need no backup.                                            |
| Staff tasks        | [runbook.md](runbook.md): new accounts, an expired initial password, lost keys, break glass                                      |

## Changing the host

`admin.env` and an nginx site with TLS are never overwritten, so a new host needs these steps by hand; `admin-update.sh`
stops until `admin.env` matches.

1. DNS for the new host; `ADMIN_CONSOLE_HOST=<new host>` in `/carpal/config/deploy.conf`.
2. `backend.env`: the new origin in `CARPAL_OAUTH_REDIRECT_URIS` (`cp-web-admin`) and `CARPAL_WEBAUTHN_ORIGINS` (and
   `CARPAL_AUTH_WEB_ORIGINS` if it is set). Keep `CARPAL_WEBAUTHN_RP_ID=<DOMAIN>`, so the staff's keys keep working
   on a host under the same domain. Restart the backend.
3. `admin.env`: `CARPAL_ADMIN_ORIGIN=https://<new host>`.
4. nginx: change `server_name` in both server blocks of `/etc/nginx/sites-available/carpal-admin`, then
   `certbot --nginx -d <new host> --agree-tos --redirect`.
5. `admin-update.sh`.

## Troubleshooting

| Symptom                                                                                     | Cause and fix                                                                                                                                                                                                                                                          |
| :------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/usr/bin/env: 'bash\r'` or `$'\r': command not found`                                      | Uploaded with Windows line ends. Upload again in **Binary** mode, or: `sed -i 's/\r$//' /home/root/staging/frontend/admin-console/deploy/*.sh /home/root/staging/frontend/admin-console/deploy/templates/* /home/root/staging/frontend/admin-console/deploy/*.example` |
| `oauth-admin-client-keys.json is missing`                                                   | The backend's `server-setup.sh` has not run (it makes the key pair). Run the backend kit first.                                                                                                                                                                        |
| The service does not start; journal shows `Invalid admin console environment:`              | A value in `admin.env` is wrong; the line names it. Fix it and `systemctl restart carpal-admin`.                                                                                                                                                                       |
| `the backend serves contract 1.4.x; this console needs 1.5.0`                               | Deploy the backend first.                                                                                                                                                                                                                                              |
| `… is already served by …`                                                                  | Another enabled nginx site names `admin.<DOMAIN>`. Remove that server block; the console's gate and limits live in `carpal-admin`.                                                                                                                                     |
| 502 Bad Gateway                                                                             | The service is stopped (an update is building) or crashed: `journalctl -u carpal-admin -n 100`.                                                                                                                                                                        |
| The sign-in ends on an error page of the auth host                                          | `CARPAL_OAUTH_REDIRECT_URIS` lacks `https://admin.<DOMAIN>/bff/oauth/callback` for `cp-web-admin`, or `CARPAL_SIGNIN_URL` is set. Restart the backend after the change.                                                                                                |
| Every token request fails; the auth log says `invalid_client` or `client_assertion_refused` | `CARPAL_OAUTH_CLIENT_JWKS` lacks `cp-web-admin`, or `admin.env` holds another key than `oauth-admin-client-keys.json`.                                                                                                                                                 |
| Every admin call answers 401 "DPoP proof required" or an htu error                          | `CARPAL_STRICT_AUTH` or `CARPAL_ADMIN_API_AUDIENCE` differs between `backend.env` and `admin.env`.                                                                                                                                                                     |
| The security key prompt fails or the key is refused                                         | `CARPAL_WEBAUTHN_ORIGINS` lacks `https://admin.<DOMAIN>`, or `CARPAL_WEBAUTHN_RP_ID` is not `<DOMAIN>`. A synced passkey (iCloud, Google) is refused by design (SEC-ADM-2).                                                                                            |
| Signed out after a few minutes of reading                                                   | By design: 30 minutes without an action (refreshes the console makes on its own do not count), 8 hours at most.                                                                                                                                                        |
| Media viewer blank                                                                          | The media host sends `Cross-Origin-Resource-Policy: same-origin`, or `CARPAL_STORAGE_URL` is not the host of the signed links (R-23).                                                                                                                                  |
| Many "Too many requests" on the sign-in                                                     | nginx's per-address limits (`carpal_admin_signin`: 2 a minute after a burst of 20). Wait a minute; staff behind one office address share them.                                                                                                                         |
| 403 Forbidden from nginx                                                                    | `ADMIN_GATE=ip_allowlist` and the address is not in `ADMIN_GATE_ALLOW` ([Access gate](#access-gate)).                                                                                                                                                                  |
| Build killed / `JavaScript heap out of memory`                                              | Add swap (`fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`, plus `/etc/fstab`) or `RUN_UNIT_TESTS=0`.                                                                                                                        |
| `pnpm install --frozen-lockfile` fails                                                      | `package.json` and `pnpm-lock.yaml` do not match in the upload: `pnpm install` on your PC, commit both, upload again.                                                                                                                                                  |

## Known limitations

- **Sessions in memory (D-112).** A restart, and so every update, signs every staff member out and forgets the
  handle of a lost-key recovery that is still waiting for approvals; the requester then starts a new request. In
  exchange the staff tokens never leave the console process. A shared store (`CARPAL_ADMIN_SESSION_STORE=redis`)
  exists in the code but has not met a real Redis, and it must not share the PWA's Redis password.
- **Downtime during updates** for the build time (3-8 minutes), as for the PWA.
- **One instance.** Sessions are per process; a second instance needs the shared store first.
- **Not tested on a real server yet.** The scripts follow the PWA kit, which has the same structure; the first run
  on the server is the owner's (AC11 out_of_scope).
