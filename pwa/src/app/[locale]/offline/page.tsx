// W-SYS-01 Offline (P12.T2): the page the service worker answers with when the network is gone and it has no copy
// of the page asked for. Precached per locale without cookies (no session view in it); the list of pages saved on
// this device is read in the browser (features/pwa OfflineScreen). Reachable online too (the offline bar links it).
import type { Metadata } from 'next';
import { OfflineScreen } from '@/features/pwa';
import { isLocale } from '@/lib/i18n/locales';
import { serverI18n } from '@/server/i18n';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const { t } = await serverI18n(isLocale(locale) ? locale : 'fa');
  return { title: t('pwa.offline.title'), robots: { index: false, follow: false } };
}

export default function OfflinePage() {
  return <OfflineScreen />;
}
