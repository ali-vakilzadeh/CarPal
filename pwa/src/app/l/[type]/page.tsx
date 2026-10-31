// Link-token landing pages (GD-14, SEC-LT-2): /l/ev#<token> email verification and /l/pr#<token> password reset
// (P4.T3/T5), /l/ci#<token> appointment check-in (P10.T5; works for guests too, DI-23). The token is in the fragment
// and is read in the browser. /l/mi#<token> organization invitations (P12.T4: how a fleet driver joins). Review (ri)
// and consent (cn) links arrive with P11; until then they are 404.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FlowFrame } from '@/components/shell/flow-frame';
import { CheckInLinkPage } from '@/features/appointments';
import { EmailVerifyPage, PasswordResetPage } from '@/features/auth';
import { InvitationLinkPage } from '@/features/fleet-driver';
import { I18nNamespaces } from '@/lib/i18n/client';
import { serverI18n } from '@/server/i18n';
import { requestLocale } from '@/server/request-locale';

type Props = { params: Promise<{ type: string }> };

const PAGES = { ev: EmailVerifyPage, pr: PasswordResetPage, ci: CheckInLinkPage, mi: InvitationLinkPage } as const;
const TITLES = { ev: 'auth.link.evTitle', pr: 'auth.link.prTitle', ci: 'appointments.checkIn.title', mi: 'driver.invite.title' } as const;

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
    <I18nNamespaces resources={i18n.resources(['appointments', 'driver'])}>
      <FlowFrame t={i18n.t} home={`/${locale}`}>
        <Page />
      </FlowFrame>
    </I18nNamespaces>
  );
}
