// W-SYS-01 "Not found" for URLs that match no route (experimental.globalNotFound). The root layout lives under the
// dynamic [locale] segment, so this page renders its own document: language and direction from the proxy's
// x-carpal-locale header, theme from the cookie, and the design-system styles. No client providers: the page is
// static HTML with links only.
import type { Metadata } from 'next';
import { getTranslator } from '@/lib/i18n/dictionary';
import { cookies } from 'next/headers';
import { SystemPage, systemMetaTitle } from '@/components/shell/system-page';
import { DS_STYLESHEETS } from '@/lib/design-system';
import { directionOf } from '@/lib/i18n/locales';
import { THEME_COOKIE, themeOrDefault } from '@/lib/theme';
import { requestLocale } from '@/server/request-locale';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = getTranslator(await requestLocale());
  return { title: `${systemMetaTitle('not-found', t)} · ${t('common.appName')}`, robots: { index: false } };
}

export default async function GlobalNotFound() {
  const locale = await requestLocale();
  const t = getTranslator(locale);
  const theme = themeOrDefault((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang={locale} dir={directionOf(locale)} data-theme={theme}>
      <head>
        {DS_STYLESHEETS.map((href) => (
          <link key={href} rel="stylesheet" href={href} precedence="design-system" />
        ))}
      </head>
      <body>
        <SystemPage kind="not-found" locale={locale} t={t} />
      </body>
    </html>
  );
}
