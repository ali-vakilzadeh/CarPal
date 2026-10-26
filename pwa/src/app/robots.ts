// robots.txt (P5.T1, Docs/22 §6): public pages are crawlable; signed-in tools, the hosted sign-in, link pages and the
// BFF are not (they also answer noindex, GD-15). Search and map pages stay crawlable so crawlers see their noindex.
import type { MetadataRoute } from 'next';
import { LOCALES } from '@/lib/i18n/locales';
import { serverEnv } from '@/server/env';
import { PRIVATE_SECTIONS } from '@/server/security-headers';

// Request time, not build time: the sitemap URL names the deployment's origin (CARPAL_PWA_ORIGIN).
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const origin = serverEnv().CARPAL_PWA_ORIGIN;
  const disallow = ['/api/', '/bff/', '/id/', '/l/', ...LOCALES.flatMap((l) => [...PRIVATE_SECTIONS].map((s) => `/${l}/${s}`))];
  return { rules: [{ userAgent: '*', allow: '/', disallow }], sitemap: `${origin}/sitemap.xml` };
}
