// `pnpm preflight` (backend S26c.T1, NI-18): the backend's startup checks, run by deploy/2-build.sh before the
// service is started again, so an update that the backend would refuse fails in the build step and not after the
// restart. Loads the environment (backend.env), validates it like the backend (loadConfig: development secrets and
// the https media origin, naming the key), checks PostgreSQL durability outside dev, and reports the plaintext raw
// uploads the backend will encrypt at its next start. The process lock is not taken (the service is stopped during
// an update; a running backend is reported). Exit 0 = the backend will start; 1 = a check failed.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, loadConfig } from '#libs/config/index.js';
import { KeyRing } from '#libs/crypto/index.js';
import { LocalObjectStorage } from '#libs/infra/index.js';
import { checkDatabaseDurability, LOCK_FILE, RAW_UPLOAD_PREFIX, StartupCheckError } from '#libs/runtime/index.js';

function fail(message: string): never {
  console.error(`preflight: ${message}`);
  process.exit(1);
}

let config;
try {
  config = loadConfig();
} catch (err) {
  fail((err as Error).message);
}
console.log(`preflight: configuration valid (CARPAL_ENV=${config.env}, CARPAL_INFRA=${config.infra})`);

try {
  await checkDatabaseDurability(config);
  if (config.env !== 'dev') console.log('preflight: PostgreSQL fsync, synchronous_commit and full_page_writes are on');
} catch (err) {
  fail(err instanceof StartupCheckError ? err.message : `PostgreSQL check failed: ${(err as Error).message}`);
}

if (config.infra === 'lite') {
  const lock = join(dataDir, LOCK_FILE);
  if (existsSync(lock))
    console.log(`preflight: ${lock} exists (pid ${readFileSync(lock, 'utf8').split('\n')[0]}); a stale lock is taken over at start`);
  const storage = new LocalObjectStorage(
    join(dataDir, 'objects'),
    config.http.mediaBaseUrl,
    new KeyRing(config.secrets.master).hmacKey('storage-url'),
    Date.now,
    new KeyRing(config.secrets.master).derive('storage-sse'),
  );
  const plaintext = storage.plaintextKeys(RAW_UPLOAD_PREFIX).length;
  console.log(
    plaintext
      ? `preflight: ${plaintext} plaintext raw upload(s) under ${RAW_UPLOAD_PREFIX}/; the backend encrypts them at its next start`
      : 'preflight: no plaintext raw uploads',
  );
}
console.log('preflight: ok');
