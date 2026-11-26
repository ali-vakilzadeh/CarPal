// CarPal Workshop / «کارپال تعمیرگاه» (frontend/provider-dev-plan.json D2, PRV-GD-01): the provider route group of
// the consumer PWA at /<locale>/provider. Its own frame (top bar with the business switch, bell and menu; bottom tabs
// Today · Requests · Replies · Photos) instead of the consumer shell; the business context comes from
// me.memberships_list (features/provider). The (app) group needs a session and a provider business; the entry page
// (PW-AUTH-01) and /start do not need a business.
import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';
import '@carpal/business-ui/styles.css';
import { WorkshopFrame, WorkshopProvider } from '@/features/provider';
import { I18nNamespaces } from '@/lib/i18n/client';
import { serverI18n } from '@/server/i18n';
import { localeOf, type LocaleParams } from './_shared';

export async function generateMetadata({ params }: { params: LocaleParams }): Promise<Metadata> {
  const { t } = await serverI18n(await localeOf(params));
  return {
    title: { default: t('provider.metaTitle'), template: `%s · ${t('provider.appName')}` },
    applicationName: t('provider.appName'),
    robots: { index: false, follow: false },
  };
}

export default async function WorkshopLayout({ children, params }: { children: ReactNode; params: LocaleParams }) {
  const i18n = await serverI18n(await localeOf(params));
  return (
    <I18nNamespaces resources={i18n.resources(['provider'])}>
      <Suspense>
        <WorkshopProvider>
          <WorkshopFrame>{children}</WorkshopFrame>
        </WorkshopProvider>
      </Suspense>
    </I18nNamespaces>
  );
}
