# Database

PostgreSQL schema and data (WP3, WP4; tables are owned per backend module). Shared by all backend services.

The executable definition is **`Docs/43.db_setup.sql`** (explained in `Docs/42.db schema.md`): cluster roles, the `carpal` and `carpal_analytics` databases, one schema per module, row-level security, seeds (plans, entitlements, flags, retention policies, MCP clients, the taxonomy catalog from `Docs/44`). The backend tooling installs it; see `backend/README.md` → Database.

| Folder | Contents |
| :--- | :--- |
| `migrations/` | Numbered SQL migrations applied after the baseline (see `migrations/README.md`). |
| `seeds/` | Demo data for dev and staging (reference data is seeded by 43). |
| `policies/` | Unused for now: RLS policies live in 43 §21. |

Data model reference: `Docs/50`–`52`.
