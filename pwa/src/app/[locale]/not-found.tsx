// 404 for notFound() thrown by a localized page. Next.js 16 server-renders such a 404 as an empty error shell and
// draws this boundary on the client inside the locale layout; unmatched URLs are server-rendered by
// app/global-not-found.tsx instead (see the P1 report).
import type { Metadata } from 'next';
import { NotFoundContent } from '@/components/shell/not-found-content';
import { getTranslator } from '@/lib/i18n/dictionary';
import { requestLocale } from '@/server/request-locale';

export async function generateMetadata(): Promise<Metadata> {
  const t = getTranslator(await requestLocale());
  return { title: t('common.notFound.title'), robots: { index: false } };
}

export default async function NotFound() {
  return <NotFoundContent locale={await requestLocale()} />;
}
