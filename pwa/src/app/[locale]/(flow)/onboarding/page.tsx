// W-ONB-01 Web Onboarding (P4.T6/T7; mirrors S-AUTH-04, C-ONB-01, C-ONB-02, S-AUTH-05): a centred stepper without
// the app shell. Every sign-in returns through here (?next=<page>): finished accounts go straight on. Private page
// (no-store, noindex via the proxy).
import type { Metadata } from 'next';
import { buttonClass } from '@/components/ds/button';
import { FlowFrame } from '@/components/shell/flow-frame';
import { Onboarding } from '@/features/onboarding';
import { safeNextPath } from '@/lib/api/login-url';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverEnv } from '@/server/env';
import { serverI18n } from '@/server/i18n';

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { t } = await serverI18n(await localeOf(params));
  return { title: t('onboarding.metaTitle'), robots: { index: false } };
}

export default async function OnboardingPage({ params, searchParams }: Props) {
  const [locale, sp] = await Promise.all([localeOf(params), searchParams]);
  const i18n = await serverI18n(locale);
  const t = i18n.t;
  // Never back into the onboarding itself.
  const asked = safeNextPath(typeof sp.next === 'string' ? sp.next : null);
  const next = asked && !asked.startsWith(`/${locale}/onboarding`) ? asked : `/${locale}/home`;
  const env = serverEnv();
  return (
    <I18nNamespaces resources={i18n.resources(['onboarding', 'auth'])}>
      <FlowFrame
        t={t}
        home={`/${locale}`}
        wide
        end={
          <a href={next} className={buttonClass({ variant: 'ghost', size: 'sm' })}>
            <span className="cp-btn-label">{t('onboarding.finishLater')}</span>
          </a>
        }
      >
        <Onboarding next={next} portalUrl={env.CARPAL_PWA_PORTAL_SIGNUP_URL} policyVersion={env.CARPAL_PWA_PRIVACY_VERSION} />
      </FlowFrame>
    </I18nNamespaces>
  );
}
