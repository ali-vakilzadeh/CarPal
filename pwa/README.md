# Consumer PWA (Web)

WP19: the Next.js Progressive Web App for car owners and fleet drivers on desktop and mobile browsers. It complements the native app in `mobile/`.

Planned contents (stages P1–P13 in [dev_plan.json](dev_plan.json)):

- **Public SEO pages (SSR):** provider and vendor profiles, showcases, parts, Q&A, directory pages.
- **Consumer web experience:** search and map, My Garage, Help Me, appointments, community, notifications, settings.
- **Consumer BFF** (server-held tokens, `__Host-cp_sid` session cookie) and the **hosted sign-in UI**, both in this package.
- **Driver issue reporting** for fleet drivers without the native app.
- PWA features: installable, web push, offline-tolerant shell, bundled EN/FA dictionary.

Status: **P1 (foundation)** — toolchain, generated contract types, design tokens, i18n skeleton, locale routing and a placeholder home page. See `dev_plan.json` → `stages[P1].report`.

## Quick start

The PWA uses the project-local Node 24 that `backend/` installs (the system Node stays 20.10).

```sh
cd pwa
source tools/use-local-node.sh        # PowerShell: . tools\use-local-node.ps1
pnpm install
pnpm dev                              # http://localhost:3000 → redirects to /fa (or /en)
```

`pnpm dev` and `pnpm build` first copy the design-system files to `public/ds/` (gitignored). From P2 on, most pages need the backend: run `pnpm dev` in `backend/` (lite mode, see [backend/README.md](../backend/README.md)) with the environment described in `dev_plan.json` GD-05 (sign-in URL, redirect URI, WebAuthn RP ID).

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
| `pnpm i18n:check`                           | every key in both `shared/i18n/locales/en.json` and `fa.json`, no empty values, same `{{placeholders}}`                                        |
| `pnpm format` / `format:check`              | Prettier (same style as `backend/`)                                                                                                            |

## Layout

```
pwa/
  src/app/[locale]/        localized pages; layout.tsx is the root layout (<html lang dir data-theme>)
  src/app/global-not-found.tsx   server-rendered 404 for unmatched URLs (own document)
  src/proxy.ts             locale redirects, theme cookie, x-carpal-locale header (Next.js 16 "proxy" = middleware)
  src/instrumentation.ts   validates the environment at startup
  src/server/              server-only code (env; the BFF arrives in P2 under src/server/bff/, framework-free)
  src/lib/                 client-safe helpers (locales, dictionary, theme, design-system paths)
  src/components/ds/       design-system components ported to typed React (P3 completes the set)
  src/components/shell/    app shell pieces
  tests/e2e/               Playwright specs
  tools/                   generators and checks (contract, design system, i18n, lint plugin, local Node)
../shared/api-contracts/   @carpal/api-contracts: generated TypeScript (+ backend-generated openapi.yaml)
../shared/i18n/            @carpal/i18n: the EN/FA UI dictionary
../shared/design-system/web/   synced copy of the design-system tokens, fonts and component CSS
```

## Conventions

- **API calls by operation id**, through the generated operation map (`OPERATIONS`, `OperationTypes` in `@carpal/api-contracts`); never hand-written paths or types.
- **Design system:** colours, spacing, radii, shadows and fonts only from the semantic tokens. Tailwind is for layout; its default scales are switched off in `src/app/globals.css`, so utilities can only name tokens (`bg-surface`, `p-4` = `--space-4`, `rounded-ds-md`, `shadow-ds-1`, `font-persian`). Components use the design system's own classes (`cp-btn`, `cp-chip` …).
- **RTL:** logical properties only (`ms-`, `pe-`, `start-`, `text-start` …); lint rejects left/right utilities and styles. Names, plates and numbers inside sentences go in `<bdi>`; user text gets `dir="auto"`.
- **Copy:** every string lives in `shared/i18n` under its area's namespace; EN/FA wording is taken from `mobile/preview/js/screens-*.js` where a screen mirrors a mobile one.
- **Next.js 16** differs from older versions (proxy instead of middleware, async request APIs, Turbopack by default). Read the bundled docs in `node_modules/next/dist/docs/` before using an API; `AGENTS.md` (written by `next dev`) says the same.

## Notes

- The linked `shared/` packages ship TypeScript sources; Next.js compiles them (`transpilePackages`) and Turbopack reaches them through an additional root (`next.config.ts`), so `backend/` is never watched.
- A `notFound()` thrown by a page is server-rendered by Next.js 16 as an empty shell with status 404 and drawn on the client by `[locale]/not-found.tsx`; unmatched URLs get the fully server-rendered `global-not-found.tsx`. See the P1 report.
