// Controls the embedded PostgreSQL 16 cluster used in lite mode (GD-04). The
// binaries come from the embedded-postgres npm package; the server is started
// with pg_ctl so it keeps running after this process exits (tests, dev server
// and CLI commands all share it).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { DbConfig } from './config.js';

const require = createRequire(import.meta.url);

export interface PgBinaries {
  initdb: string;
  pgCtl: string;
  postgres: string;
}

export function pgBinaries(): PgBinaries {
  const platformPkg = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  // pnpm keeps the platform package next to embedded-postgres in the virtual store.
  // The package exports only dist/index.js, so walk up from it to the package folder.
  const mainDir = dirname(dirname(realpathSync(require.resolve('embedded-postgres'))));
  const binDir = join(mainDir, '..', ...platformPkg.split('/'), 'native', 'bin');
  const exe = process.platform === 'win32' ? '.exe' : '';
  const bins = {
    initdb: join(binDir, `initdb${exe}`),
    pgCtl: join(binDir, `pg_ctl${exe}`),
    postgres: join(binDir, `postgres${exe}`),
  };
  for (const path of Object.values(bins)) {
    if (!existsSync(path))
      throw new Error(`PostgreSQL binary not found: ${path}. Run pnpm install (and allow the ${platformPkg} build script).`);
  }
  return bins;
}

function run(cmd: string, args: string[], opts: { allowFail?: boolean } = {}): { status: number; out: string } {
  // stdio must not be piped for "pg_ctl start": the server would inherit the pipe
  // and keep this call waiting until it exits. Output goes to the log file instead.
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${out}`);
  return { status: r.status ?? -1, out };
}

export function isInitialised(cfg: DbConfig): boolean {
  return existsSync(join(cfg.pgDataDir, 'PG_VERSION'));
}

/** Creates the cluster (initdb) with a password-protected superuser and dev-friendly settings. */
export function initCluster(cfg: DbConfig): void {
  const bins = pgBinaries();
  mkdirSync(dirname(cfg.pgDataDir), { recursive: true });
  const pwFile = join(dirname(cfg.pgDataDir), '.pwfile');
  writeFileSync(pwFile, cfg.superuserPassword + '\n', { mode: 0o600 });
  try {
    run(bins.initdb, [
      '-D',
      cfg.pgDataDir,
      '-U',
      cfg.superuser,
      `--pwfile=${pwFile}`,
      '--auth=scram-sha-256',
      '--encoding=UTF8',
      '--locale=C',
      '--no-instructions',
    ]);
  } finally {
    rmSync(pwFile, { force: true });
  }
  // Development cluster: local only, UTC, and durability traded for speed (data
  // can be lost on a crash; rebuild with pnpm db:reset). Never use these in production.
  appendFileSync(
    join(cfg.pgDataDir, 'postgresql.conf'),
    [
      '',
      '# --- CarPal embedded development cluster ---',
      `listen_addresses = '127.0.0.1'`,
      `port = ${cfg.port}`,
      `timezone = 'UTC'`,
      `log_timezone = 'UTC'`,
      'max_connections = 200',
      'fsync = off',
      'synchronous_commit = off',
      'full_page_writes = off',
      `log_min_messages = warning`,
      '',
    ].join('\n'),
  );
}

export function isRunning(cfg: DbConfig): boolean {
  if (!isInitialised(cfg)) return false;
  return run(pgBinaries().pgCtl, ['status', '-D', cfg.pgDataDir], { allowFail: true }).status === 0;
}

export function startServer(cfg: DbConfig): 'started' | 'already-running' {
  if (!isInitialised(cfg)) initCluster(cfg);
  if (isRunning(cfg)) return 'already-running';
  const bins = pgBinaries();
  const r = spawnSync(bins.pgCtl, ['start', '-D', cfg.pgDataDir, '-l', cfg.pgLogFile, '-w', '-t', '60'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (r.status !== 0) {
    const tail = existsSync(cfg.pgLogFile) ? readFileSync(cfg.pgLogFile, 'utf8').split('\n').slice(-20).join('\n') : '';
    throw new Error(`pg_ctl start failed (${r.status}). Log tail:\n${tail}`);
  }
  return 'started';
}

export function stopServer(cfg: DbConfig): 'stopped' | 'not-running' {
  if (!isRunning(cfg)) return 'not-running';
  run(pgBinaries().pgCtl, ['stop', '-D', cfg.pgDataDir, '-m', 'fast', '-w']);
  return 'stopped';
}
