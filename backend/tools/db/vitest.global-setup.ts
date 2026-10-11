// Global setup for the integration project: makes sure the local cluster runs and
// the CarPal databases are installed (idempotent: only pending migrations run).
import { loadDbConfig } from './config.js';
import { setup } from './install.js';
import { startServer } from './server.js';

export default async function globalSetup(): Promise<void> {
  const cfg = loadDbConfig();
  if (cfg.mode === 'embedded') startServer(cfg);
  await setup(cfg, () => {});
}
