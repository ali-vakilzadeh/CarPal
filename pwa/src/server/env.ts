// Server-only environment (P1.T7). Validated once at startup (src/instrumentation.ts) and on first use.
import 'server-only';
import { z } from 'zod';
import { LEGAL_VERSIONS } from '@/features/legal/documents';

const url = z.url();
const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), url.optional());
const timeZone = z.string().refine((v) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, 'must be an IANA time zone, e.g. Asia/Tehran');
/** The BFF's private keys for private_key_jwt, by client_id; the public halves are the backend's CARPAL_OAUTH_CLIENT_JWKS. */
const clientKeys = z.preprocess(
  (v) => {
    if (typeof v !== 'string' || v === '') return undefined;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return v;
    }
  },
  z.record(z.string(), z.looseObject({ kty: z.string(), kid: z.string().min(1), d: z.string().min(1) })).optional(),
);
/** Clients this PWA signs in as in strict mode. */
const STRICT_CLIENTS = ['cp-web-consumer', 'cp-ssr'] as const;
/** A policy version as the contract takes it (Str<1,20>). */
const policyVersion = z.string().min(1).max(20);

const schema = z
  .object({
    /** Deployment environment; prod enforces https origins and the Redis session store. */
    CARPAL_ENV: z.enum(['dev', 'staging', 'prod']).default('dev'),
    /** Public origin of the PWA (canonical URLs, Origin checks of the BFF in P2). */
    CARPAL_PWA_ORIGIN: url.default('http://localhost:3000'),
    /** Backend hosts (backend `pnpm dev` in lite mode). */
    CARPAL_API_URL: url.default('http://127.0.0.1:8080'),
    CARPAL_AUTH_URL: url.default('http://127.0.0.1:8082'),
    /** Media/storage host; signed media URLs and upload tickets point here (CSP img-src/connect-src, BA-06). */
    CARPAL_STORAGE_URL: url.default('http://127.0.0.1:8083'),
    /** Audience URL of the API host (backend CARPAL_API_AUDIENCE): the htu of DPoP proofs on API calls (GD-07). */
    CARPAL_API_AUDIENCE: url.default('https://api.carpal.app'),
    /** Mirrors the backend's CARPAL_STRICT_AUTH: client assertions at /oauth/token, and PoW before ATT grants (DI-22). */
    CARPAL_STRICT_AUTH: z
      .enum(['0', '1'])
      .default('0')
      .transform((v) => v === '1'),
    /**
     * Private JWKs for private_key_jwt: JSON {"cp-web-consumer":{…},"cp-ssr":{…}}, each with kid. Strict mode needs both.
     * Secret: lives only in pwa.env. `node pwa/deploy/gen-client-keys.mjs` makes the pair.
     */
    CARPAL_PWA_CLIENT_PRIVATE_JWKS: clientKeys,
    /** Overrides config.client region.map.style_url (GD-12). */
    CARPAL_PWA_MAP_STYLE_URL: optionalUrl,
    /** BFF session store (GD-08): lite = in-memory (one process), redis = shared. */
    CARPAL_PWA_SESSION_STORE: z.enum(['lite', 'redis']).default('lite'),
    CARPAL_PWA_REDIS_URL: optionalUrl,
    /** Maintenance mode (W-SYS-01): empty/off = live, "on" = no estimate, an ISO time = until then. Every page answers 503. */
    CARPAL_PWA_MAINTENANCE: z.string().max(40).optional(),
    /** Test and demo pages (/<locale>/dev-kit, status rewrites): 1 in development and E2E only; refused in prod. */
    CARPAL_PWA_DEMO: z
      .enum(['0', '1'])
      .default('0')
      .transform((v) => v === '1'),
    /**
     * Time zone for dates until the browser reports its own (cp_tz cookie), OQ-13. The region config has none (DI-29),
     * so each deployment states its default here.
     */
    CARPAL_PWA_DEFAULT_TIME_ZONE: timeZone.default('Asia/Tehran'),
    /**
     * Versions of the Terms and the Privacy Policy accepted at sign-up and named in consent records (auth.signup,
     * consents.grant). Default: the "Version" line of the published texts (Docs/User Agreement.md and Docs/Privacy
     * Policy.md, P13.T7), so the recorded version names the text the visitor could read; set them only together with
     * a text change.
     */
    CARPAL_PWA_TERMS_VERSION: policyVersion.default(LEGAL_VERSIONS.terms),
    CARPAL_PWA_PRIVACY_VERSION: policyVersion.default(LEGAL_VERSIONS.privacy),
    /**
     * "Contact support" (OQ-18, P13.T8): an email address for the MVP. The carpal.app domain is not secured yet, so
     * each deployment states the address it can receive mail at.
     */
    CARPAL_PWA_SUPPORT_EMAIL: z.email().default('support@carpal.app'),
    /** Business portal sign-up (onboarding step 1 business choices, W-ONB-01); a placeholder until the portal exists. */
    CARPAL_PWA_PORTAL_SIGNUP_URL: url.default('https://portal.carpal.app/signup'),
    /** The business portal: notifications of a business (organization_context_id) open here (DI-16, P12.T3). */
    CARPAL_PWA_PORTAL_URL: url.default('https://portal.carpal.app'),
    /**
     * Public VAPID key (base64url, an uncompressed P-256 point) of the push service that sends the backend's web
     * pushes (P12.T3). Empty = web push is not offered. The private key belongs to the sender, never to the PWA.
     */
    CARPAL_PWA_VAPID_PUBLIC_KEY: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{80,100}$/, 'must be a base64url P-256 public key')
        .optional(),
    ),
    /**
     * Dev/E2E only: the registered https redirect URI when the PWA itself runs on http://localhost (DI-24, OQ-10).
     * Empty = <CARPAL_PWA_ORIGIN>/bff/oauth/callback. Refused in prod.
     */
    CARPAL_PWA_OAUTH_REDIRECT_URI: optionalUrl,
  })
  .superRefine((env, ctx) => {
    if (env.CARPAL_PWA_SESSION_STORE === 'redis' && !env.CARPAL_PWA_REDIS_URL) {
      ctx.addIssue({ code: 'custom', path: ['CARPAL_PWA_REDIS_URL'], message: 'required when CARPAL_PWA_SESSION_STORE=redis' });
    }
    if (env.CARPAL_STRICT_AUTH)
      for (const client of STRICT_CLIENTS)
        if (!env.CARPAL_PWA_CLIENT_PRIVATE_JWKS?.[client])
          ctx.addIssue({
            code: 'custom',
            path: ['CARPAL_PWA_CLIENT_PRIVATE_JWKS'],
            message: `needs the private key of ${client} in strict mode`,
          });
    if (env.CARPAL_ENV === 'prod') {
      for (const key of ['CARPAL_PWA_ORIGIN', 'CARPAL_STORAGE_URL'] as const) {
        if (!env[key].startsWith('https://')) ctx.addIssue({ code: 'custom', path: [key], message: 'must be https in prod' });
      }
      if (env.CARPAL_PWA_DEMO) ctx.addIssue({ code: 'custom', path: ['CARPAL_PWA_DEMO'], message: 'must be 0 in prod' });
      if (env.CARPAL_PWA_OAUTH_REDIRECT_URI)
        ctx.addIssue({ code: 'custom', path: ['CARPAL_PWA_OAUTH_REDIRECT_URI'], message: 'dev and E2E only; must be empty in prod' });
      if (env.CARPAL_PWA_SESSION_STORE !== 'redis') {
        ctx.addIssue({ code: 'custom', path: ['CARPAL_PWA_SESSION_STORE'], message: 'prod needs the redis session store' });
      }
    }
  });

export type ServerEnv = z.infer<typeof schema>;

/** Parses an environment record; throws one error that lists every invalid variable. */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const picked = Object.fromEntries(Object.keys(schema.shape).map((k) => [k, source[k] === '' ? undefined : source[k]]));
  const result = schema.safeParse(picked);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid PWA environment:\n${lines.join('\n')}`);
  }
  return result.data;
}

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
