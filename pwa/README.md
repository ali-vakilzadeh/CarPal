# Consumer PWA (Web)

WP19: the Next.js Progressive Web App for car owners and fleet drivers on desktop and mobile browsers. It complements the native app in `mobile/`.

Planned contents (stages P1–P13 in [dev_plan.json](dev_plan.json)):

- **Public SEO pages (SSR):** provider and vendor profiles, showcases, parts, Q&A, directory pages.
- **Consumer web experience:** search and map, My Garage, Help Me, appointments, community, notifications, settings.
- **Consumer BFF** (server-held tokens, `__Host-cp_sid` session cookie) and the **hosted sign-in UI**, both in this package.
- **Driver issue reporting** for fleet drivers without the native app.
- PWA features: installable, web push, offline-tolerant shell, bundled EN/FA dictionary.

Status: **P12 (PWA capabilities: install, offline, web push; fleet driver reporting)** done on top of P1–P10 (P11, reviews, is not started yet). Contract types are at 1.1.0. See `dev_plan.json` → `stages[…].report`.

## Quick start

The PWA uses the project-local Node 24 that `backend/` installs (the system Node stays 20.10).

```sh
cd pwa
source tools/use-local-node.sh        # PowerShell: . tools\use-local-node.ps1
pnpm install
pnpm dev                              # http://localhost:3000 → redirects to /fa (or /en)
```

`pnpm dev` and `pnpm build` first copy the design-system files to `public/ds/` (gitignored). From P2 on, most pages need the backend: run `pnpm dev` in `backend/` (lite mode, see [backend/README.md](../backend/README.md)) with this environment (shell variables or `backend/.env`; see also `backend/.env.example`):

```sh
CARPAL_OAUTH_REDIRECT_URIS='{"cp-mobile":["https://carpal.app/oauth/callback"],"cp-web-consumer":["https://localhost:3000/bff/oauth/callback","https://localhost:3100/bff/oauth/callback"],"cp-web-portal":["https://portal.carpal.app/bff/oauth/callback"],"cp-web-admin":["https://admin.carpal.app/bff/oauth/callback"]}'
CARPAL_WEBAUTHN_RP_ID=localhost
CARPAL_WEBAUTHN_ORIGINS='["https://localhost:3000"]'
CARPAL_RATE_LIMIT_SCALE=100        # test runs only: the BFF calls /oauth/token from one IP (DI-25)
```

Browser uploads (P7) PUT to the backend's storage listener (:8083) and read private PDFs from it for the in-place preview, so it must allow the PWA's origin (CORS, DI-08): `CARPAL_MEDIA_CORS_ORIGINS` defaults in dev to `http://localhost:3000`, `https://localhost:3000` and `http://localhost:3100`; set it for any other origin (staging and prod have no default).

Leave `CARPAL_SIGNIN_URL` unset: its default (`<issuer>/signin`) is what the PWA's `/id` proxy rewrites to the PWA's own origin, so the hosted sign-in works on :3000 and on the E2E port :3100 alike. An explicit `https://localhost:3000/id/signin` breaks the browser sign-in in `pnpm e2e` (P5).

### Sign-in in development

The contract's `Url` type is https-only, so the auth server accepts only an `https://` redirect URI (DI-24). Local https is not set up (OQ-10: tested on the test server instead). For a browser sign-in on `http://localhost`, the PWA registers the https URL and its `/id` proxy brings the code back to the http callback, so the browser never needs TLS:

```sh
# pwa/.env.local (dev only; env.ts refuses it in prod)
CARPAL_PWA_OAUTH_REDIRECT_URI=https://localhost:3000/bff/oauth/callback
```

`pnpm e2e` does the same on port 3100 (`playwright.config.ts`), which is why the backend env above lists both URIs. `pnpm test:int` calls the BFF handlers directly with the https origin, so it needs neither. One-time codes and email links of the lite backend are in `backend/.data/outbox-mail.jsonl` (`identity.otp_code`, `identity.email_verification`, `identity.password_reset`); the E2E helpers in `tests/e2e/accounts.ts` read them.

Pages of the sign-in flow: `/<locale>/login` and `/<locale>/signup` start it, the hosted sign-in is `/id/signin` (own layout, language from `ui_locales`), email links land on `/l/ev#…` and `/l/pr#…`, and every sign-in returns through `/<locale>/onboarding?next=…` (W-ONB-01; finished accounts go straight on).

Environment variables are listed in [.env.example](.env.example) (copy to `.env.local`); they are validated at startup by `src/server/env.ts`.

## Scripts

| Script                                      | What it does                                                                                                                                   |
| :------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev` / `pnpm build` / `pnpm start`    | Next.js dev server, production build, production server (port 3000)                                                                            |
| `pnpm check`                                | lint + typecheck + test + contract:check + i18n:check + ds:check                                                                               |
| `pnpm lint`                                 | ESLint (incl. the logical-property and token-only rules of `tools/eslint/carpal-plugin.js`) and `tools/check-logical-css.mjs` for `.css` files |
| `pnpm typecheck`                            | `next typegen` + `tsc --noEmit`                                                                                                                |
| `pnpm test`                                 | Vitest: `unit` (node) and `dom` (jsdom + Testing Library) projects                                                                             |
| `pnpm test:int`                             | Vitest `integration` project against the live backend (from P2)                                                                                |
| `pnpm e2e`                                  | builds, then runs Playwright (Chromium only) with axe on every visited page; `pnpm e2e:install` downloads Chromium once                        |
| `pnpm contract:generate` / `contract:check` | writes / checks `shared/api-contracts/generated/` from `backend/libs/contract/generated/`                                                      |
| `pnpm ds:sync` / `ds:check`                 | copies / checks `Docs/carpal-design-system/` → `shared/design-system/web/`                                                                     |
| `pnpm sw:build` / `sw:check`                | bundles / checks the service worker (`src/sw/` → the committed `src/sw/generated/bundle.ts`, served at `/sw.js`; part of `pnpm check`)         |
| `pnpm icons:build`                          | draws the app icons from the type-set logo with Playwright's Chromium into `public/icons/` (committed; `CARPAL_E2E_CHROMIUM` names a binary)   |
| `pnpm i18n:check`                           | every key in both `shared/i18n/locales/en.json` and `fa.json`, no empty values, same `{{placeholders}}`                                        |
| `pnpm format` / `format:check`              | Prettier (same style as `backend/`)                                                                                                            |

## Layout

```
pwa/
  src/app/[locale]/        localized pages; layout.tsx is the root layout (<html lang dir data-theme>, theme boot script,
                           client providers: translations, config.client, session, theme, toasts, consent, auth intent)
  src/app/[locale]/(shell)/  pages inside the app shell (header, navigation, right rail @rail slot):
                           (public)/ guest-readable pages, (app)/ signed-in tools behind the session gate
  src/app/[locale]/(flow)/onboarding/  W-ONB-01 web onboarding (full screen, no shell); [locale]/login, signup start the sign-in
  src/app/[locale]/system/[kind]/  W-SYS-01 pages reached only through the proxy's status rewrite (410, 503 …)
  src/app/[locale]/{not-found,forbidden,error}.tsx   404 / 403 / error-with-Retry boundaries
  src/app/global-not-found.tsx   server-rendered 404 for unmatched URLs (own document)
  src/proxy.ts             security headers (CSP nonce …), locale redirects, theme cookie, x-carpal-locale header (Next.js 16 "proxy" = middleware)
  src/instrumentation.ts   validates the environment at startup
  src/app/root-document.tsx  the <html> document shared by the [locale], /id and /l root layouts
  src/app/id/signin/       W-AUTH-01 hosted sign-in page (root layout src/app/id/layout.tsx)
  src/app/l/[type]/        link-token pages: /l/ev (email verification), /l/pr (password reset)
  src/app/api/v1/, src/app/bff/, src/app/id/{oauth,v1,.well-known}/   route adapters → the BFF
  src/server/bff/          consumer BFF, framework-free (Request/Response only, GD-03): session store (lite/redis),
                           OAuth client, /api/v1 forwarder + allowlist, CSRF, /id auth-host proxy, token providers
  src/server/bff-runtime.ts  the process-wide BFF built from the environment
  src/server/ssr/api.ts    typed client for server components (cp-ssr token, anonymous fallback)
  src/server/ssr/public-reads.ts  cached public reads for the SEO pages (60 s, 404/410 as results); profiles.ts, vendors.ts,
                           page-context.ts = page data, translator + formatter with the browser's time zone and prices
  src/server/ssr/seo/      page metadata (canonical, hreflang, Open Graph, robots), JSON-LD serializer + schema builders, sitemaps
  src/app/[locale]/(shell)/(public)/{search,search/[session],map}  W-SRCH-01 and W-MAP-01 (P6; no rail: @rail/{search,map});
  src/app/[locale]/(shell)/(public)/[city]/[facet]/[[...rest]]  W-PUB-04 directory pages (P6; map in @rail/[city]/…)
  src/app/[locale]/(shell)/(public)/{page,shop,parts-seller,parts,post,how-ranking-works}  W-PUB-01/02/03/08/05 (P5);
                           their right-rail boxes in (shell)/@rail/…; src/app/robots.ts, sitemap.xml/, sitemaps/[file]/
  src/server/security-headers.ts  CSP (nonce, Trusted Types) and the other page headers, applied by src/proxy.ts
  src/server/config.ts, taxonomy.ts, i18n.ts, session.ts   cached config.client, taxonomy snapshots, CDN-refreshed
                           dictionaries and the session view for server rendering
  src/server/system-status.ts  maintenance mode and status rewrites to the system pages
  src/server/              other server-only code (env, request locale)
  src/lib/api/             typed API client (operation ids, retries, Idempotency-Key, ETags), TanStack Query helpers, useSession
  src/lib/i18n/            i18next runtime (core, bundled dictionary, <I18nProvider>/useT), locales
  src/lib/format/          numbers/digits, Jalali/Gregorian dates, relative time, money (USD base, per-browser conversion), distance, <Bidi>
  src/lib/config/          config.client and taxonomy in the browser (useFlag, useRegion, useTaxonomyNodes)
  src/lib/analytics/       consent cookie, typed CLIENT_EVENTS copy, the events.ingest queue
  src/lib/                 other client-safe helpers (theme, design-system paths, system page kinds)
  src/components/ds/       design-system components ported to typed React (+ proposed additions, additions.css)
  src/components/shell/    app shell (header, navigation, rail, footer) and global patterns (toast, URL modal, dialog,
                           auth-intent modal, hover card, infinite list, skeletons, states, error boundary, cookie banner)
  src/components/vehicle/  vehicle picker (brand → model → series)
  src/components/media/    media boxes (fixed aspect ratio, lazy, placeholder while media are private)
  src/features/auth/       hosted sign-in steps (sign in, sign up, codes, MFA, passkeys, reset, lock) and link pages
  src/features/onboarding/ W-ONB-01 stepper (role, first car with VIN suggestions and transfers, problem draft, permissions)
  src/features/settings/   settings sections built so far (P4: per-browser price display, OQ-11)
  src/features/profiles/   public profile, part and showcase components and view models (P5)
  src/features/landing/    landing hero, city choice, showcase teasers (P5)
  src/features/search/     search request model and URL rules, browser memory (recent searches, stored requests), result
                           cards, filter panel, chips, location chip + consent, W-SRCH-01 screen and map pane (P6)
  src/features/map/        map geometry and places, lazy MapLibre canvas with the built-in style, W-MAP-01, the Directions
                           menu (S-SHARED-10) (P6)
  src/features/directory/  W-PUB-04 view model (paths, index rule, intro counts), request buttons, rail map (P6)
  src/features/media/      upload kit (client rules, upload state machine, uploads store, drop zone, private-file preview) (P7)
  src/features/garage/     W-GAR-01/02/03 view models and screens, plan-limit panel, ownership transfers, AI cards (P7)
  src/features/pwa/        PWA runtime (worker registration, update bar, user-scoped caches, sign-out steps, offline bar), install
                           prompt, web push (offer, settings switch, push-off line), offline page, manifest (P12)
  src/features/fleet-driver/  DRV-WEB driver views: assigned vehicles, issue report with photos/odometer/offline queue, /l/mi (P12)
  src/sw/                  the service worker (hand-written): routes.ts caching rules, push.ts, protocol.ts shared with pages,
                           generated/bundle.ts (pnpm sw:build); served by src/app/sw.js/route.ts
  src/app/manifests/[file]/  /manifests/<locale>.webmanifest; src/app/[locale]/offline = W-SYS-01 offline page
  src/app/[locale]/(shell)/(app)/drive/  /<locale>/drive[/<org>/<vehicle>[/report]] (P12)
  public/icons/            app icons (pnpm icons:build)
  src/features/dev-kit/    demo page of the P3 patterns (/<locale>/dev-kit, CARPAL_PWA_DEMO=1 only)
  tests/e2e/               Playwright specs; accounts.ts = outbox reader and user factory; businesses.ts = published
                           providers/vendors seeded through the API as business users (P5)
  tools/                   generators and checks (contract, design system, i18n, lint plugin, local Node)
../shared/api-contracts/   @carpal/api-contracts: generated TypeScript (+ backend-generated openapi.yaml)
../shared/i18n/            @carpal/i18n: the EN/FA UI dictionary
../shared/design-system/web/   synced copy of the design-system tokens, fonts and component CSS
```

## Conventions

- **API calls by operation id**, through the generated operation map (`OPERATIONS`, `OperationTypes` in `@carpal/api-contracts`); never hand-written paths or types. Client components: `useApiQuery('vehicles.list', { query })`, `useApiMutation('vehicles.create')` inside `<ApiProvider>`; server components: `ssrApi(locale).api('public.profile_get', { path })`. The client adds `Idempotency-Key`, `If-Match`, CSRF and the SEC-RL-4 retry rules; errors are `ApiProblem` (code, field errors, `retryAfterMs`, `stepUp`, `safety` …).
- **Browser never holds tokens:** it has only the `__Host-cp_sid` cookie. Sign-in is a navigation to `/bff/login?return_to=…` (`loginUrl()`; it returns through the onboarding check), step-up adds `step_up=aal2`; a gated action is saved first with `saveIntent()` (its `label` is the hosted sign-in's context line) and replayed with `consumeIntent()` (GD-06). Every api-host call waits for the page's first `/bff/csrf`, so one page never creates two pre-sessions.
- **Design system:** colours, spacing, radii, shadows and fonts only from the semantic tokens. Tailwind is for layout; its default scales are switched off in `src/app/globals.css`, so utilities can only name tokens (`bg-surface`, `p-4` = `--space-4`, `rounded-ds-md`, `shadow-ds-1`, `font-persian`). Components use the design system's own classes (`cp-btn`, `cp-chip` …).
- **RTL:** logical properties only (`ms-`, `pe-`, `start-`, `text-start` …); lint rejects left/right utilities and styles. Names, plates and numbers inside sentences go in `<bdi>`; user text gets `dir="auto"`.
- **Copy:** every string lives in `shared/i18n` under its area's namespace; EN/FA wording is taken from `mobile/preview/js/screens-*.js` where a screen mirrors a mobile one.
- **Next.js 16** differs from older versions (proxy instead of middleware, async request APIs, Turbopack by default). Read the bundled docs in `node_modules/next/dist/docs/` before using an API; `AGENTS.md` (written by `next dev`) says the same.

## Notes

- The linked `shared/` packages ship TypeScript sources; Next.js compiles them (`transpilePackages`) and Turbopack reaches them through an additional root (`next.config.ts`), so `backend/` is never watched.
- A `notFound()` thrown by a page is server-rendered by Next.js 16 as an empty shell with status 404 and drawn on the client by `[locale]/not-found.tsx`; unmatched URLs get the fully server-rendered `global-not-found.tsx`. See the P1 report. `forbidden()` (403) works the same way (`experimental.authInterrupts`). Statuses a page cannot produce (410, 503) come from the proxy: `systemRewrite()` in `src/server/system-status.ts` (P3 report).
- **Strings in client components:** `useT()` from `@/lib/i18n/client`; the root layout passes the namespaces in `CLIENT_NAMESPACES`, a feature area adds its own with `<I18nNamespaces>`. Server components: `const { t } = await serverI18n(locale)`. Counts use `{{count, number}}` (Persian digits in fa).
- **PWA (P12):** the service worker registers only in production builds (`pnpm build && pnpm start`, and `pnpm e2e`), never under `next dev`. It caches build files, the cookie-free offline pages and public pages, and — per signed-in user, wiped at logout or when another user signs in — the garage, appointments and driver pages and their API reads; no other BFF response is ever stored. Change anything in `src/sw/` → run `pnpm sw:build`. Web push needs `CARPAL_PWA_VAPID_PUBLIC_KEY` (the sender's public key); without it no push control is shown. E2E: `CARPAL_E2E_CHROMIUM=/path/to/chrome pnpm e2e` runs with a preinstalled Chromium.
- **Local switches:** `CARPAL_PWA_DEMO=1` enables `/<locale>/dev-kit` (pattern demo, gated Follow, `/dev-kit/status/<kind>`); `CARPAL_PWA_MAINTENANCE=on|<ISO time>` turns on maintenance mode; `CARPAL_PWA_OAUTH_REDIRECT_URI` is the dev sign-in shim above.
- **Deployment settings (P4):** `CARPAL_PWA_DEFAULT_TIME_ZONE` (dates until the browser reports its zone, OQ-13), `CARPAL_PWA_TERMS_VERSION` / `CARPAL_PWA_PRIVACY_VERSION` (accepted at sign-up, named in consent records; the region config has no field yet, DI-30) and `CARPAL_PWA_PORTAL_SIGNUP_URL` (business choices in onboarding).
- **Public pages (P5):** server components read through `publicRead()` / `publicList()` (`src/server/ssr/public-reads.ts`), build metadata with `pageMetadata()` and structured data with `<JsonLd>` (the only inline markup besides the theme boot script). Never import a value (constant, helper) from a `'use client'` module into a server component: it arrives as a client reference, not the value — keep shared constants in plain modules. Sitemaps: `/sitemap.xml` (index) and `/sitemaps/<kind>.xml`, built from public reads and cached 6 h.
- **Garage and uploads (P7):** `src/features/media` is the upload kit — `<UploadZone group purpose>` (drop, paste, pick; client checks per purpose, HEIC → JPEG where the browser can decode it, signed PUT, scan polling), `whenReady(id)` to attach a finished upload, `releaseGroup` / `discardGroup`, and `<DocumentPreview>` / `<DownloadButton>` for private files through signed URLs (the garage pages allow `frame-src blob:` for the PDF preview). Forms use `SelectField` and the calendar-aware `DateField` (Jalali selects in fa, ISO dates out) from `src/components/fields`. Garage routes: `/<locale>/garage[/<vehicle-id>/<overview|history|issues|documents|reminders|edit|print>]`, `/<locale>/garage/add`, `/<locale>/garage/<id>/records/new` and `/records/<record-id>/edit`; drawers and dialogs live in `?modal=`.
- **Prices** are based in USD; each browser may convert them to toman or rial at its own rate (Settings → On this device, `cp_price` cookie, OQ-11). Use `useFormat().money(amount, currency)` so every price follows that choice.
