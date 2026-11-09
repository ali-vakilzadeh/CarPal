// 404 (AC1.T5): unmatched URLs render inside the root layout (no locale segment), so they keep lang/dir, the theme
// and the environment badge.
import type { Metadata } from 'next';
import { SystemPage, systemMetaTitle } from '@/components/shell/system-page';
import { getTranslator } from '@/lib/i18n/dictionary';
import { requestLocale } from '@/server/request-locale';

export async function generateMetadata(): Promise<Metadata> {
  return { title: systemMetaTitle('notFound', getTranslator(await requestLocale())) };
}

export default async function NotFound() {
  return <SystemPage kind="notFound" t={getTranslator(await requestLocale())} />;
}
