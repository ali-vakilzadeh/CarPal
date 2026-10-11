// pnpm db:<command>
//   start   create (first time) and start the embedded cluster
//   stop    stop the embedded cluster
//   setup   start if needed, install the baseline if missing, apply pending migrations
//   reset   drop both CarPal databases, then setup (all local data is lost)
//   status  server, databases, baseline freshness, migrations
import { loadDbConfig } from './config.js';
import { dropDatabases, setup, status } from './install.js';
import { isRunning, startServer, stopServer } from './server.js';

const cfg = loadDbConfig();
const log = (m: string): void => console.log(m);
const command = process.argv[2] ?? 'status';

function ensureServer(): void {
  if (cfg.mode !== 'embedded') return;
  const r = startServer(cfg);
  log(
    r === 'started' ? `Embedded PostgreSQL started on ${cfg.host}:${cfg.port}` : `Embedded PostgreSQL running on ${cfg.host}:${cfg.port}`,
  );
}

async function main(): Promise<void> {
  switch (command) {
    case 'start':
      if (cfg.mode !== 'embedded') throw new Error('db:start manages the embedded cluster only (CARPAL_DB_MODE=external).');
      ensureServer();
      break;
    case 'stop':
      if (cfg.mode !== 'embedded') throw new Error('db:stop manages the embedded cluster only (CARPAL_DB_MODE=external).');
      log(stopServer(cfg) === 'stopped' ? 'Embedded PostgreSQL stopped.' : 'Embedded PostgreSQL was not running.');
      break;
    case 'setup':
      ensureServer();
      await setup(cfg, log);
      break;
    case 'reset':
      ensureServer();
      await dropDatabases(cfg, log);
      await setup(cfg, log);
      break;
    case 'status': {
      if (cfg.mode === 'embedded' && !isRunning(cfg)) {
        log('Embedded PostgreSQL is not running (pnpm db:start).');
        return;
      }
      const s = await status(cfg);
      log(`Server: ${cfg.host}:${cfg.port} (${cfg.mode}), env=${cfg.env}`);
      for (const [db, ok] of Object.entries(s.databases)) log(`Database ${db}: ${ok ? 'installed' : 'missing'}`);
      if (s.baseline) {
        log(`Baseline: ${s.baseline.upToDate ? 'up to date' : 'Docs/43.db_setup.sql changed since install -> pnpm db:reset'}`);
      }
      if (s.liteShims) log(`Lite shims: ${s.liteShims}`);
      log(
        `Migrations: ${s.migrations.applied.length} applied, ${s.migrations.pending.length} pending${s.migrations.pending.length ? ` (${s.migrations.pending.join(', ')})` : ''}`,
      );
      break;
    }
    default:
      throw new Error(`Unknown command "${command}". Use start | stop | setup | reset | status.`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
