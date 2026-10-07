# Frontend — Business Web Portals

WP20: React + Next.js (TypeScript) web apps for business users. Each folder is one portal area. They can ship as a single Next.js app with role-based routing or as separate apps.

| Folder | Users | Main sections |
| :--- | :--- | :--- |
| `provider-portal/` | Service providers | Dashboard, requests, calendar, profile, portfolio, reviews, AI insights, settings |
| `vendor-portal/` | Parts vendors | Dashboard, inventory, CSV import, fitment editor, inquiries, reviews, insights |
| `fleet-portal/` | Fleet owners, managers, viewers | Dashboard, vehicles, drivers, maintenance, approvals, appointments, reports/export |
| `admin-console/` | Internal staff | Users/orgs, taxonomy, moderation, AI oversight, MCP audit, plans, analytics, feature flags |

All portals use the shared design system and UI dictionary (`shared/`). They are RTL-first for Persian (FA) and LTR for English (EN). Testing: Playwright E2E, visual regression, RTL layout, and a11y checks.
