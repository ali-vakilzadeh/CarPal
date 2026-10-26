// /sitemaps/<kind>.xml (P5.T1): one sitemap per page kind, built from public reads and cached (src/server/ssr/seo/sitemap.ts).
import { isSitemapKind, sitemaps, urlsetXml } from '@/server/ssr/seo/sitemap';
import { serverEnv } from '@/server/env';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await params;
  const kind = file.endsWith('.xml') ? file.slice(0, -4) : '';
  if (!isSitemapKind(kind)) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  const entries = await sitemaps.entries(kind);
  return new Response(urlsetXml(serverEnv().CARPAL_PWA_ORIGIN, entries), {
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}
