// D5 worker deployable (41 §1, §2.4): W1 outbox relay, event consumers, W15
// scheduler. In lite mode run it inside `pnpm dev` (shared in-process bus).
import { dataDir, loadConfig } from '#libs/config/index.js';
import { createLogger } from '#libs/observability/index.js';
import { workerAppModule } from '../shared/app-modules.js';
import { logDeviations, onShutdown, startWorkerApp, startupChecks } from '../shared/bootstrap.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, base: { service: 'carpal-backend', env: config.env } });
logDeviations(config, logger);
await startupChecks(config, logger, { dataDir: config.infra === 'lite' ? dataDir : null });
const app = await startWorkerApp(workerAppModule({ config, logger }), logger);
onShutdown(() => app.close(), logger);
