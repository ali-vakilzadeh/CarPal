// Runtime configuration (S2.T1): every setting comes from the environment (and
// backend/.env when present), is validated once with zod, and is then passed
// around as a frozen object. Defaults suit lite mode on a developer machine;
// staging and prod refuse the development secrets.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { backendDir } from './paths.js';

/** Development-only master secret. Every derived key (JWT, KEK, HMAC, pepper) is fixed by it. */
export const DEV_MASTER_SECRET = 'carpal-dev-master-secret--never-use-outside-dev';

const bool = z.stringbool({ truthy: ['1', 'true', 'yes', 'on'], falsy: ['0', 'false', 'no', 'off', ''] });
const port = z.coerce.number().int().min(0).max(65535);
const jsonRecord = <T extends z.ZodType>(value: T) =>
  z
    .string()
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be JSON' });
        return z.NEVER;
      }
    })
    .pipe(z.record(z.string(), value));

const loginRolePassword = (role: string) => z.string().min(1).default(`${role}_dev`);

const EnvSchema = z
  .object({
    CARPAL_ENV: z.enum(['dev', 'staging', 'prod']).default('dev'),
    /** lite = embedded PostgreSQL + in-process adapters; full = docker compose services (GD-04). */
    CARPAL_INFRA: z.enum(['lite', 'full']).default('lite'),
    /** Enforce DPoP, mTLS, attestation and PoW (GD-06). Off: logged deviations. */
    CARPAL_STRICT_AUTH: bool.default(false),
    CARPAL_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    CARPAL_REGION: z
      .string()
      .regex(/^[a-z0-9-]{2,40}$/)
      .default('ir-pilot'),

    // --- HTTP hosts (40 §1.1). Ports are local listeners; URLs are the public names used in tokens and links.
    CARPAL_HTTP_BIND: z.string().default('127.0.0.1'),
    CARPAL_API_PORT: port.default(8080),
    CARPAL_ADMIN_API_PORT: port.default(8081),
    CARPAL_AUTH_PORT: port.default(8082),
    CARPAL_STORAGE_PORT: port.default(8083),
    CARPAL_ISSUER: z.url().default('https://id.carpal.app'),
    CARPAL_API_AUDIENCE: z.url().default('https://api.carpal.app'),
    CARPAL_ADMIN_API_AUDIENCE: z.url().default('https://admin-api.carpal.app'),
    /** Base URL of signed media URLs. Lite: the local storage listener. */
    CARPAL_MEDIA_BASE_URL: z.url().optional(),
    CARPAL_I18N_BASE_URL: z.url().default('https://cdn.carpal.app/i18n'),
    CARPAL_I18N_VERSION: z.string().min(1).max(40).default('dev'),
    /** Minimum supported app version per client_id (40 §1.3), e.g. {"cp-mobile":"1.2.0"}. */
    CARPAL_CLIENT_MIN_VERSIONS: jsonRecord(z.string().regex(/^\d+\.\d+\.\d+$/)).default({}),
    CARPAL_CLIENT_LATEST_VERSION: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default('1.0.0'),

    // --- Database (lite: embedded cluster from tools/db; full: docker compose PostgreSQL)
    CARPAL_DB_HOST: z.string().default('127.0.0.1'),
    CARPAL_DB_PORT: port.default(54329),
    CARPAL_DB_NAME: z.string().default('carpal'),
    CARPAL_ANALYTICS_DB_NAME: z.string().default('carpal_analytics'),
    CARPAL_DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    /** Database ctype; core.normalize_search_text lower-cases ASCII only under C (see DI-07). */
    CARPAL_DB_LOCALE: z.string().default('C'),
    CARPAL_DB_PASSWORD_API: loginRolePassword('carpal_api'),
    CARPAL_DB_PASSWORD_ADMIN_API: loginRolePassword('carpal_admin_api'),
    CARPAL_DB_PASSWORD_AUTH: loginRolePassword('carpal_auth'),
    CARPAL_DB_PASSWORD_WORKER: loginRolePassword('carpal_worker'),
    CARPAL_DB_PASSWORD_ANALYTICS_WRITER: loginRolePassword('carpal_analytics_writer'),
    CARPAL_DB_PASSWORD_ANALYTICS_READER: loginRolePassword('carpal_analytics_reader'),
    /** MCP gateway / AI orchestration role (41 §3.3): the ai_mcp schema only. Lite runs the gateway in process (GD-35). */
    CARPAL_DB_PASSWORD_AI: loginRolePassword('carpal_ai'),

    // --- Full-mode services (GD-04). Unused in lite mode.
    CARPAL_REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
    CARPAL_NATS_URL: z.string().default('nats://127.0.0.1:4222'),
    CARPAL_SEARCH_URL: z.string().default('http://127.0.0.1:9200'),
    CARPAL_S3_ENDPOINT: z.string().default('http://127.0.0.1:9000'),
    CARPAL_SMTP_URL: z.string().default('smtp://127.0.0.1:1025'),

    // --- Secrets (40 §2.17). Dev derives every key from one master secret; real environments use the secret manager.
    CARPAL_MASTER_SECRET: z.string().min(32).default(DEV_MASTER_SECRET),
    /** Optional private Ed25519 JWKs (JSON array) for token signing; derived from the master secret when absent. */
    CARPAL_JWT_PRIVATE_JWKS: z.string().optional(),

    // --- Pipeline tuning
    /** Requests in flight per process before load shedding starts (SEC-RL-2). */
    CARPAL_MAX_INFLIGHT: z.coerce.number().int().min(1).max(100_000).default(512),
    /** Multiplies every rate-limit quota (tests raise it; 1 = contract defaults). */
    CARPAL_RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),
    /** JSON overrides of rate-limit buckets: {"search": [{"limit":30,"windowMs":60000,"scope":"user"}]}. */
    CARPAL_RATE_LIMITS: z.string().optional(),
    /** Validate every response against the contract (dev/test: a mismatch is a 500 and an error log). */
    CARPAL_VALIDATE_RESPONSES: bool.optional(),
    /** Flag cache refresh (40 SEC-AI-6 "within one config refresh"). */
    CARPAL_FLAG_REFRESH_MS: z.coerce.number().int().min(0).max(600_000).default(30_000),
    /** Authorization cache TTL (40 SEC-AU-3: at most 30 s). */
    CARPAL_AUTHZ_CACHE_MS: z.coerce.number().int().min(0).max(30_000).default(30_000),
    CARPAL_OUTBOX_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),

    // --- Auth server (S3, 40 §6.2)
    /** Hosted sign-in UI that auth.authorize redirects to (interaction_id in the query). */
    CARPAL_SIGNIN_URL: z.url().optional(),
    /** Exact redirect_uri allowlist per client_id (SEC-AU-1), JSON {"cp-mobile":["https://carpal.app/oauth/callback"]}. */
    CARPAL_OAUTH_REDIRECT_URIS: jsonRecord(z.array(z.url()).max(20)).optional(),
    /** SEC-AU-11 fixed minimum latency of sign-up, sign-in, OTP and reset start (plus 0-50 ms jitter). */
    CARPAL_AUTH_MIN_LATENCY_MS: z.coerce.number().int().min(0).max(5_000).default(400),
    /** Leading zero bits of auth.pow_challenge (SEC-BF-7); raised per risk later. */
    CARPAL_POW_DIFFICULTY_BITS: z.coerce.number().int().min(8).max(32).default(18),
    /** Taxonomy cache: how often the catalog fingerprint is re-checked (0 = every read). */
    CARPAL_TAXONOMY_REFRESH_MS: z.coerce.number().int().min(0).max(3_600_000).default(30_000),

    // --- Organizations and media (S4)
    /** Pin-versus-address distance above which a location is far_apart (52 OrganizationLocation; proposed 300 m in cities). */
    CARPAL_LOCATION_CHECK_THRESHOLD_M: z.coerce.number().int().min(1).max(100_000).default(300),
    /** W6 media processor: re-queue assets still pending a scan after this long (lost lite queue entries). */
    CARPAL_MEDIA_RESCAN_AFTER_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(300_000),
    /** Web origins that may PUT (signed upload) and GET (signed download) on the lite storage listener (PWA DI-08). */
    CARPAL_MEDIA_CORS_ORIGINS: z
      .string()
      .transform((s, ctx) => {
        try {
          return JSON.parse(s) as unknown;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'must be a JSON array' });
          return z.NEVER;
        }
      })
      .pipe(z.array(z.url().regex(/^https?:\/\/[^/]+$/, 'must be an origin (scheme://host[:port])')).max(20))
      .optional(),

    // --- Discovery (S6)
    /** W2: rebuild the search projections when the worker starts (the lite index is in memory, so it starts empty). */
    CARPAL_SEARCH_REBUILD_ON_START: bool.default(true),

    // --- AI / MCP (S9, GD-35)
    /**
     * McpClientPort adapter: stub = deterministic in-process tool results (schema-valid, EN/FA) until the
     * real MCP gateway (D6) exists; unavailable = every tool call fails, so AI operations answer
     * 503 AI_UNAVAILABLE and the non-AI paths carry on (53 §16.2). Defaults to stub in dev only.
     */
    CARPAL_MCP_MODE: z.enum(['stub', 'unavailable']).optional(),
    /** Tool call time limit (53 §16.1 timeout error). */
    CARPAL_MCP_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),

    // --- WebAuthn (S9, GD-31; 40 auth.webauthn_options "RP ID carpal.app")
    CARPAL_WEBAUTHN_RP_ID: z.string().min(1).max(253).default('carpal.app'),
    /** Origins allowed in clientDataJSON: the web apps and the mobile apps' origins (android:apk-key-hash:…). */
    CARPAL_WEBAUTHN_ORIGINS: z
      .string()
      .transform((s, ctx) => {
        try {
          return JSON.parse(s) as unknown;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'must be a JSON array' });
          return z.NEVER;
        }
      })
      .pipe(z.array(z.string().min(1).max(300)).min(1).max(20))
      .optional(),
  })
  .superRefine((env, ctx) => {
    if (env.CARPAL_ENV !== 'dev' && env.CARPAL_MASTER_SECRET === DEV_MASTER_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['CARPAL_MASTER_SECRET'], message: `must be set outside dev (CARPAL_ENV=${env.CARPAL_ENV})` });
    }
    if (env.CARPAL_ENV === 'prod' && !env.CARPAL_STRICT_AUTH) {
      ctx.addIssue({ code: 'custom', path: ['CARPAL_STRICT_AUTH'], message: 'must be 1 in prod (GD-06)' });
    }
  });

export type RawEnv = z.infer<typeof EnvSchema>;

export type CarpalEnv = RawEnv['CARPAL_ENV'];
export type InfraMode = RawEnv['CARPAL_INFRA'];
/** Database login roles used by the deployables (41 §3.3). */
export type AppDbRole = 'carpal_api' | 'carpal_admin_api' | 'carpal_auth' | 'carpal_worker';
/** Login roles of the analytics database (43 §23): the W12 pipeline writes, dashboards and aggregation read. */
export type AnalyticsDbRole = 'carpal_analytics_writer' | 'carpal_analytics_reader';
/** MCP gateway and AI orchestration (41 §1 D6/D7): ai_mcp tables, outbox, jobs and audit only. */
export type AiDbRole = 'carpal_ai';

export interface CarpalConfig {
  env: CarpalEnv;
  infra: InfraMode;
  strictAuth: boolean;
  logLevel: RawEnv['CARPAL_LOG_LEVEL'];
  region: string;
  http: {
    bind: string;
    ports: { api: number; 'admin-api': number; auth: number; storage: number };
    issuer: string;
    audiences: { api: string; 'admin-api': string };
    signinUrl: string;
    mediaBaseUrl: string;
    i18n: { baseUrl: string; version: string };
    clientMinVersions: Record<string, string>;
    clientLatestVersion: string;
  };
  db: {
    host: string;
    port: number;
    name: string;
    analyticsName: string;
    poolMax: number;
    locale: string;
    passwords: Record<AppDbRole | AnalyticsDbRole | AiDbRole, string>;
  };
  services: { redisUrl: string; natsUrl: string; searchUrl: string; s3Endpoint: string; smtpUrl: string };
  secrets: { master: string; jwtPrivateJwks?: string; isDevMaster: boolean };
  pipeline: {
    maxInflight: number;
    rateLimitScale: number;
    rateLimitOverrides?: string;
    validateResponses: boolean;
    flagRefreshMs: number;
    authzCacheMs: number;
    outboxPollMs: number;
  };
  auth: {
    redirectUris: Record<string, string[]>;
    minLatencyMs: number;
    powDifficultyBits: number;
  };
  taxonomyRefreshMs: number;
  geo: { locationCheckThresholdM: number };
  media: { rescanAfterMs: number; corsOrigins: string[] };
  search: { rebuildOnStart: boolean };
  mcp: { mode: 'stub' | 'unavailable'; timeoutMs: number };
  webauthn: { rpId: string; rpName: string; origins: string[] };
}

/** Development web origins of the consumer PWA (pnpm dev :3000, pnpm e2e :3100) for the storage listener's CORS. */
export const DEV_MEDIA_CORS_ORIGINS = ['http://localhost:3000', 'https://localhost:3000', 'http://localhost:3100'];

/** Development redirect URIs (claimed HTTPS links for mobile, BFF callbacks for web). */
export const DEV_REDIRECT_URIS: Record<string, string[]> = {
  'cp-mobile': ['https://carpal.app/oauth/callback'],
  'cp-web-consumer': ['https://carpal.app/bff/oauth/callback'],
  'cp-web-portal': ['https://portal.carpal.app/bff/oauth/callback'],
  'cp-web-admin': ['https://admin.carpal.app/bff/oauth/callback'],
};

let envFileLoaded = false;
function loadEnvFile(): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
  const file = join(backendDir, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

/**
 * Parses and validates the environment. Throws one error that lists every
 * invalid variable. `overrides` replace environment values (tests).
 */
export function loadConfig(overrides: Record<string, string | undefined> = {}): CarpalConfig {
  loadEnvFile();
  const source: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('CARPAL_')) source[k] = v?.trim() === '' ? undefined : v?.trim();
  Object.assign(source, overrides);
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const config: CarpalConfig = {
    env: e.CARPAL_ENV,
    infra: e.CARPAL_INFRA,
    strictAuth: e.CARPAL_STRICT_AUTH,
    logLevel: e.CARPAL_LOG_LEVEL,
    region: e.CARPAL_REGION,
    http: {
      bind: e.CARPAL_HTTP_BIND,
      ports: { api: e.CARPAL_API_PORT, 'admin-api': e.CARPAL_ADMIN_API_PORT, auth: e.CARPAL_AUTH_PORT, storage: e.CARPAL_STORAGE_PORT },
      issuer: e.CARPAL_ISSUER,
      signinUrl: e.CARPAL_SIGNIN_URL ?? `${e.CARPAL_ISSUER}/signin`,
      audiences: { api: e.CARPAL_API_AUDIENCE, 'admin-api': e.CARPAL_ADMIN_API_AUDIENCE },
      mediaBaseUrl: e.CARPAL_MEDIA_BASE_URL ?? `http://127.0.0.1:${e.CARPAL_STORAGE_PORT}`,
      i18n: { baseUrl: e.CARPAL_I18N_BASE_URL, version: e.CARPAL_I18N_VERSION },
      clientMinVersions: e.CARPAL_CLIENT_MIN_VERSIONS,
      clientLatestVersion: e.CARPAL_CLIENT_LATEST_VERSION,
    },
    db: {
      host: e.CARPAL_DB_HOST,
      port: e.CARPAL_DB_PORT,
      name: e.CARPAL_DB_NAME,
      analyticsName: e.CARPAL_ANALYTICS_DB_NAME,
      poolMax: e.CARPAL_DB_POOL_MAX,
      locale: e.CARPAL_DB_LOCALE,
      passwords: {
        carpal_api: e.CARPAL_DB_PASSWORD_API,
        carpal_admin_api: e.CARPAL_DB_PASSWORD_ADMIN_API,
        carpal_auth: e.CARPAL_DB_PASSWORD_AUTH,
        carpal_worker: e.CARPAL_DB_PASSWORD_WORKER,
        carpal_analytics_writer: e.CARPAL_DB_PASSWORD_ANALYTICS_WRITER,
        carpal_analytics_reader: e.CARPAL_DB_PASSWORD_ANALYTICS_READER,
        carpal_ai: e.CARPAL_DB_PASSWORD_AI,
      },
    },
    services: {
      redisUrl: e.CARPAL_REDIS_URL,
      natsUrl: e.CARPAL_NATS_URL,
      searchUrl: e.CARPAL_SEARCH_URL,
      s3Endpoint: e.CARPAL_S3_ENDPOINT,
      smtpUrl: e.CARPAL_SMTP_URL,
    },
    secrets: {
      master: e.CARPAL_MASTER_SECRET,
      ...(e.CARPAL_JWT_PRIVATE_JWKS ? { jwtPrivateJwks: e.CARPAL_JWT_PRIVATE_JWKS } : {}),
      isDevMaster: e.CARPAL_MASTER_SECRET === DEV_MASTER_SECRET,
    },
    pipeline: {
      maxInflight: e.CARPAL_MAX_INFLIGHT,
      rateLimitScale: e.CARPAL_RATE_LIMIT_SCALE,
      ...(e.CARPAL_RATE_LIMITS ? { rateLimitOverrides: e.CARPAL_RATE_LIMITS } : {}),
      validateResponses: e.CARPAL_VALIDATE_RESPONSES ?? e.CARPAL_ENV === 'dev',
      flagRefreshMs: e.CARPAL_FLAG_REFRESH_MS,
      authzCacheMs: e.CARPAL_AUTHZ_CACHE_MS,
      outboxPollMs: e.CARPAL_OUTBOX_POLL_MS,
    },
    auth: {
      redirectUris: e.CARPAL_OAUTH_REDIRECT_URIS ?? DEV_REDIRECT_URIS,
      minLatencyMs: e.CARPAL_AUTH_MIN_LATENCY_MS,
      powDifficultyBits: e.CARPAL_POW_DIFFICULTY_BITS,
    },
    taxonomyRefreshMs: e.CARPAL_TAXONOMY_REFRESH_MS,
    geo: { locationCheckThresholdM: e.CARPAL_LOCATION_CHECK_THRESHOLD_M },
    media: {
      rescanAfterMs: e.CARPAL_MEDIA_RESCAN_AFTER_MS,
      corsOrigins: e.CARPAL_MEDIA_CORS_ORIGINS ?? (e.CARPAL_ENV === 'dev' ? DEV_MEDIA_CORS_ORIGINS : []),
    },
    search: { rebuildOnStart: e.CARPAL_SEARCH_REBUILD_ON_START },
    mcp: { mode: e.CARPAL_MCP_MODE ?? (e.CARPAL_ENV === 'dev' ? 'stub' : 'unavailable'), timeoutMs: e.CARPAL_MCP_TIMEOUT_MS },
    webauthn: {
      rpId: e.CARPAL_WEBAUTHN_RP_ID,
      rpName: 'CarPal',
      origins: e.CARPAL_WEBAUTHN_ORIGINS ?? ['https://carpal.app', 'https://portal.carpal.app', 'https://admin.carpal.app'],
    },
  };
  return deepFreeze(config);
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
