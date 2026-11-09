// 404 (AC1.T5): unmatched URLs outside the console sections render inside the root layout (no locale segment), so they
// keep lang/dir and the theme; the plain frame carries the environment badge (AC4). Unknown section paths render the
// console's own 404 inside the shell ((console)/not-found.tsx).
import type { Metadata } from 'next';
import { PlainFrame } from '@/components/shell/plain-frame';
import { SystemPage, systemMetaTitle } from '@/components/shell/system-page';
import { getTranslator } from '@/lib/i18n/dictionary';
import { requestLocale } from '@/server/request-locale';

export async function generateMetadata(): Promise<Metadata> {
  return { title: systemMetaTitle('notFound', getTranslator(await requestLocale())) };
}

export default async function NotFound() {
  return (
    <PlainFrame>
      <SystemPage kind="notFound" t={getTranslator(await requestLocale())} />
    </PlainFrame>
  );
}
