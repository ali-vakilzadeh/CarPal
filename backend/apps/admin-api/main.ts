// D3 admin-api deployable (41 §1). In lite mode run all deployables in one
// process with `pnpm dev` instead: the lite KV store and event bus are per process.
import { loadConfig } from '#libs/config/index.js';
import { createLogger } from '#libs/observability/index.js';
import { adminApiAppModule } from '../shared/app-modules.js';
import { logDeviations, onShutdown, startHttpApp } from '../shared/bootstrap.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, base: { service: 'carpal-backend', env: config.env } });
logDeviations(config, logger);
const running = await startHttpApp('admin-api', adminApiAppModule({ config, logger }), config.http.ports['admin-api'], config, logger);
onShutdown(() => running.close(), logger);
