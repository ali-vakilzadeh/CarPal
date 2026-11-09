// A-AUTH-01 Staff sign-in (AC4.T1/T2, GD-04): the auth host sends the browser here with ?interaction_id=…&ui_locales=…
// (the /id proxy rewrites <issuer>/signin to the console origin). The steps run in the browser
// (src/features/auth/staff-sign-in.tsx); this page gives them the interaction, where to resume and where to restart.
// Switching the language keeps the interaction.
import type { Metadata } from 'next';
import { PlainFrame } from '@/components/shell/plain-frame';
import { StaffSignIn } from '@/features/auth/staff-sign-in';
import { getTranslator } from '@/lib/i18n/dictionary';
import { LOCALES } from '@/lib/i18n/locales';
import { prefHref } from '@/lib/prefs';
import { signinContext } from '@/server/hosted-signin';
import { requestLocale } from '@/server/request-locale';
import { requestPath } from '@/server/staff-session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getTranslator(await requestLocale())('admin.signin.metaTitle') };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SigninPage({ searchParams }: Props) {
  const [sp, locale, path] = await Promise.all([searchParams, requestLocale(), requestPath()]);
  const ctx = await signinContext(sp.interaction_id);
  const languages = LOCALES.map((l) => ({ locale: l, href: prefHref(path, 'lang', l), current: l === locale }));
  return (
    <PlainFrame languages={languages} narrow>
      <StaffSignIn interactionId={ctx.interactionId} resumeUrl={ctx.resumeUrl} restartUrl={ctx.restartUrl} stepUp={ctx.stepUp} />
    </PlainFrame>
  );
}
