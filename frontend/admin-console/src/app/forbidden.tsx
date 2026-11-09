// 403 (AC1.T5, experimental.authInterrupts): the root fallback if forbidden() is ever called. Console pages do not call
// it: they render the no-permission state inside the shell (src/components/shell/console-states.tsx, AC4.T6, D-26).
import type { Metadata } from 'next';
import { PlainFrame } from '@/components/shell/plain-frame';
import { SystemPage, systemMetaTitle } from '@/components/shell/system-page';
import { getTranslator } from '@/lib/i18n/dictionary';
import { requestLocale } from '@/server/request-locale';

export async function generateMetadata(): Promise<Metadata> {
  return { title: systemMetaTitle('forbidden', getTranslator(await requestLocale())) };
}

export default async function Forbidden() {
  return (
    <PlainFrame>
      <SystemPage kind="forbidden" t={getTranslator(await requestLocale())} />
    </PlainFrame>
  );
}
