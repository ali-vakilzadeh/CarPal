// Server-only environment (AC1.T5). Validated on first use; AC3 adds the BFF settings (client id, private JWKS,
// issuer, admin-api and api URLs, redirect URI, session store).
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

export const ADMIN_ENVS = ['dev', 'staging', 'prod'] as const;
export type AdminEnv = (typeof ADMIN_ENVS)[number];

const schema = z
  .object({
    /** Which environment this console serves; drives the environment badge (GD-06). */
    CARPAL_ADMIN_ENV: z.enum(ADMIN_ENVS).default('dev'),
    /** Public origin of the console (Origin checks of the BFF in AC3). */
    CARPAL_ADMIN_ORIGIN: z.url().default('http://localhost:3200'),
    /** Language when neither the cookie nor Accept-Language decides (OQ-06 default). */
    CARPAL_ADMIN_DEFAULT_LOCALE: z.enum(LOCALES).default('fa'),
    /** Time zone of dates until the browser reports its own. */
    CARPAL_ADMIN_DEFAULT_TIME_ZONE: timeZone.default('Asia/Tehran'),
  })
  .superRefine((env, ctx) => {
    if (env.CARPAL_ADMIN_ENV !== 'dev' && !env.CARPAL_ADMIN_ORIGIN.startsWith('https://'))
      ctx.addIssue({ code: 'custom', path: ['CARPAL_ADMIN_ORIGIN'], message: 'must be https outside dev' });
  });

export type ServerEnv = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid admin console environment:\n${lines.join('\n')}`);
  }
  return result.data;
}

let cached: ServerEnv | undefined;
export function serverEnv(): ServerEnv {
  cached ??= parseEnv(process.env);
  return cached;
}
