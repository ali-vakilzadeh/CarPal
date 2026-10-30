// W-NOTIF-01 Notifications (mirrors S-SHARED-04; P9.T1) at /<locale>/notifications[?tab=…], signed in (private).
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NotificationsScreen } from '@/features/notifications';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverI18n } from '@/server/i18n';

type Props = { params: Promise<{ locale: string }> };

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { t } = await serverI18n(await localeOf(params));
  return { title: t('shell.nav.notifications'), robots: { index: false, follow: false } };
}

// The notifications namespace is one of the client namespaces (the header bell renders the same texts).
export default function Page() {
  return (
    <Suspense>
      <NotificationsScreen />
    </Suspense>
  );
}
