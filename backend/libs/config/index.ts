// Runtime configuration (S2.T1): zod-validated environment and on-disk locations.
export {
  loadConfig,
  DEV_MASTER_SECRET,
  type CarpalConfig,
  type CarpalEnv,
  type InfraMode,
  type AppDbRole,
  type AnalyticsDbRole,
} from './config.js';
export { backendDir, repoDir, dataDir, regionConfigDir } from './paths.js';
