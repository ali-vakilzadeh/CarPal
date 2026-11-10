// Server-only environment (AC1.T5, BFF settings AC3.T1). Validated on first use; nothing else reads process.env.
import 'server-only';
import { z } from 'zod';
import { LOCALES } from '@/lib/i18n/locales';

const timeZone = z.string().refine((v) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, 'must be an IANA time zone, e.g. Asia/Tehran');

/** The BFF's private key(s) for private_key_jwt, by client id; the public half is the backend's CARPAL_OAUTH_CLIENT_JWKS. */
const clientKeys = z.preprocess(
  (v) => {
    if (typeof v !== 'string' || v === '') return undefined;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return v;
    }
  },
  z
    .record(z.string(), z.looseObject({ kty: z.string(), kid: z.string().min(1), d: z.string().min(1), crv: z.string().optional() }))
    .optional(),
);

export const ADMIN_ENVS = ['dev', 'staging', 'prod'] as const;
export type AdminEnv = (typeof ADMIN_ENVS)[number];
export const ADMIN_CLIENT_ID = 'cp-web-admin';

const schema = z
  .object({
    /** Which environment this console serves; drives the environment badge (GD-06). */
    CARPAL_ADMIN_ENV: z.enum(ADMIN_ENVS).default('dev'),
    /** Public origin of the console (Origin checks of the BFF, redirect URI, WebAuthn origin). */
    CARPAL_ADMIN_ORIGIN: z.url().default('http://localhost:3200'),
    /** Language when neither the cookie nor Accept-Language decides (OQ-06 default). */
    CARPAL_ADMIN_DEFAULT_LOCALE: z.enum(LOCALES).default('fa'),
    /** Time zone of dates until the browser reports its own. */
    CARPAL_ADMIN_DEFAULT_TIME_ZONE: timeZone.default('Asia/Tehran'),
    /** Internal base URLs of the backend hosts the BFF calls (backend lite: admin-api :8081, auth :8082). */
    CARPAL_ADMIN_API_URL: z.url().default('http://127.0.0.1:8081'),
    CARPAL_AUTH_URL: z.url().default('http://127.0.0.1:8082'),
    /**
     * Media/storage host (as in the PWA): the 5-minute display links of admin.media_download_url point here, so the
     * page CSP allows it for images and video (AC8 media viewer). Dev: the backend's storage listener.
     */
    CARPAL_STORAGE_URL: z.url().default('http://127.0.0.1:8083'),
    /** The public web app (pwa.<DOMAIN>): "Open the public page" links of moderation cases (GD-07, AC8). */
    CARPAL_ADMIN_PUBLIC_WEB_URL: z.url().default('http://localhost:3000'),
    /**
     * The map style of the Locations tab (AC9, a MapLibre style.json on the region's tile host). Unset: the built-in
     * style without a basemap (the pilot tile URLs are placeholders, D-59). Its origin is allowed by the page CSP.
     */
    CARPAL_ADMIN_MAP_STYLE_URL: z.url().optional(),
    /** Audience URL of the admin-api host (backend CARPAL_ADMIN_API_AUDIENCE): the htu of DPoP proofs on admin calls. */
    CARPAL_ADMIN_API_AUDIENCE: z.url().default('https://admin-api.carpals.ir'),
    /** Mirrors the backend's CARPAL_STRICT_AUTH (client assertion at /oauth/token, DPoP everywhere). */
    CARPAL_STRICT_AUTH: z
      .enum(['0', '1'])
      .default('0')
      .transform((v) => v === '1'),
    /**
     * Private JWK of cp-web-admin for private_key_jwt: JSON {"cp-web-admin":{…kid, d…}}, i.e. the output of
     * `node backend/deploy/gen-client-keys.mjs --private oauth-admin-client-keys.json`. Required in strict mode and
     * outside dev. Secret: lives only in the console's env file (never in the PWA's, AC2 D-12).
     */
    CARPAL_ADMIN_CLIENT_PRIVATE_JWKS: clientKeys,
    /**
     * The registered redirect URI when it differs from <origin>/bff/oauth/callback. Dev and E2E only: the backend
     * registers https URIs only, so a console on http://localhost:3200 registers https://localhost:3200/… and the
     * /id proxy brings the code back to http (OQ-11, PWA DI-24).
     */
    CARPAL_ADMIN_OAUTH_REDIRECT_URI: z.url().optional(),
    /** BFF session store: lite = in-memory (one process; sessions end on restart), redis = shared. */
    CARPAL_ADMIN_SESSION_STORE: z.enum(['lite', 'redis']).default('lite'),
    CARPAL_ADMIN_REDIS_URL: z.url().optional(),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (env.CARPAL_ADMIN_ENV !== 'dev' && !env.CARPAL_ADMIN_ORIGIN.startsWith('https://'))
      issue('CARPAL_ADMIN_ORIGIN', 'must be https outside dev');
    for (const key of ['CARPAL_STORAGE_URL', 'CARPAL_ADMIN_PUBLIC_WEB_URL'] as const)
      if (env.CARPAL_ADMIN_ENV !== 'dev' && !env[key].startsWith('https://')) issue(key, 'must be https outside dev');
    if (env.CARPAL_ADMIN_MAP_STYLE_URL && env.CARPAL_ADMIN_ENV !== 'dev' && !env.CARPAL_ADMIN_MAP_STYLE_URL.startsWith('https://'))
      issue('CARPAL_ADMIN_MAP_STYLE_URL', 'must be https outside dev');
    if ((env.CARPAL_STRICT_AUTH || env.CARPAL_ADMIN_ENV !== 'dev') && !env.CARPAL_ADMIN_CLIENT_PRIVATE_JWKS?.[ADMIN_CLIENT_ID])
      issue('CARPAL_ADMIN_CLIENT_PRIVATE_JWKS', `needs the private key of ${ADMIN_CLIENT_ID} in strict mode and outside dev`);
    if (env.CARPAL_ADMIN_ENV !== 'dev' && !env.CARPAL_STRICT_AUTH) issue('CARPAL_STRICT_AUTH', 'must be 1 outside dev');
    if (env.CARPAL_ADMIN_ENV !== 'dev' && env.CARPAL_ADMIN_OAUTH_REDIRECT_URI)
      issue('CARPAL_ADMIN_OAUTH_REDIRECT_URI', 'dev and E2E only; must be empty outside dev');
    if (env.CARPAL_ADMIN_SESSION_STORE === 'redis' && !env.CARPAL_ADMIN_REDIS_URL)
      issue('CARPAL_ADMIN_REDIS_URL', 'needed with CARPAL_ADMIN_SESSION_STORE=redis');
  });

export type ServerEnv = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined>): ServerEnv {
  // Only this schema's keys; an empty value counts as unset (env files often carry `NAME=`).
  const picked = Object.fromEntries(Object.keys(schema.shape).map((k) => [k, source[k] === '' ? undefined : source[k]]));
  const result = schema.safeParse(picked);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid admin console environment:\n${lines.join('\n')}`);
  }
  return result.data;
}

let cached: ServerEnv | undefined;
export function serverEnv(): ServerEnv {
  cached ??= parseEnv(process.env);
  return cached;
}
