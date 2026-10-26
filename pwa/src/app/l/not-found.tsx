// W-SYS-01 "Not found" for an unknown link type under /l (the same page as for localized pages): Next.js 16 draws
// this boundary on the client inside the /l layout (status 404, noindex); see [locale]/not-found.tsx.
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
