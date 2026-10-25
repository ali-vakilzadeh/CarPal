// W-SYS-01 System pages served by the proxy's status rewrite (src/server/system-status.ts): 410, 503 maintenance and
// the 404/403 a proxy check decides. Reached only through that rewrite (it sets x-carpal-system); a direct visit to
// /<locale>/system/<kind> is a plain 404.
import type { Metadata } from 'next';
import { getTranslator } from '@/lib/i18n/dictionary';
import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { SystemPage, isSystemKind, systemMetaTitle } from '@/components/shell/system-page';
import { DEFAULT_TIME_ZONE, TIME_ZONE_COOKIE, validTimeZone } from '@/lib/format';
import { isLocale } from '@/lib/i18n/locales';
import { MAINTENANCE_UNTIL_HEADER, SYSTEM_HEADER } from '@/server/system-status';

type Props = { params: Promise<{ locale: string; kind: string }> };

async function resolve(params: Props['params']) {
  const { locale, kind } = await params;
  const marked = (await headers()).get(SYSTEM_HEADER);
  if (!isLocale(locale) || !isSystemKind(kind) || marked !== kind) notFound();
  return { locale, kind };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, kind } = await resolve(params);
  const t = getTranslator(locale);
  return { title: systemMetaTitle(kind, t), robots: { index: false, follow: false } };
}

export default async function SystemRoute({ params }: Props) {
  const { locale, kind } = await resolve(params);
  const t = getTranslator(locale);
  const until = (await headers()).get(MAINTENANCE_UNTIL_HEADER);
  const timeZone = validTimeZone((await cookies()).get(TIME_ZONE_COOKIE)?.value) ?? DEFAULT_TIME_ZONE;
  return <SystemPage kind={kind} locale={locale} t={t} until={until} timeZone={timeZone} />;
}
