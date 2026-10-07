# Database

PostgreSQL schema and data (WP3, WP4; tables are owned per backend module). Shared by all backend services.

| Folder | Contents |
| :--- | :--- |
| `migrations/` | Versioned SQL migrations: tables, JSONB translation columns, GIN indexes, pgvector (if used for embeddings). |
| `seeds/` | Reference data: taxonomy (brands/models/series, service systems/tasks, parts, symptoms, review tags), plans and entitlements, demo data for dev and staging. |
| `policies/` | Row-Level Security policies for tenant isolation (vendor inventory, fleet data), roles and grants. |

Data model reference: `Docs/50`–`52`.
