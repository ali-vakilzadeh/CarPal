// Local database configuration for tooling and tests. Values come from the
// environment (and backend/.env when present); defaults suit the embedded
// development cluster, which listens on 127.0.0.1 only.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const repoDir = resolve(backendDir, '..');
/** Git tracks the folder as "Docs" (case matters on CI runners). */
export const docsDir = join(repoDir, 'Docs');
export const dbSetupScript = join(docsDir, '43.db_setup.sql');
export const taxonomyCatalog = join(docsDir, '44.taxonomy catalog.json');
export const migrationsDir = join(repoDir, 'database', 'migrations');
export const dataDir = join(backendDir, '.data');

const envFile = join(backendDir, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;

export type DbMode = 'embedded' | 'external';
export type CarpalEnv = 'dev' | 'staging' | 'prod';

/** Login roles created by the setup script, with the psql variable that sets their password. */
export const LOGIN_ROLES = {
  carpal_migrator: 'migrator_password',
  carpal_auth: 'auth_password',
  carpal_api: 'api_password',
  carpal_admin_api: 'admin_api_password',
  carpal_worker: 'worker_password',
  carpal_ai: 'ai_password',
  carpal_readonly: 'readonly_password',
  carpal_analytics_writer: 'analytics_writer_password',
  carpal_analytics_reader: 'analytics_reader_password',
} as const;
export type LoginRole = keyof typeof LOGIN_ROLES;

export interface DbConfig {
  mode: DbMode;
  env: CarpalEnv;
  host: string;
  port: number;
  superuser: string;
  superuserPassword: string;
  dbName: string;
  analyticsDbName: string;
  locale: string;
  adminEmail: string;
  pgDataDir: string;
  pgLogFile: string;
  rolePasswords: Record<LoginRole, string>;
}

export function loadDbConfig(): DbConfig {
  const mode = env('CARPAL_DB_MODE', 'embedded');
  if (mode !== 'embedded' && mode !== 'external') throw new Error(`CARPAL_DB_MODE must be embedded or external, got ${mode}`);
  const carpalEnv = env('CARPAL_ENV', 'dev');
  if (carpalEnv !== 'dev' && carpalEnv !== 'staging' && carpalEnv !== 'prod') {
    throw new Error(`CARPAL_ENV must be dev, staging or prod, got ${carpalEnv}`);
  }
  const rolePasswords = Object.fromEntries(
    Object.keys(LOGIN_ROLES).map((role) => {
      const key = `CARPAL_DB_PASSWORD_${role.replace(/^carpal_/, '').toUpperCase()}`;
      // Development defaults only: the embedded cluster accepts connections from 127.0.0.1 only.
      return [role, env(key, `${role}_dev`)];
    }),
  ) as Record<LoginRole, string>;
  return {
    mode,
    env: carpalEnv,
    host: env('CARPAL_DB_HOST', '127.0.0.1'),
    port: Number(env('CARPAL_DB_PORT', '54329')),
    superuser: env('CARPAL_DB_SUPERUSER', 'postgres'),
    superuserPassword: env('CARPAL_DB_SUPERUSER_PASSWORD', 'postgres_dev'),
    dbName: env('CARPAL_DB_NAME', 'carpal'),
    analyticsDbName: env('CARPAL_ANALYTICS_DB_NAME', 'carpal_analytics'),
    locale: env('CARPAL_DB_LOCALE', 'C'),
    adminEmail: env('CARPAL_ADMIN_EMAIL', 'admin@carpal.app'),
    pgDataDir: join(dataDir, 'pg'),
    pgLogFile: join(dataDir, 'pg.log'),
    rolePasswords,
  };
}
