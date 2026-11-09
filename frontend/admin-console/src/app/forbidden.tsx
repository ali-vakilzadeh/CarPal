// 403 (AC1.T5, experimental.authInterrupts): rendered when a page calls forbidden(). AC4.T6 adds the role the
// section needs; "Request access" stays text only until BR-10.
import type { Metadata } from 'next';
import { SystemPage, systemMetaTitle } from '@/components/shell/system-page';
import { getTranslator } from '@/lib/i18n/dictionary';
import { requestLocale } from '@/server/request-locale';

export async function generateMetadata(): Promise<Metadata> {
  return { title: systemMetaTitle('forbidden', getTranslator(await requestLocale())) };
}

export default async function Forbidden() {
  return <SystemPage kind="forbidden" t={getTranslator(await requestLocale())} />;
}
