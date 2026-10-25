// W-SYS-01 "No access" for forbidden() thrown by a localized page (experimental.authInterrupts): status 403,
// noindex, with "Switch account" and the way home.
import type { Metadata } from 'next';
import { getTranslator } from '@/lib/i18n/dictionary';
import { SystemPage, systemMetaTitle } from '@/components/shell/system-page';
import { requestLocale } from '@/server/request-locale';

export async function generateMetadata(): Promise<Metadata> {
  const t = getTranslator(await requestLocale());
  return { title: systemMetaTitle('no-access', t), robots: { index: false } };
}

export default async function Forbidden() {
  const locale = await requestLocale();
  const t = getTranslator(locale);
  return <SystemPage kind="no-access" locale={locale} t={t} />;
}
