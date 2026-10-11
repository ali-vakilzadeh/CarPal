// pnpm db:codegen [--verify] — generates Kysely table types from the installed
// database into libs/db/generated/db.ts (GD-02). The output is committed, so code
// compiles without a database; regenerate after Docs/43 or a migration changes.
// Introspects as the superuser (catalog access only); tables keep their schema
// prefix ("vehicle.vehicles"), columns keep the 52 field names.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { backendDir, loadDbConfig } from './config.js';

const cfg = loadDbConfig();
// The package has no exports map; its CLI script is declared in package.json "bin".
const codegenBin = join(backendDir, 'node_modules', 'kysely-codegen', 'dist', 'cli', 'bin.js');
const outDir = join(backendDir, 'libs', 'db', 'generated');
mkdirSync(outDir, { recursive: true });
const url = (db: string): string =>
  `postgres://${encodeURIComponent(cfg.superuser)}:${encodeURIComponent(cfg.superuserPassword)}@${cfg.host}:${cfg.port}/${db}`;

// db.ts: the primary database (carpal); analytics-db.ts: carpal_analytics (events schema).
const targets = [
  { db: cfg.dbName, file: 'db.ts' },
  { db: cfg.analyticsDbName, file: 'analytics-db.ts' },
];
for (const t of targets) {
  const args = [
    codegenBin,
    '--dialect',
    'postgres',
    '--url',
    url(t.db),
    '--out-file',
    join(outDir, t.file),
    // Module schemas only: not the extension schema, and not partitions of the log tables.
    '--exclude-pattern',
    'ext.*',
    '--numeric-parser',
    'string', // numeric(12,2) money stays exact (40 Dec / Money are strings on the wire)
    '--date-parser',
    'string', // `date` columns are calendar dates (YYYY-MM-DD), not instants
    '--log-level',
    'warn',
    ...process.argv.slice(2).filter((a) => a === '--verify'),
  ];
  const r = spawnSync(process.execPath, args, { cwd: backendDir, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
