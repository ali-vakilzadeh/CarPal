// /sitemap.xml: the sitemap index (P5.T1) of the per-kind sitemaps under /sitemaps/<kind>.xml.
import { sitemapIndexXml } from '@/server/ssr/seo/sitemap';
import { serverEnv } from '@/server/env';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response(sitemapIndexXml(serverEnv().CARPAL_PWA_ORIGIN), {
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}
