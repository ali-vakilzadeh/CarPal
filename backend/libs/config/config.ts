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

/** Confidential clients that exist today; strict mode cannot start without their public keys (S11.T1). */
const STRICT_CLIENTS = ['cp-web-consumer', 'cp-ssr'] as const;

const loginRolePassword = (role: string) => z.string().min(1).default(`${role}_dev`);

/** Login-role password keys and their roles; the development default of each is `<role>_dev`. */
const DB_PASSWORD_KEYS = [
  ['CARPAL_DB_PASSWORD_API', 'carpal_api'],
  ['CARPAL_DB_PASSWORD_ADMIN_API', 'carpal_admin_api'],
  ['CARPAL_DB_PASSWORD_AUTH', 'carpal_auth'],
  ['CARPAL_DB_PASSWORD_WORKER', 'carpal_worker'],
  ['CARPAL_DB_PASSWORD_ANALYTICS_WRITER', 'carpal_analytics_writer'],
  ['CARPAL_DB_PASSWORD_ANALYTICS_READER', 'carpal_analytics_reader'],
  ['CARPAL_DB_PASSWORD_AI', 'carpal_ai'],
] as const;

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
    CARPAL_ISSUER: z.url().default('https://id.carpals.ir'),
    CARPAL_API_AUDIENCE: z.url().default('https://api.carpals.ir'),
    CARPAL_ADMIN_API_AUDIENCE: z.url().default('https://admin-api.carpals.ir'),
    /** Base URL of signed media URLs. Lite: the local storage listener. */
    CARPAL_MEDIA_BASE_URL: z.url().optional(),
    /** Base of the link-token URLs in emails (<base>/<type>#<token>, SEC-LT-2): the consumer PWA's /l pages. */
    CARPAL_LINK_BASE_URL: z.url().default('https://pwa.carpals.ir/l'),
    CARPAL_I18N_BASE_URL: z.url().default('https://cdn.carpals.ir/i18n'),
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

    // --- Email (backend S26a, NI-07): the carpals.ir mailbox on the cPanel host, through authenticated SMTP submission.
    /** file: backend/.data/outbox-mail.jsonl (dev, tests); smtp: CARPAL_SMTP_URL. Default: file in lite mode, smtp in full mode. */
    CARPAL_MAIL_TRANSPORT: z.enum(['file', 'smtp']).optional(),
    CARPAL_MAIL_FROM: z.string().min(3).max(200).default('CarPal <no-reply@carpals.ir>'),
    CARPAL_MAIL_REPLY_TO: z.string().min(3).max(200).optional(),
    /** Messages per hour through SMTP (shared hosting quota): above it non-critical mail waits; codes and security notices go. */
    CARPAL_MAIL_MAX_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(300),
    /** Dev only: accept a self-signed SMTP certificate (a local test server). Refused outside dev. */
    CARPAL_SMTP_TLS_INSECURE: bool.default(false),

    // --- Geocoder (backend S26b, DQ-29): fixture (dev and tests) | neshan | unconfigured (answers 503). Unset: fixture in dev (lite), otherwise unconfigured.
    CARPAL_GEOCODER: z.enum(['fixture', 'neshan', 'unconfigured']).optional(),
    /** Neshan service key (server side only, never sent to a client). */
    CARPAL_NESHAN_SERVICE_KEY: z.string().min(8).max(200).optional(),
    // --- SMS (backend S26a, DQ-28): the SmsGateway port and its provider.
    /** mock: behaves like a provider without sending (outbox-sms.jsonl); file: the old sink; vendors are added as adapters. */
    CARPAL_SMS_PROVIDER: z.enum(['mock', 'file']).default('mock'),
    /** Reserved for the chosen vendor's adapter (unused by mock and file). */
    CARPAL_SMS_API_KEY: z.string().min(1).max(500).optional(),
    CARPAL_SMS_SENDER_LINE: z
      .string()
      .regex(/^\+?[0-9]{3,20}$/)
      .optional(),
    CARPAL_SMS_OTP_TEMPLATE: z.string().min(1).max(100).optional(),
    /** Mock: delay before a sent message reports delivered. */
    CARPAL_SMS_MOCK_DELIVERY_MS: z.coerce.number().int().min(0).max(3_600_000).default(5_000),
    /** Mock: E.164 numbers (comma-separated) that fail permanently / temporarily, to test retries and Delivery health. */
    CARPAL_SMS_MOCK_FAIL_PERMANENT: z.string().max(2000).default(''),
    CARPAL_SMS_MOCK_FAIL_TEMPORARY: z.string().max(2000).default(''),

    // --- Exchange rate (backend S26a): the default when the region's display-currency row is missing, and the reminder.
    CARPAL_DEFAULT_IRR_PER_USD: z
      .string()
      .regex(/^[0-9]{1,10}(\.[0-9]{1,4})?$/)
      .refine((v) => Number(v) > 0, 'must be > 0')
      .default('1000000'),
    /** Hour (0-23, region time) of the morning reminder to administrators when the rate was not set that day. */
    CARPAL_RATE_REMINDER_HOUR: z.coerce.number().int().min(0).max(23).default(9),

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
    /** Exact redirect_uri allowlist per client_id (SEC-AU-1), JSON {"cp-mobile":["https://carpals.ir/oauth/callback"]}. */
    CARPAL_OAUTH_REDIRECT_URIS: jsonRecord(z.array(z.url()).max(20)).optional(),
    /**
     * Public keys of the confidential clients for private_key_jwt (RFC 7523) at /oauth/token: JSON
     * {"cp-web-consumer":{"keys":[<public JWK>]},"cp-ssr":{"keys":[…]}} (GD-06 amendment 2026-11-04). Strict mode needs
     * both; private keys stay with the client (pwa.env) and are refused here.
     */
    CARPAL_OAUTH_CLIENT_JWKS: jsonRecord(z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1).max(10) })).optional(),
    /** SEC-AU-11 fixed minimum latency of sign-up, sign-in, OTP and reset start (plus 0-50 ms jitter). */
    CARPAL_AUTH_MIN_LATENCY_MS: z.coerce.number().int().min(0).max(5_000).default(400),
    /** Leading zero bits of auth.pow_challenge (SEC-BF-7); raised per risk later. */
    CARPAL_POW_DIFFICULTY_BITS: z.coerce.number().int().min(8).max(32).default(18),
    /**
     * Per-client difficulty (S26c.T2, PWA NI-P13-13): JSON {"cp-web-consumer":16}; clients not named use
     * CARPAL_POW_DIFFICULTY_BITS. Nothing is lowered unless configured.
     */
    CARPAL_POW_CLIENT_DIFFICULTY_BITS: jsonRecord(z.number().int().min(8).max(32)).default({}),

    // --- Web edge (S26c.T2, NI-19)
    /**
     * Addresses whose X-Forwarded-For is trusted (nginx, a local BFF), JSON ["127.0.0.1","::1"]. Empty: the socket
     * address is the client (every caller behind nginx then looks like 127.0.0.1).
     */
    CARPAL_TRUSTED_PROXIES: z
      .string()
      .transform((s, ctx) => {
        try {
          return JSON.parse(s) as unknown;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'must be a JSON array of IP addresses' });
          return z.NEVER;
        }
      })
      .pipe(z.array(z.union([z.ipv4(), z.ipv6()])).max(20))
      .optional(),
    /**
     * Web origins allowed as Origin on the auth host's /v1/auth/* (SEC-WEB-3): the BFF origins whose /id proxy
     * forwards the browser's Origin. The issuer's origin is always allowed. Default: the https origins of
     * CARPAL_WEBAUTHN_ORIGINS (plus the local PWA and console origins in dev).
     */
    CARPAL_AUTH_WEB_ORIGINS: z
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

    // --- WebAuthn (S9, GD-31; 40 auth.webauthn_options "RP ID carpals.ir")
    CARPAL_WEBAUTHN_RP_ID: z.string().min(1).max(253).default('carpals.ir'),
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
    if (env.CARPAL_ENV !== 'dev') {
      // S26c.T1 (NI-18 e): the development login-role passwords (<role>_dev, the defaults) are public; refused outside dev.
      for (const [key, role] of DB_PASSWORD_KEYS)
        if (env[key] === `${role}_dev`)
          ctx.addIssue({ code: 'custom', path: [key], message: `is the development password of ${role}; set a random one outside dev` });
      // S26c.T1 (NI-18 b): signed media URLs name the configured https media origin; the lite listener's http address
      // (and the response check's https rewrite of it, DI-26) is for dev only.
      if (!env.CARPAL_MEDIA_BASE_URL)
        ctx.addIssue({ code: 'custom', path: ['CARPAL_MEDIA_BASE_URL'], message: 'must be set outside dev (https://media.<domain>)' });
      else if (!env.CARPAL_MEDIA_BASE_URL.startsWith('https://'))
        ctx.addIssue({ code: 'custom', path: ['CARPAL_MEDIA_BASE_URL'], message: 'must be an https:// origin outside dev' });
    }
    if (env.CARPAL_ENV !== 'dev' && env.CARPAL_SMTP_TLS_INSECURE)
      ctx.addIssue({ code: 'custom', path: ['CARPAL_SMTP_TLS_INSECURE'], message: 'is dev only: the certificate must verify' });
    if (env.CARPAL_GEOCODER === 'neshan' && !env.CARPAL_NESHAN_SERVICE_KEY)
      ctx.addIssue({ code: 'custom', path: ['CARPAL_NESHAN_SERVICE_KEY'], message: 'is required when CARPAL_GEOCODER=neshan' });
    if (env.CARPAL_ENV !== 'dev' && env.CARPAL_GEOCODER === 'fixture')
      ctx.addIssue({ code: 'custom', path: ['CARPAL_GEOCODER'], message: 'fixture is for dev and tests only' });
    const transport = env.CARPAL_MAIL_TRANSPORT ?? (env.CARPAL_INFRA === 'full' ? 'smtp' : 'file');
    if (transport === 'smtp') {
      const problem = smtpUrlProblem(env.CARPAL_SMTP_URL, env.CARPAL_ENV);
      if (problem) ctx.addIssue({ code: 'custom', path: ['CARPAL_SMTP_URL'], message: problem });
    }
    if (env.CARPAL_ENV === 'prod' && !env.CARPAL_STRICT_AUTH) {
      ctx.addIssue({ code: 'custom', path: ['CARPAL_STRICT_AUTH'], message: 'must be 1 in prod (GD-06)' });
    }
    const jwks = env.CARPAL_OAUTH_CLIENT_JWKS ?? {};
    if (env.CARPAL_STRICT_AUTH)
      for (const client of STRICT_CLIENTS)
        if (!jwks[client])
          ctx.addIssue({ code: 'custom', path: ['CARPAL_OAUTH_CLIENT_JWKS'], message: `needs the public key of ${client} in strict mode` });
    for (const [client, set] of Object.entries(jwks))
      if (set.keys.some((k) => 'd' in k))
        ctx.addIssue({
          code: 'custom',
          path: ['CARPAL_OAUTH_CLIENT_JWKS'],
          message: `${client}: private key material, register public keys only`,
        });
  });

/**
 * SMTP URL rule (S26a.T2): smtps:// (implicit TLS, port 465) or smtp:// with STARTTLS required (port 587); credentials
 * in the URL. Plain SMTP is accepted in dev only, to a loopback test server. Returns the problem, or null.
 */
export function smtpUrlProblem(raw: string, env: 'dev' | 'staging' | 'prod'): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'must be a URL like smtps://user:password@mail.carpals.ir:465';
  }
  if (u.protocol !== 'smtps:' && u.protocol !== 'smtp:') return 'must start with smtps:// or smtp://';
  if (!u.hostname) return 'needs a host';
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (env !== 'dev' && (!u.username || !u.password)) return `needs the mailbox login (smtps://user:password@host:465) outside dev`;
  if (env !== 'dev' && loopback) return 'points at this machine; outside dev it must be the mail server';
  return null;
}

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
    linkBaseUrl: string;
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
    clientJwks: Record<string, { keys: Record<string, unknown>[] }>;
    minLatencyMs: number;
    powDifficultyBits: number;
    /** Per-client PoW difficulty (S26c.T2); clients not named use powDifficultyBits. */
    powClientDifficultyBits: Record<string, number>;
    /** Origins allowed as Origin on the auth host's state-changing /v1/auth/* routes (SEC-WEB-3), issuer included. */
    webOrigins: string[];
  };
  /** S26c.T2 (NI-19): proxies whose X-Forwarded-For is trusted (normalized IP literals). */
  edge: { trustedProxies: string[] };
  taxonomyRefreshMs: number;
  geo: { locationCheckThresholdM: number };
  media: { rescanAfterMs: number; corsOrigins: string[] };
  search: { rebuildOnStart: boolean };
  mcp: { mode: 'stub' | 'unavailable'; timeoutMs: number };
  webauthn: { rpId: string; rpName: string; origins: string[] };
  mail: {
    transport: 'file' | 'smtp';
    from: string;
    replyTo: string | null;
    maxPerHour: number;
    /** Dev only (a local test server with a self-signed certificate). */
    tlsInsecure: boolean;
  };
  geocoder: { provider: 'fixture' | 'neshan' | 'unconfigured'; neshanServiceKey: string | null };
  sms: {
    provider: 'mock' | 'file';
    apiKey: string | null;
    senderLine: string | null;
    otpTemplate: string | null;
    mock: { deliveryMs: number; failPermanent: string[]; failTemporary: string[] };
  };
  rates: { defaultIrrPerUsd: string; reminderHour: number };
}

const numberList = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Development web origins of the consumer PWA (pnpm dev :3000, pnpm e2e :3100) for the storage listener's CORS. */
export const DEV_MEDIA_CORS_ORIGINS = ['http://localhost:3000', 'https://localhost:3000', 'http://localhost:3100'];

/** Development redirect URIs (claimed HTTPS links for mobile, BFF callbacks for web). */
export const DEV_REDIRECT_URIS: Record<string, string[]> = {
  'cp-mobile': ['https://carpals.ir/oauth/callback'],
  'cp-web-consumer': ['https://pwa.carpals.ir/bff/oauth/callback'],
  'cp-web-portal': ['https://web.carpals.ir/bff/oauth/callback'],
  'cp-web-admin': ['https://admin.carpals.ir/bff/oauth/callback'],
};

/** Local web apps in dev: the PWA (pnpm dev :3000, pnpm e2e :3100) and the admin console (pnpm dev :3200, e2e :3300). */
export const DEV_WEB_ORIGINS = [...DEV_MEDIA_CORS_ORIGINS, 'http://localhost:3200', 'https://localhost:3200', 'http://localhost:3300'];

/** SEC-WEB-3 on the auth host: the issuer's origin, then the configured BFF origins (or the WebAuthn web origins). */
function authWebOrigins(e: RawEnv): string[] {
  const configured =
    e.CARPAL_AUTH_WEB_ORIGINS ??
    [
      ...(e.CARPAL_WEBAUTHN_ORIGINS ?? ['https://pwa.carpals.ir', 'https://web.carpals.ir', 'https://admin.carpals.ir']),
      ...(e.CARPAL_ENV === 'dev' ? DEV_WEB_ORIGINS : []),
    ].filter((o) => /^https?:\/\/[^/]+$/.test(o));
  return [...new Set([new URL(e.CARPAL_ISSUER).origin, ...configured])];
}

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
      linkBaseUrl: e.CARPAL_LINK_BASE_URL.replace(/\/$/, ''),
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
      clientJwks: e.CARPAL_OAUTH_CLIENT_JWKS ?? {},
      minLatencyMs: e.CARPAL_AUTH_MIN_LATENCY_MS,
      powDifficultyBits: e.CARPAL_POW_DIFFICULTY_BITS,
      powClientDifficultyBits: e.CARPAL_POW_CLIENT_DIFFICULTY_BITS,
      webOrigins: authWebOrigins(e),
    },
    edge: { trustedProxies: (e.CARPAL_TRUSTED_PROXIES ?? []).map((a) => a.toLowerCase()) },
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
      origins: e.CARPAL_WEBAUTHN_ORIGINS ?? ['https://pwa.carpals.ir', 'https://web.carpals.ir', 'https://admin.carpals.ir'],
    },
    mail: {
      transport: e.CARPAL_MAIL_TRANSPORT ?? (e.CARPAL_INFRA === 'full' ? 'smtp' : 'file'),
      from: e.CARPAL_MAIL_FROM,
      replyTo: e.CARPAL_MAIL_REPLY_TO ?? null,
      maxPerHour: e.CARPAL_MAIL_MAX_PER_HOUR,
      tlsInsecure: e.CARPAL_SMTP_TLS_INSECURE,
    },
    geocoder: {
      // The fixture list is for dev only: staging and prod without a provider answer 503 rather than serve fake addresses.
      provider: e.CARPAL_GEOCODER ?? (e.CARPAL_ENV === 'dev' && e.CARPAL_INFRA === 'lite' ? 'fixture' : 'unconfigured'),
      neshanServiceKey: e.CARPAL_NESHAN_SERVICE_KEY ?? null,
    },
    sms: {
      provider: e.CARPAL_SMS_PROVIDER,
      apiKey: e.CARPAL_SMS_API_KEY ?? null,
      senderLine: e.CARPAL_SMS_SENDER_LINE ?? null,
      otpTemplate: e.CARPAL_SMS_OTP_TEMPLATE ?? null,
      mock: {
        deliveryMs: e.CARPAL_SMS_MOCK_DELIVERY_MS,
        failPermanent: numberList(e.CARPAL_SMS_MOCK_FAIL_PERMANENT),
        failTemporary: numberList(e.CARPAL_SMS_MOCK_FAIL_TEMPORARY),
      },
    },
    rates: { defaultIrrPerUsd: e.CARPAL_DEFAULT_IRR_PER_USD, reminderHour: e.CARPAL_RATE_REMINDER_HOUR },
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
