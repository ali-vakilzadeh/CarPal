// Startup checks against the lite-only shortcuts (backend S26c.T1, NI-18). Each check fails with the name of the
// setting to fix. They run from the deployables' main files (apps/*/main.ts) and from the deploy preflight
// (tools/preflight.ts, 2-build.sh), never from shared code, so the operator tools (staff-bootstrap, break glass,
// consent-text seed, mail test) keep running next to a live backend.
//   (a) PostgreSQL durability: fsync, synchronous_commit and full_page_writes on outside dev (the embedded
//       development cluster turns them off for speed).
//   (c) Raw uploads at rest: plaintext files under uploads/ are encrypted once (the lite storage listener encrypts
//       new ones); none may remain afterwards.
//   (d) One lite process per data folder outside dev: the lite KV store, event bus and job queue live in one
//       process, so a second process against the same data is refused (a lock file with the owner's pid).
// (b) the https media origin and (e) the development secrets are checked by loadConfig (libs/config).
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { CarpalConfig } from '#libs/config/index.js';
import { LocalObjectStorage, type ObjectStorage } from '#libs/infra/index.js';
import type { Logger } from '#libs/observability/index.js';

/** A failed startup check; the message names the setting. */
export class StartupCheckError extends Error {
  constructor(
    readonly setting: string,
    message: string,
  ) {
    super(`${setting}: ${message}`);
    this.name = 'StartupCheckError';
  }
}

// ------------------------------------------------------------------ (a) database durability

/** PostgreSQL settings that must keep their durable values outside dev, and the values accepted. */
export const DURABILITY_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  fsync: ['on'],
  synchronous_commit: ['on', 'local', 'remote_write', 'remote_apply'],
  full_page_writes: ['on'],
};

/** Reads one server setting (SHOW). */
export type SettingReader = (name: string) => Promise<string>;

/** Throws StartupCheckError naming the first PostgreSQL setting that is not durable. Outside dev only. */
export async function checkDatabaseDurability(config: CarpalConfig, read?: SettingReader): Promise<void> {
  if (config.env === 'dev') return;
  if (read) return assertDurable(read);
  const client = new pg.Client({
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: 'carpal_worker',
    password: config.db.passwords.carpal_worker,
    application_name: 'carpal-startup-check',
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    await assertDurable(async (name) => {
      const r = await client.query<Record<string, string>>(`SHOW ${name}`);
      return String(Object.values(r.rows[0] ?? {})[0] ?? '');
    });
  } finally {
    await client.end();
  }
}

async function assertDurable(read: SettingReader): Promise<void> {
  for (const [name, ok] of Object.entries(DURABILITY_SETTINGS)) {
    const value = (await read(name)).trim().toLowerCase();
    if (!ok.includes(value))
      throw new StartupCheckError(
        `PostgreSQL ${name}`,
        `is ${value || 'unknown'}; staging and prod need ${ok[0]} (the embedded development cluster turns it off; NI-18)`,
      );
  }
}

// ------------------------------------------------------------------ (d) one lite process

export const LOCK_FILE = 'backend.lock';

/** What the lock needs to know about processes; injectable for tests. */
export interface ProcessProbe {
  /** This boot's id (Linux /proc/sys/kernel/random/boot_id), or null where there is none. */
  bootId(): string | null;
  /** Whether a process with this pid exists (EPERM: it exists but belongs to another user). */
  exists(pid: number): boolean;
  /** The process's command line (Linux /proc/<pid>/cmdline, NUL-separated), or null where it cannot be read. */
  cmdline(pid: number): string | null;
}

const readOrNull = (path: string): string | null => {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
};

export const systemProbe: ProcessProbe = {
  bootId: () => readOrNull('/proc/sys/kernel/random/boot_id')?.trim() || null,
  exists: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  cmdline: (pid) => readOrNull(`/proc/${pid}/cmdline`),
};

/** The lock's content: pid, boot id, entry script, time. */
interface LockOwner {
  pid: number;
  bootId: string;
  script: string;
}

const entryScript = (): string => process.argv[1] ?? '';

function readOwner(path: string): LockOwner | null {
  const raw = readOrNull(path);
  if (raw === null) return null;
  const [pid = '', bootId = '', script = ''] = raw.split('\n');
  return { pid: Number.parseInt(pid, 10), bootId, script };
}

/**
 * Whether the recorded owner still runs. Stale when: the server rebooted since (another boot id), the pid is gone, or
 * (Linux) the pid now belongs to another program, such as the PWA's or the console's node process after a reboot
 * reused it (its command line does not name the recorded entry script).
 */
export function ownerRuns(owner: LockOwner, probe: ProcessProbe = systemProbe): boolean {
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  const boot = probe.bootId();
  if (boot && owner.bootId && boot !== owner.bootId) return false;
  if (!probe.exists(owner.pid)) return false;
  const cmdline = probe.cmdline(owner.pid);
  if (cmdline === null) return true; // no /proc (Windows, macOS): existence is all we know
  // The command line may name the script relative to the working directory: compare its last three segments
  // (dist/apps/dev/main.js -> apps/dev/main.js).
  const tail = owner.script.split(/[\\/]/).filter(Boolean).slice(-3).join('/');
  return tail ? cmdline.replaceAll('\\', '/').includes(tail) : cmdline.includes('node');
}

/**
 * Takes the lite data folder's process lock (exclusive create; the owner's pid, boot id and entry script inside); a
 * lock left by a process that is gone (a crash, a reboot) is taken over. Returns the release function (also run on exit).
 */
export function acquireProcessLock(dir: string, probe: ProcessProbe = systemProbe): () => void {
  const path = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const owner = readOwner(path);
      if (owner && owner.pid !== process.pid && ownerRuns(owner, probe))
        throw new StartupCheckError(
          'CARPAL_INFRA=lite',
          `another backend process (pid ${owner.pid}) uses ${dir} (${path}); the lite KV store, event bus and queue are per process, so run one backend process (deploy.md)`,
        );
      rmSync(path, { force: true });
      continue;
    }
    writeSync(fd, `${process.pid}\n${probe.bootId() ?? ''}\n${entryScript()}\n${new Date().toISOString()}\n`);
    closeSync(fd);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      try {
        if (readFileSync(path, 'utf8').split('\n')[0] === String(process.pid)) rmSync(path, { force: true });
      } catch {
        // already gone
      }
    };
    process.once('exit', release);
    return release;
  }
  throw new StartupCheckError('CARPAL_INFRA=lite', `could not take ${path}`);
}

// ------------------------------------------------------------------ (c) raw uploads at rest

/** The prefix of raw uploads (media keys.upload) that W6 reads and deletes. */
export const RAW_UPLOAD_PREFIX = 'uploads';

/** Encrypts plaintext raw uploads once, then refuses to go on if any is left (lite storage only). */
export async function encryptRawUploads(storage: ObjectStorage, logger?: Logger): Promise<void> {
  if (!(storage instanceof LocalObjectStorage)) return;
  const r = await storage.encryptPlaintext(RAW_UPLOAD_PREFIX);
  if (r.encrypted || r.repaired || r.unreadable)
    logger?.warn({ ...r, prefix: RAW_UPLOAD_PREFIX }, 'raw uploads encrypted at rest (one-time migration, NI-18)');
  const left = storage.plaintextKeys(RAW_UPLOAD_PREFIX);
  if (left.length)
    throw new StartupCheckError('raw uploads', `${left.length} plaintext file(s) left under ${RAW_UPLOAD_PREFIX}/ (first: ${left[0]})`);
}

// ------------------------------------------------------------------ all of them

export interface StartupCheckOptions {
  /** The lite data folder (null: in-memory or full mode, no lock). */
  dataDir: string | null;
  /** The process's storage, when it is built already (apps/dev); the raw-upload migration needs it. */
  storage?: ObjectStorage;
  logger?: Logger;
  /** Tests: reads PostgreSQL settings without a connection. */
  readSetting?: SettingReader;
}

/**
 * Runs the startup checks of a deployable. Returns the lock's release function (or a no-op). Throws
 * StartupCheckError naming the setting.
 */
export async function runStartupChecks(config: CarpalConfig, o: StartupCheckOptions): Promise<() => void> {
  const release = config.infra === 'lite' && config.env !== 'dev' && o.dataDir ? acquireProcessLock(o.dataDir) : () => {};
  try {
    await checkDatabaseDurability(config, o.readSetting);
    if (o.storage) await encryptRawUploads(o.storage, o.logger);
  } catch (err) {
    release();
    throw err;
  }
  return release;
}
