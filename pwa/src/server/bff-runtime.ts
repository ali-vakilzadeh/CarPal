// The process-wide BFF instance, configured from the PWA environment (GD-03: the BFF itself never reads env). Kept
// on globalThis so every route bundle and dev hot reloads share one session store.
import 'server-only';
import packageJson from '../../package.json';
import { createBff, DEFAULT_LIFETIMES, LiteSessionStore, RedisSessionStore, RespClient, type Bff, type BffConfig } from './bff';
import { LOCALES, DEFAULT_LOCALE } from '@/lib/i18n/locales';
import { serverEnv } from './env';

export function bffConfig(): BffConfig {
  const env = serverEnv();
  return {
    origin: env.CARPAL_PWA_ORIGIN.replace(/\/$/, ''),
    apiUrl: env.CARPAL_API_URL.replace(/\/$/, ''),
    authUrl: env.CARPAL_AUTH_URL.replace(/\/$/, ''),
    apiAudience: env.CARPAL_API_AUDIENCE.replace(/\/$/, ''),
    clientId: 'cp-web-consumer',
    ssrClientId: 'cp-ssr',
    clientVersion: packageJson.version,
    strict: env.CARPAL_STRICT_AUTH,
    locales: [DEFAULT_LOCALE, ...LOCALES.filter((l) => l !== DEFAULT_LOCALE)],
    ...DEFAULT_LIFETIMES,
    ...(env.CARPAL_PWA_OAUTH_REDIRECT_URI ? { redirectUri: env.CARPAL_PWA_OAUTH_REDIRECT_URI } : {}),
  };
}

const holder = globalThis as typeof globalThis & { __carpalBff?: Bff };

export function bff(): Bff {
  if (!holder.__carpalBff) {
    const env = serverEnv();
    const store =
      env.CARPAL_PWA_SESSION_STORE === 'redis' ? new RedisSessionStore(new RespClient(env.CARPAL_PWA_REDIS_URL!)) : new LiteSessionStore();
    holder.__carpalBff = createBff({ config: bffConfig(), store });
  }
  return holder.__carpalBff;
}

/** Route-handler adapter: every method of a BFF route goes to the one handler. */
export function handleBff(request: Request): Promise<Response> {
  return bff().handle(request);
}
