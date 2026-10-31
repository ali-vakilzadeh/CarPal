// /manifests/<locale>.webmanifest (P12.T1): the web app manifest of each page language (features/pwa/manifest.ts).
import { manifestFor } from '@/features/pwa';
import { isLocale } from '@/lib/i18n/locales';

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await params;
  const locale = file.endsWith('.webmanifest') ? file.slice(0, -'.webmanifest'.length) : '';
  if (!isLocale(locale)) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  return new Response(JSON.stringify(manifestFor(locale)), {
    headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}
