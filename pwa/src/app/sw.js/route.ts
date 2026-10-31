// /sw.js (P12.T2): the service worker — the committed bundle of src/sw/ (tools/build-sw.mjs) behind its settings.
// The version joins the bundle hash and the Next.js build id, so every new build is a new worker (the update flow
// of features/pwa). Demo builds (CARPAL_PWA_DEMO=1, E2E) may salt the version with the cp_sw_salt cookie to test an
// update without a rebuild. Served without caching and with a script-only CSP of its own (the worker's policy).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCALES } from '@/lib/i18n/locales';
import { serverEnv } from '@/server/env';
import type { WorkerConfig } from '@/sw/protocol';
import { SW_BUNDLE, SW_BUNDLE_HASH } from '@/sw/generated/bundle';

export const dynamic = 'force-dynamic';

let buildId: string | undefined;
function nextBuildId(): string {
  if (buildId === undefined) {
    try {
      buildId = readFileSync(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8')
        .trim()
        .slice(0, 40);
    } catch {
      buildId = 'dev';
    }
  }
  return buildId;
}

export function GET(req: Request): Response {
  const env = serverEnv();
  const salt = env.CARPAL_PWA_DEMO ? /(?:^|;\s*)cp_sw_salt=([A-Za-z0-9_-]{1,32})/.exec(req.headers.get('cookie') ?? '')?.[1] : undefined;
  const config: WorkerConfig = {
    version: [SW_BUNDLE_HASH, nextBuildId(), salt].filter(Boolean).join('-'),
    portalUrl: env.CARPAL_PWA_PORTAL_URL,
    locales: LOCALES,
  };
  return new Response(`self.__CARPAL_SW__=${JSON.stringify(config)};\n${SW_BUNDLE}\n`, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache, max-age=0',
      'service-worker-allowed': '/',
      'content-security-policy': "default-src 'self'; script-src 'self'",
      'x-content-type-options': 'nosniff',
    },
  });
}
