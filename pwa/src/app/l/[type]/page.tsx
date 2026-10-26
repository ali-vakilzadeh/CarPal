// Link-token landing pages (GD-14, SEC-LT-2): /l/ev#<token> email verification and /l/pr#<token> password reset
// (P4.T3/T5). The token is in the fragment and is read in the browser. Review (ri), check-in (ci) and consent (cn)
// links arrive with their stages (P10, P11); until then they are 404.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FlowFrame } from '@/components/shell/flow-frame';
import { EmailVerifyPage, PasswordResetPage } from '@/features/auth';
import { serverI18n } from '@/server/i18n';
import { requestLocale } from '@/server/request-locale';

type Props = { params: Promise<{ type: string }> };

const PAGES = { ev: EmailVerifyPage, pr: PasswordResetPage } as const;
const TITLES = { ev: 'auth.link.evTitle', pr: 'auth.link.prTitle' } as const;

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
  const { t } = await serverI18n(locale);
  const Page = PAGES[type];
  return (
    <FlowFrame t={t} home={`/${locale}`}>
      <Page />
    </FlowFrame>
  );
}
