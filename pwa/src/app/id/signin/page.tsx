// W-AUTH-01 Sign In / Sign Up — the hosted sign-in page (GD-05, P4.T1; mirrors S-AUTH-02, 03, 07, 08, 09). The auth
// host redirects here with ?interaction_id=…&ui_locales=…; the steps run in the browser (src/features/auth).
import { FlowFrame } from '@/components/shell/flow-frame';
import { HostedSignIn } from '@/features/auth';
import { LOCALES } from '@/lib/i18n/locales';
import { serverEnv } from '@/server/env';
import { hostedSigninContext } from '@/server/hosted-signin';
import { serverI18n } from '@/server/i18n';
import { requestLocale } from '@/server/request-locale';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function HostedSignInPage({ searchParams }: Props) {
  const [sp, locale] = await Promise.all([searchParams, requestLocale()]);
  const { t } = await serverI18n(locale);
  const ctx = await hostedSigninContext(sp.interaction_id);
  const env = serverEnv();
  // Switching the language reloads the page with the same interaction in the other language.
  const languages = ctx.interactionId
    ? LOCALES.map((l) => ({
        locale: l,
        href: `/id/signin?${new URLSearchParams({ interaction_id: ctx.interactionId!, ui_locales: l }).toString()}`,
        current: l === locale,
      }))
    : undefined;
  return (
    <FlowFrame t={t} home={`/${locale}`} languages={languages}>
      <HostedSignIn
        interactionId={ctx.interactionId}
        resumeUrl={ctx.resumeUrl}
        restartUrl={ctx.restartUrl}
        screen={ctx.screen}
        context={ctx.context}
        termsVersion={env.CARPAL_PWA_TERMS_VERSION}
        privacyVersion={env.CARPAL_PWA_PRIVACY_VERSION}
      />
    </FlowFrame>
  );
}
