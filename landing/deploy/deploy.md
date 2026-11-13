# Deploying the CarPal landing site

The landing site (`landing/`: plain HTML in English and Persian) is the public front door at `www.<DOMAIN>`. **It runs on cPanel hosting today**: see [On cPanel](#on-cpanel). The rest of this guide is for moving it to the CarPal server, should you decide to. There you copy files with WinSCP, and two scripts do the rest:

| Script                             | When                                | What it does                                                                                                                                                    |
| :--------------------------------- | :---------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `landing/deploy/landing-setup.sh`  | once per server (safe to run again) | nginx and certbot, the folders, the nginx site, TLS (optional), a check of the bare domain's redirect, then the first release                                   |
| `landing/deploy/landing-update.sh` | every new version                   | preflight, copy from staging, write this deployment's hosts into the pages, permissions, switch to the new release, health check, automatic rollback on failure |

The landing site has no build, no service and no backend calls. An update causes no downtime: nginx reads the `current` link on every request, so the scripts never stop or reload anything.

Contents: [How it fits together](#how-it-fits-together) · [On cPanel](#on-cpanel) · [Requirements](#requirements) · [Server layout](#server-layout) · [First deployment](#first-deployment) · [Updates](#updates) · [After each deployment](#after-each-deployment) · [Rollback](#rollback) · [Another market](#another-market) · [Turning on a future link](#turning-on-a-future-link) · [Troubleshooting](#troubleshooting)

---

## How it fits together

`www.<DOMAIN>` is where QR codes in advertising point. It opens an entry page, and one tap leads to the intro and benefits pages. The bare `<DOMAIN>` redirects to it. The pages link out to each component:

| Link             | For                                 | State                                                                   |
| :--------------- | :---------------------------------- | :---------------------------------------------------------------------- |
| `pwa.<DOMAIN>`   | car owners                          | live once the PWA is deployed                                           |
| `web.<DOMAIN>`   | service providers and parts sellers | active on the pages; shows the coming-soon page until the web UI exists |
| `fleet.<DOMAIN>` | fleet owners                        | "coming soon" on the pages; the address shows the coming-soon page      |
| Android app      | car owners                          | no link yet; added when the app is published                            |

The admin console is a separate staff app (owner decision DQ-03) and is not publicised, so the landing site never links to it. The full plan is in `Docs/02.Detailed project plan.md`, §1.4 and WP22.

## On cPanel

Upload everything inside `landing/` to `public_html`, **except the `deploy/` folder**. `.htaccess` does three things there:

- It shows `404.html`, the coming-soon page, for any address that doesn't exist.
- It redirects `<DOMAIN>` to `www.<DOMAIN>`.
- It shows the coming-soon page on every path of `web.`, `fleet.` and `pwa.`, which share this folder until their apps go live. Take a name out of its list when that app goes live.

If `public_html` already has a `.htaccess`, merge these lines into it rather than replacing it, because cPanel may keep its own settings there. This hosting serves any name without its own DNS record (a wildcard), so a host moves to the app server as soon as it gets its own A/AAAA record.

On cPanel, `landing-update.sh` doesn't run, so the pages keep naming `carpals.ir` as written. The Content-Security-Policy below belongs to the nginx site and isn't applied here.

## Requirements

- The CarPal server, set up with `backend/deploy/` and `pwa/deploy/` first. The landing site doesn't need them to run, but the bare domain's redirect comes from their nginx site.
- `BARE_DOMAIN_HERE=1` in `/carpal/config/deploy.conf`, because the bare domain moves too. `web.` and `fleet.` need nginx blocks of their own: the `.htaccess` rules don't apply on nginx.
- DNS: an A/AAAA record for `www.<DOMAIN>` to the server. `<DOMAIN>` is already there for the backend kit.
- `/carpal/config/deploy.conf` with `DOMAIN` and `LETSENCRYPT_EMAIL` (shared with the other kits).

## Server layout

| Path                                        | Owner / mode        | Content                                                 |
| :------------------------------------------ | :------------------ | :------------------------------------------------------ |
| `/home/root/staging/landing/`               | root 700            | what WinSCP uploads                                     |
| `/carpal/landing/releases/<time>/`          | root:www-data 750   | one folder per release; the newest 5 are kept           |
| `/carpal/landing/current`                   | link                | the release nginx serves                                |
| `/carpal/config/landing-deploy.conf`        | root 640 (optional) | landing-only overrides of `landing-deploy.conf.example` |
| `/carpal/logs/landing-deploy-<date>.log`    | root 750            | output of every script run                              |
| `/etc/nginx/sites-available/carpal-landing` | root 644            | the nginx site                                          |

`landing/deploy/` is never copied into a release, so it's never served.

## First deployment

1. **DNS.** This takes the live site off cPanel, so do it last among the DNS changes: run steps 2 and 3 first, because the health check doesn't need DNS. Then point `www.<DOMAIN>` and `<DOMAIN>` at the server, and wait until `dig +short www.<DOMAIN>` shows its address.

2. **Upload with WinSCP** as for the other kits (binary mode, to `/home/root/staging/`), so that `/home/root/staging/landing/index.html` exists.

3. **Run the setup:**

   ```sh
   sudo bash /home/root/staging/landing/deploy/landing-setup.sh
   ```

   With `FIRST_DEPLOY=1` it continues with the first release. If it stops with "already serves www.<DOMAIN>", the PWA still uses that host: follow "Changing the public host" in `pwa/deploy/deploy.md` first.

4. **TLS:**

   ```sh
   certbot --nginx -d www.<DOMAIN> --email <LETSENCRYPT_EMAIL> --agree-tos --redirect
   ```

   Or set `RUN_CERTBOT=1` in `/carpal/config/landing-deploy.conf` and run the setup again.

5. **The bare domain.** The setup warns if `<DOMAIN>` doesn't redirect here. That happens on a server whose nginx site already has TLS blocks, because the scripts leave those alone. In `/etc/nginx/sites-available/carpal` (or `carpal-pwa`), set the `<DOMAIN>` block to `return 301 https://www.<DOMAIN>$request_uri;`, in the TLS blocks too. Then run `nginx -t && systemctl reload nginx`.

6. **Check** with [After each deployment](#after-each-deployment).

## Updates

Upload the new files with WinSCP, then:

```sh
sudo bash /home/root/staging/landing/deploy/landing-update.sh
```

It takes a few seconds. If a page fails the health check, the script goes back to the previous release and says so; the failed release stays in `releases/` until it's pruned.

**An update doesn't change nginx.** If `templates/nginx-carpal-landing.conf` changes, run `landing-setup.sh` again. On a site with TLS blocks, apply the change by hand.

## After each deployment

```sh
curl -sI https://www.<DOMAIN>/en/ | head -n 12          # 200, content-security-policy, strict-transport-security
curl -sI https://<DOMAIN>/ | grep -i location           # 301 to https://www.<DOMAIN>/
curl -s https://www.<DOMAIN>/en/ | grep -c 'pwa.<DOMAIN>'  # above 0: the links name this deployment's hosts
```

In a browser, open `https://www.<DOMAIN>/`: the entry page should appear in your language. Tap it, switch language and theme, and follow the "Install the app" link. An address that doesn't exist should show the coming-soon page.

**QR codes** link to `https://www.<DOMAIN>/`. That address picks the visitor's language and survives a change of design. `carpals.ir` stays live for Iran, so its codes are safe to print. Each other market gets its own.

## Rollback

```sh
ls -1dt /carpal/landing/releases/*                                  # newest first
sudo ln -sfn /carpal/landing/releases/<time> /carpal/landing/current
```

The site is back at once; nothing needs a restart.

## Another market

`carpals.ir` stays live for Iran. Every other market has its own domain, its own legal structure and its own QR codes, so it's a separate deployment, not a change to this one (`Docs/02`, §1.4 and §15).

The HTML keeps naming `carpals.ir`, and `landing-update.sh` writes the deployment's hosts into each release. So a market's server needs only `DOMAIN` in its `/carpal/config/deploy.conf`, and the hosts follow as `www.`, `pwa.`, `web.` and `fleet.`. To give one a different name, set its override there: `LANDING_HOST`, `WEB_HOST`, `PORTAL_HOST`, `FLEET_HOST`. Legal texts and any market-specific wording still need their own edit.

## Turning on a future link

**Fleet.** When the web UI is ready, `fleet.<DOMAIN>` stops showing the coming-soon page and redirects to the web app, with an option such as `?fleet` that limits it to fleet pages. While the host is on cPanel, take `fleet` out of the list in `.htaccess` and add:

```apache
RewriteCond %{HTTP_HOST} ^fleet\.carpals\.ir$ [NC]
RewriteCond %{REQUEST_URI} !^/\.well-known/
RewriteRule ^ https://web.carpals.ir/?fleet [R=302,L]
```

Then turn on the links. Every place that waits is marked `data-soon="fleet"` (`grep -rn 'data-soon' landing/`): 3 places on each benefits page and 2 on each home page. Turn each one back into a link:

```html
<!-- a button -->
<a class="cp-btn cp-btn-secondary" href="https://fleet.carpals.ir/"
  >Open fleet portal</a
>
<!-- fa: ورود به پورتال ناوگان -->
<!-- in the footer -->
<a href="https://fleet.carpals.ir/">Fleet portal</a>
<!-- fa: پورتال ناوگان -->
```

Keep each button's existing class, then publish.

**Android.** This link doesn't exist yet. It needs new markup on all four pages when the app is published (`Docs/02`, WP22).

## Troubleshooting

| Symptom                                                            | Cause and fix                                                                                                                                                                                                                                  |
| :----------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$'\r': command not found`                                         | The scripts were uploaded with Windows line ends. Upload again in **Binary** mode, or run `sed -i 's/\r$//' /home/root/staging/landing/deploy/*.sh /home/root/staging/landing/deploy/templates/* /home/root/staging/landing/deploy/*.example`. |
| `… already serves www.<DOMAIN>`                                    | The PWA still has that host: follow "Changing the public host" in `pwa/deploy/deploy.md`.                                                                                                                                                      |
| The health check fails on every page                               | nginx is down or the site isn't enabled: `systemctl status nginx`, `ls -l /etc/nginx/sites-enabled/`.                                                                                                                                          |
| 403 on every page                                                  | nginx can't read the release. Its workers must be in `LANDING_WEB_GROUP` (`www-data`). Check `namei -l /carpal/landing/current/index.html`.                                                                                                    |
| `www.<DOMAIN>` shows the nginx welcome page or a certificate error | DNS points here but the site isn't installed or has no certificate yet: finish [First deployment](#first-deployment).                                                                                                                          |
| A page loads without styles or the language stays wrong            | A new inline script or style was blocked by the Content-Security-Policy. Keep them in files under `assets/`.                                                                                                                                   |
| `carpals.ir` goes to the PWA                                       | The nginx site predates the landing site: step 5 of [First deployment](#first-deployment).                                                                                                                                                     |
