// `pnpm dev`: every deployable in one lite-mode process (GD-04) — api,
// admin-api and auth on their own ports, the worker (outbox relay, consumers,
// scheduler) embedded, and the local signed-URL storage listener. They share
// one set of lite adapters, so sessions, rate limits and events cross hosts
// the way Redis and NATS would in full mode.
import { dataDir, loadConfig } from '#libs/config/index.js';
import { createInfra, LocalObjectStorage } from '#libs/infra/index.js';
import { createLogger } from '#libs/observability/index.js';
import { adminApiAppModule, apiAppModule, authAppModule, workerAppModule } from '../shared/app-modules.js';
import { logDeviations, onShutdown, startHttpApp, startWorkerApp } from '../shared/bootstrap.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, base: { service: 'carpal-backend', env: config.env } });
logDeviations(config, logger);

const infra = createInfra(config, { dataDir: config.infra === 'lite' ? dataDir : null, logger });
const shared = { config, infra, logger };

const storageServer =
  infra.storage instanceof LocalObjectStorage ? await infra.storage.listen(config.http.ports.storage, config.http.bind) : null;
const worker = await startWorkerApp(workerAppModule(shared), logger);
const auth = await startHttpApp('auth', authAppModule(shared), config.http.ports.auth, config, logger);
const api = await startHttpApp('api', apiAppModule(shared), config.http.ports.api, config, logger);
const admin = await startHttpApp('admin-api', adminApiAppModule(shared), config.http.ports['admin-api'], config, logger);

logger.info(
  {
    api: api.url,
    'admin-api': admin.url,
    auth: auth.url,
    storage: storageServer ? config.http.mediaBaseUrl : 'n/a',
    health: `${api.url}/v1/health`,
  },
  'CarPal backend running (lite mode, all deployables in one process)',
);

onShutdown(async () => {
  await admin.close();
  await api.close();
  await auth.close();
  await worker.close();
  storageServer?.close();
  await infra.close();
}, logger);
