# Backend

Node.js + NestJS (TypeScript) **modular monolith** with event-driven workers. See `Docs/02.Detailed project plan.md` §1. Each module owns its own tables and talks to other modules only through public interfaces or domain events, so any module can be extracted into its own service later.

| Folder | Responsibility | WP |
| :--- | :--- | :--- |
| `api-gateway/` | Auth, rate limiting, routing, request validation, API versioning, audit logging, per-portal BFFs (consumer, provider, vendor, fleet, admin). | WP2, WP19, WP20 |
| `libs/` | Shared backend code: auth guards, tenancy context, `Accept-Language` / JSONB translation resolver, outbox + event bus client, logging. | WP1, WP2 |
| `modules/identity` | Signup/login, roles, permissions, sessions, MFA, consent, org membership, onboarding, data export/deletion. | WP2 |
| `modules/organization` | Organizations and locations, verification, provider profiles and capability portfolio, vendor profiles. | WP3, WP6, WP7 |
| `modules/billing` | Plans, entitlements, manual plan assignment, trials, payment placeholder. | WP3 |
| `modules/taxonomy` | Brands/models/series, service systems and tasks, parts, symptoms, review tags, mappings, synonyms. | WP4 |
| `modules/vehicle` | Vehicles, VIN, service records, documents, issues, maintenance reminders, OBDII placeholder. | WP5 |
| `modules/inventory` | Vendor inventory, fitment, CSV import, stock inquiries, price visibility, catalog quality. | WP7 |
| `modules/discovery` | Search queries, geo/semantic/contextual search, ranking, matching, match reasons. | WP8 |
| `modules/trust` | Reviews, sub-ratings, responses, review requests, disputes, trust signals, badges. | WP9 |
| `modules/appointment` | Appointment state machine, provider calendar, reminders, pre-visit reports. | WP10 |
| `modules/fleet` | Fleet vehicles, drivers, approvals, cost logging, fleet reports and export. | WP11 |
| `modules/community` | Follows, favorites, showcases, posts, Q&A, helpful reactions, Discover feed. | WP12 |
| `modules/media` | Uploads, thumbnails, EXIF stripping, malware scan, redaction, media consent. | WP13 |
| `modules/notification` | In-app, email, push, and SMS notifications, preferences, delivery tracking. | WP14 |
| `modules/admin` | Moderation queues, user/org admin, feature flags, AI kill switch. | WP15 |
| `modules/analytics` | Event collection, KPI and success-metric dashboards, audit log service. | WP16 |
| `workers/search-indexer` | Projects domain events into Elasticsearch. | WP8 |
| `workers/trust-scoring` | Trust score and badge recalculation pipeline. | WP9 |
| `workers/notification-dispatch` | Delivers notifications through each channel. | WP14 |
| `workers/analytics-pipeline` | Feeds events into the analytics store. | WP16 |
| `workers/import-jobs` | CSV inventory/fleet imports, exports, and other long-running jobs. | WP7, WP11 |
