// The signed-in console (AC4.T3): every page in this group needs a staff session at aal3 (SEC-ADM-2). Without one the
// browser goes to the sign-in (/bff/login, back to the same page afterwards); a sign-in that just failed
// (?signin=<outcome> and still nobody signed in) goes to the signed-out page with the reason instead, so a refused
// sign-in never loops. A file-like path the proxy skipped (a browser asking for /favicon.ico) is a 404, never a
// sign-in: starting one would replace the auth host's interaction cookie and break a sign-in in progress in this
// browser (found in AC4). The shell is a client component; the session view the root layout seeded is its data.
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { EnvBadge } from '@/components/shell/env-badge';
import { isSigninOutcome } from '@/features/auth/problems';
import { AssistBanner } from '@/features/orgs/assist';
import { signedOutUrl } from '@/features/shell/idle';
import { ConsoleShell } from '@/features/shell/console-shell';
import { loginUrl } from '@/lib/api/session';
import { getTranslator } from '@/lib/i18n/dictionary';
import { serverEnv } from '@/server/env';
import { requestLocale, requestTheme } from '@/server/request-locale';
import { currentSession, proxiedPath } from '@/server/staff-session';

/** The path without ?signin=… (the outcome is shown once, never carried into the next sign-in). */
function withoutOutcome(path: string): { path: string; outcome: string | null } {
  const u = new URL(path, 'http://console.invalid');
  const outcome = u.searchParams.get('signin');
  u.searchParams.delete('signin');
  return { path: `${u.pathname}${u.search}`, outcome };
}

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const [session, raw, locale, theme] = await Promise.all([currentSession(), proxiedPath(), requestLocale(), requestTheme()]);
  if (raw === null) notFound();
  if (!session.signed_in) {
    const { path, outcome } = withoutOutcome(raw);
    redirect(isSigninOutcome(outcome) ? signedOutUrl(outcome, path) : loginUrl(path));
  }
  const t = getTranslator(locale);
  return (
    <ConsoleShell envBadge={<EnvBadge env={serverEnv().CARPAL_ADMIN_ENV} t={t} />} themeChoice={theme.choice}>
      {/* An assist session started in this tab stays visible on every page until it ends (AC9.T5, DI-08). */}
      <AssistBanner />
      {children}
    </ConsoleShell>
  );
}
