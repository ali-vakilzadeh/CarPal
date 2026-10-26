// Root layout of the hosted sign-in (/id/…, GD-05, P4.T1): the shared document without the app shell, in the language
// the authorize request named (ui_locales → x-carpal-locale, set by the proxy). Private: no-store and noindex.
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { requestLocale } from '@/server/request-locale';
import { serverEnv } from '@/server/env';
import { serverI18n } from '@/server/i18n';
import { RootDocument } from '../root-document';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverI18n(await requestLocale());
  return {
    metadataBase: new URL(serverEnv().CARPAL_PWA_ORIGIN),
    title: { default: t('auth.metaTitle'), template: `%s · ${t('common.appName')}` },
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function IdLayout({ children }: { children: ReactNode }) {
  return (
    <RootDocument locale={await requestLocale()} namespaces={['auth']}>
      {children}
    </RootDocument>
  );
}
