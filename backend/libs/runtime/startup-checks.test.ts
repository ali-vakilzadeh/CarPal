// S26c.T1 (NI-18): the startup checks against the lite-only shortcuts; each failure names its setting.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '#libs/config/index.js';
import { LocalObjectStorage } from '#libs/infra/index.js';
import {
  acquireProcessLock,
  checkDatabaseDurability,
  encryptRawUploads,
  LOCK_FILE,
  ownerRuns,
  runStartupChecks,
  StartupCheckError,
  type ProcessProbe,
  type SettingReader,
} from './startup-checks.js';

const STAGING = {
  CARPAL_ENV: 'staging',
  CARPAL_MASTER_SECRET: 'x'.repeat(40),
  CARPAL_MEDIA_BASE_URL: 'https://media.carpals.ir',
  ...Object.fromEntries(
    ['API', 'ADMIN_API', 'AUTH', 'WORKER', 'ANALYTICS_WRITER', 'ANALYTICS_READER', 'AI'].map((k) => [`CARPAL_DB_PASSWORD_${k}`, `pw-${k}`]),
  ),
};
const staging = loadConfig(STAGING);
const dev = loadConfig({ CARPAL_ENV: 'dev' });
const durable: Record<string, string> = { fsync: 'on', synchronous_commit: 'on', full_page_writes: 'on' };
const reader =
  (over: Record<string, string> = {}): SettingReader =>
  (name) =>
    Promise.resolve({ ...durable, ...over }[name] ?? '');

const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'carpal-startup-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('(a) PostgreSQL durability', () => {
  it('names the first relaxed setting outside dev, and is skipped in dev', async () => {
    await expect(checkDatabaseDurability(staging, reader())).resolves.toBeUndefined();
    await expect(checkDatabaseDurability(staging, reader({ synchronous_commit: 'local' }))).resolves.toBeUndefined();
    await expect(checkDatabaseDurability(staging, reader({ fsync: 'off' }))).rejects.toThrow(/^PostgreSQL fsync: is off/);
    await expect(checkDatabaseDurability(staging, reader({ synchronous_commit: 'off' }))).rejects.toThrow(/PostgreSQL synchronous_commit/);
    await expect(checkDatabaseDurability(staging, reader({ full_page_writes: 'off' }))).rejects.toThrow(/PostgreSQL full_page_writes/);
    await expect(checkDatabaseDurability(dev, reader({ fsync: 'off' }))).resolves.toBeUndefined();
  });
});

describe('(d) one lite process per data folder', () => {
  it('refuses a second live process, takes over a stale lock, and releases its own', () => {
    const dir = tempDir();
    const lock = join(dir, LOCK_FILE);
    // Another live process (the test runner's parent) holds the folder.
    writeFileSync(lock, `${process.ppid}\n`);
    expect(() => acquireProcessLock(dir)).toThrow(StartupCheckError);
    expect(() => acquireProcessLock(dir)).toThrow(/^CARPAL_INFRA=lite: another backend process/);
    // A lock left by a process that is gone (crash, restart) is taken over.
    writeFileSync(lock, '2147483646\n');
    const release = acquireProcessLock(dir);
    expect(readFileSync(lock, 'utf8').split('\n')[0]).toBe(String(process.pid));
    release();
    expect(existsSync(lock)).toBe(false);
  });

  it('treats a lock as stale after a reboot or when its pid now runs another program (a reused pid)', () => {
    const owner = { pid: 4242, bootId: 'boot-a', script: '/carpal/backend/src/backend/dist/apps/dev/main.js' };
    const probe = (o: { boot?: string | null; exists?: boolean; cmdline?: string | null }): ProcessProbe => ({
      bootId: () => (o.boot === undefined ? 'boot-a' : o.boot),
      exists: () => o.exists ?? true,
      cmdline: () => (o.cmdline === undefined ? null : o.cmdline),
    });
    // The backend still runs (systemd names the script relative to its working directory).
    expect(ownerRuns(owner, probe({ cmdline: '/opt/node/bin/node\0--enable-source-maps\0dist/apps/dev/main.js\0' }))).toBe(true);
    // No /proc (Windows, macOS): existence is all there is.
    expect(ownerRuns(owner, probe({}))).toBe(true);
    // Rebooted since the lock was written.
    expect(ownerRuns(owner, probe({ boot: 'boot-b', cmdline: 'node\0dist/apps/dev/main.js\0' }))).toBe(false);
    // The pid is gone.
    expect(ownerRuns(owner, probe({ exists: false }))).toBe(false);
    // The pid now belongs to the PWA's (or the console's) node process.
    expect(ownerRuns(owner, probe({ cmdline: '/opt/node/bin/node\0/carpal/pwa/server.js\0' }))).toBe(false);
    expect(ownerRuns(owner, probe({ cmdline: 'node\0node_modules/.bin/next\0start\0' }))).toBe(false);
    // A lock written with a fake live owner is taken over when the probe says it is another program.
    const dir = tempDir();
    writeFileSync(join(dir, LOCK_FILE), `${process.ppid}\nboot-a\n${owner.script}\n`);
    const release = acquireProcessLock(dir, probe({ cmdline: 'node\0/carpal/pwa/server.js\0' }));
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8').split('\n')[0]).toBe(String(process.pid));
    release();
  });

  it('is taken by runStartupChecks in lite mode outside dev only', async () => {
    const dir = tempDir();
    const release = await runStartupChecks(staging, { dataDir: dir, readSetting: reader() });
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
    release();
    await runStartupChecks(dev, { dataDir: dir });
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    // A failed check releases the lock it took.
    await expect(runStartupChecks(staging, { dataDir: dir, readSetting: reader({ fsync: 'off' }) })).rejects.toThrow(/fsync/);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });
});

describe('(c) raw uploads at rest', () => {
  it('encrypts plaintext raw uploads at start and leaves none behind', async () => {
    const storage = new LocalObjectStorage(tempDir(), 'http://127.0.0.1:0', Buffer.alloc(32, 3));
    await storage.put('uploads/one', Buffer.from('raw one'), 'image/png');
    await encryptRawUploads(storage);
    expect(storage.plaintextKeys('uploads')).toEqual([]);
    expect((await storage.get('uploads/one'))?.body.toString()).toBe('raw one');
  });
});
