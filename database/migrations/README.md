# Migrations

The **baseline** is `Docs/43.db_setup.sql`, installed as-is (it creates the cluster roles, both databases, every table, policy and seed). There is no generated copy of it here: `backend/tools/db` runs the script directly with a psql-compatible runner, and records its SHA-256 in `core.schema_info` (`baseline.sha256`).

Changes after a database is installed go in this folder as numbered files:

```
0100_add_vehicle_color_index.sql
0101_...
```

- Name: `NNNN_snake_case.sql`, applied in name order, once each (recorded as `migration:<file>` in `core.schema_info`).
- They run as `carpal_migrator` after `SET ROLE carpal_owner` (42 §10), inside the same psql-compatible runner, so `:'env'` and `\if` work.
- Update `Docs/43.db_setup.sql` and `Docs/42.db schema.md` with the same change, so a fresh install and a migrated install end up identical.
- Before the first shared environment exists, editing 43 and running `pnpm db:reset` is enough; `pnpm db:status` tells you when the installed baseline is older than 43.

Commands (from `backend/`): `pnpm db:setup` (install or migrate), `pnpm db:reset` (drop and reinstall, all local data lost), `pnpm db:status`.
