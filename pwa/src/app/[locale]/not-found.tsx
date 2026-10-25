// W-SYS-01 "Not found" for notFound() thrown by a localized page. Next.js 16 server-renders such a 404 as an empty
// error shell and draws this boundary on the client inside the locale layout (status 404, noindex); unmatched URLs
// are server-rendered by app/global-not-found.tsx instead (see the P1 report).
import type { Metadata } from 'next';
import { getTranslator } from '@/lib/i18n/dictionary';
import { SystemPage, systemMetaTitle } from '@/components/shell/system-page';
import { requestLocale } from '@/server/request-locale';

export async function generateMetadata(): Promise<Metadata> {
  const t = getTranslator(await requestLocale());
  return { title: systemMetaTitle('not-found', t), robots: { index: false } };
}

export default async function NotFound() {
  const locale = await requestLocale();
  const t = getTranslator(locale);
  return <SystemPage kind="not-found" locale={locale} t={t} />;
}
