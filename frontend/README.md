# Frontend — Business Web Portals

WP20: React + Next.js (TypeScript) web apps for business users: the public Web UI for service providers, parts sellers and fleet managers. Each portal folder is one portal area; the portals can ship as a single Next.js app with role-based routing or as separate apps. The admin console is not one of them: it is a separate staff app (owner decision DQ-03, see below).

| Folder | Users | Main sections |
| :--- | :--- | :--- |
| `provider-portal/` | Service providers | Dashboard, requests, calendar, profile, portfolio, reviews, AI insights, settings |
| `vendor-portal/` | Parts vendors | Dashboard, inventory, CSV import, fitment editor, inquiries, reviews, insights |
| `fleet-portal/` | Fleet owners, managers, viewers | Dashboard, vehicles, drivers, maintenance, approvals, appointments, reports/export |
| `admin-console/` | Internal staff | A separate app, not part of the business web app: monitors and controls the social network (moderation, review approvals, verification, privacy, settings, taxonomy, AI oversight, MCP audit, analytics, staff). Owner decision DQ-03 |

Public addresses (Docs/02 §1.4): `web.<DOMAIN>` is the web app. `fleet.<DOMAIN>` redirects to it with an option such as `?fleet`, which turns off everything except the fleet pages. The app keeps that option for the session. It only hides pages: the server still decides access by role. `admin.<DOMAIN>` serves the admin console only (`admin-console/`, its own BFF and staff sign-in with the `cp-web-admin` client). It isn't publicised, and how it's reached is decided after the web UI design.

**Admin console scope (DQ-03).** The console only monitors and controls the social network. Nothing of it appears in the portals, and work a business does for itself belongs to the portals. Assisted onboarding and plan assignment stay in the console; the portals get identical copies of those pages for the business. The portals' plan and proposals are in [public-ui-dev-plan.json](public-ui-dev-plan.json); the review of every console part is in `Docs/23.Admin_WebUI_screens.md` §0.

**Provider Web UI and Workshop PWA (development plan 2026-11-16).** Repair mechanics get two things. The provider Web UI is the full portal at `web.<DOMAIN>/<locale>/provider`. CarPal Workshop is a compact phone app for workshops without a computer; it is a route group of the consumer PWA (`pwa/`) at `pwa.<DOMAIN>/<locale>/provider`, not part of the business web app. The Workshop app covers a short onboarding, appointment requests, job updates and closing, replies to customers and before/after photos. Components used by both live in `shared/business-ui`. The plan is in [provider-dev-plan.json](provider-dev-plan.json) and the screen mockup is in [provider-portal/mockup.html](provider-portal/mockup.html).

**Vendor portal (proposal 2026-11-16).** Parts sellers get a desktop-first portal for the counter computer. There is no separate phone app; instead, the inquiry, approval and trade-request pages work on the phone inside the installable portal. It is built on the provider plan's foundation stage (PP1). The plan is in [vendor-dev-plan.json](vendor-dev-plan.json) and the screen mockup is in [vendor-portal/mockup.html](vendor-portal/mockup.html).

All portals use the shared design system and UI dictionary (`shared/`). They are RTL-first for Persian (FA) and LTR for English (EN). Testing: Playwright E2E, visual regression, RTL layout, and a11y checks.
