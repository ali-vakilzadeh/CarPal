// Link-token landing pages (GD-14, SEC-LT-2): /l/ev#<token> email verification and /l/pr#<token> password reset
// (P4.T3/T5), /l/ci#<token> appointment check-in (P10.T5; works for guests too, DI-23). The token is in the fragment
// and is read in the browser. /l/ri#<token> opens an emailed review invitation and /l/cn#<token> a showcase consent
// request (P11.T2/T4). /l/mi#<token> organization invitations (P12.T4: how a fleet driver joins).
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FlowFrame } from '@/components/shell/flow-frame';
import { CheckInLinkPage } from '@/features/appointments';
import { EmailVerifyPage, PasswordResetPage } from '@/features/auth';
import { InvitationLinkPage } from '@/features/fleet-driver';
import { ConsentLinkPage, InviteLinkPage } from '@/features/reviews';
import { I18nNamespaces } from '@/lib/i18n/client';
import { serverEnv } from '@/server/env';
import { serverI18n } from '@/server/i18n';
import { requestLocale } from '@/server/request-locale';

type Props = { params: Promise<{ type: string }> };

function ConsentPage() {
  return <ConsentLinkPage policyVersion={serverEnv().CARPAL_PWA_PRIVACY_VERSION} />;
}

const PAGES = {
  ev: EmailVerifyPage,
  pr: PasswordResetPage,
  ci: CheckInLinkPage,
  ri: InviteLinkPage,
  cn: ConsentPage,
  mi: InvitationLinkPage,
} as const;
const TITLES = {
  ev: 'auth.link.evTitle',
  pr: 'auth.link.prTitle',
  ci: 'appointments.checkIn.title',
  ri: 'reviews.invite.title',
  cn: 'reviews.consent.title',
  mi: 'driver.invite.title',
} as const;

function isType(v: string): v is keyof typeof PAGES {
  return v in PAGES;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { type } = await params;
  if (!isType(type)) return {};
  const { t } = await serverI18n(await requestLocale());
  return { title: t(TITLES[type]) };
}

export default async function LinkPage({ params }: Props) {
  const { type } = await params;
  if (!isType(type)) notFound();
  const locale = await requestLocale();
  const i18n = await serverI18n(locale);
  const Page = PAGES[type];
  return (
    <I18nNamespaces resources={i18n.resources(['appointments', 'reviews', 'media', 'driver'])}>
      <FlowFrame t={i18n.t} home={`/${locale}`}>
        <Page />
      </FlowFrame>
    </I18nNamespaces>
  );
}
