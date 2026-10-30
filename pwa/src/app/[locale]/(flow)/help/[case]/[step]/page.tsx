// W-HELP-01 Help Me wizard (P10.T1): /<locale>/help/<case>/<step> — every step its own URL so refresh and Back work
// (Docs/22). The case id names this browser's case (features/help/store.ts), which holds the triage session id; the
// URL never carries text (GD-14). Signed-in only (the session gate sends guests to sign in and back). Private page.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FlowFrame } from '@/components/shell/flow-frame';
import { SessionGate } from '@/components/shell/session-gate';
import { HelpExit, HelpWizard, isHelpStep } from '@/features/help';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverEnv } from '@/server/env';
import { mapStyleUrl } from '@/server/map-config';
import { pageContext } from '@/server/ssr/page-context';
import { chosenCity } from '@/server/ssr/search';
import { HELP_NAMESPACES } from '../../namespaces';

type Props = { params: Promise<{ locale: string; case: string; step: string }> };

const CASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const ctx = await pageContext(await localeOf(params));
  return { title: ctx.t('help.metaTitle'), robots: { index: false, follow: false } };
}

export default async function HelpStepPage({ params }: Props) {
  const [locale, p] = await Promise.all([localeOf(params), params]);
  if (!CASE_ID.test(p.case) || !isHelpStep(p.step)) notFound();
  const ctx = await pageContext(locale);
  const { city } = await chosenCity(ctx);
  return (
    <I18nNamespaces resources={ctx.i18n.resources(HELP_NAMESPACES)}>
      <FlowFrame t={ctx.t} home={`/${locale}`} full end={<HelpExit saved />}>
        <SessionGate>
          <HelpWizard
            caseId={p.case.toLowerCase()}
            step={p.step}
            defaultCity={city}
            styleUrl={mapStyleUrl(ctx.region)}
            policyVersion={serverEnv().CARPAL_PWA_PRIVACY_VERSION}
          />
        </SessionGate>
      </FlowFrame>
    </I18nNamespaces>
  );
}
