// The process-wide admin BFF, configured from the console environment (AC3.T1; GD-03: the BFF itself never reads env).
// Kept on globalThis so every route bundle and dev hot reloads share one session store. Adapted from
// pwa/src/server/bff-runtime.ts.
import 'server-only';
import packageJson from '../../package.json';
import { LOCALES, LOCALE_COOKIE } from '@/lib/i18n/locales';
import {
  createBff,
  DEFAULT_LIFETIMES,
  LiteSessionStore,
  privateKeyJwt,
  RedisSessionStore,
  RespClient,
  type Bff,
  type BffConfig,
  type ClientAuthentication,
} from './bff';
import { ADMIN_CLIENT_ID, serverEnv, type ServerEnv } from './env';

export function bffConfig(env: ServerEnv = serverEnv()): BffConfig {
  return {
    origin: env.CARPAL_ADMIN_ORIGIN.replace(/\/$/, ''),
    adminApiUrl: env.CARPAL_ADMIN_API_URL.replace(/\/$/, ''),
    authUrl: env.CARPAL_AUTH_URL.replace(/\/$/, ''),
    adminApiAudience: env.CARPAL_ADMIN_API_AUDIENCE.replace(/\/$/, ''),
    clientId: ADMIN_CLIENT_ID,
    clientVersion: packageJson.version,
    locales: [env.CARPAL_ADMIN_DEFAULT_LOCALE, ...LOCALES.filter((l) => l !== env.CARPAL_ADMIN_DEFAULT_LOCALE)],
    localeCookie: LOCALE_COOKIE,
    ...DEFAULT_LIFETIMES,
    ...(env.CARPAL_ADMIN_OAUTH_REDIRECT_URI ? { redirectUri: env.CARPAL_ADMIN_OAUTH_REDIRECT_URI } : {}),
  };
}

/** private_key_jwt with the cp-web-admin key when one is configured (always in strict mode and outside dev, env.ts). */
export function clientAuthentication(env: ServerEnv): ClientAuthentication | undefined {
  const key = env.CARPAL_ADMIN_CLIENT_PRIVATE_JWKS?.[ADMIN_CLIENT_ID];
  if (!key) return undefined;
  return privateKeyJwt(key, key.crv === 'Ed25519' ? 'EdDSA' : 'ES256');
}

const holder = globalThis as typeof globalThis & { __carpalAdminBff?: Bff };

export function bff(): Bff {
  if (!holder.__carpalAdminBff) {
    const env = serverEnv();
    const store =
      env.CARPAL_ADMIN_SESSION_STORE === 'redis'
        ? new RedisSessionStore(new RespClient(env.CARPAL_ADMIN_REDIS_URL!))
        : new LiteSessionStore();
    const clientAuth = clientAuthentication(env);
    holder.__carpalAdminBff = createBff({ config: bffConfig(env), store, ...(clientAuth ? { clientAuth } : {}) });
  }
  return holder.__carpalAdminBff;
}

/** Route-handler adapter: every method of a BFF route goes to the one handler. */
export function handleBff(request: Request): Promise<Response> {
  return bff().handle(request);
}
