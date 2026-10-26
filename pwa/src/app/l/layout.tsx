// Root layout of link-token pages (/l/<type>#<token>, GD-14, SEC-LT-2): the shared document without the app shell, in
// the visitor's remembered or browser language (the proxy sets x-carpal-locale). Private: no-store and noindex.
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { serverEnv } from '@/server/env';
import { serverI18n } from '@/server/i18n';
import { requestLocale } from '@/server/request-locale';
import { RootDocument } from '../root-document';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverI18n(await requestLocale());
  return {
    metadataBase: new URL(serverEnv().CARPAL_PWA_ORIGIN),
    title: { default: t('common.appName'), template: `%s · ${t('common.appName')}` },
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function LinkLayout({ children }: { children: ReactNode }) {
  return (
    <RootDocument locale={await requestLocale()} namespaces={['auth']}>
      {children}
    </RootDocument>
  );
}
