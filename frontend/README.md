# Frontend — Business Web Portals

WP20: React + Next.js (TypeScript) web apps for business users. Each folder is one portal area. They can ship as a single Next.js app with role-based routing or as separate apps.

| Folder | Users | Main sections |
| :--- | :--- | :--- |
| `provider-portal/` | Service providers | Dashboard, requests, calendar, profile, portfolio, reviews, AI insights, settings |
| `vendor-portal/` | Parts vendors | Dashboard, inventory, CSV import, fitment editor, inquiries, reviews, insights |
| `fleet-portal/` | Fleet owners, managers, viewers | Dashboard, vehicles, drivers, maintenance, approvals, appointments, reports/export |
| `admin-console/` | Internal staff | Users/orgs, taxonomy, moderation, AI oversight, MCP audit, plans, analytics, feature flags |

Public addresses (Docs/02 §1.4): `web.<DOMAIN>` is the web app. `fleet.<DOMAIN>` redirects to it with an option such as `?fleet`, which turns off everything except the fleet pages. The app keeps that option for the session. It only hides pages: the server still decides access by role. The admin pages aren't publicised, and how they're reached is decided after the web UI design.

All portals use the shared design system and UI dictionary (`shared/`). They are RTL-first for Persian (FA) and LTR for English (EN). Testing: Playwright E2E, visual regression, RTL layout, and a11y checks.
