// 404 for URLs that match no route (experimental.globalNotFound). The root layout lives under the dynamic [locale]
// segment, so this page renders its own document: language and direction from the proxy's x-carpal-locale header,
// theme from the cookie, and the design-system styles.
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { NotFoundContent } from '@/components/shell/not-found-content';
import { DS_STYLESHEETS } from '@/lib/design-system';
import { getTranslator } from '@/lib/i18n/dictionary';
import { directionOf } from '@/lib/i18n/locales';
import { THEME_COOKIE, themeOrDefault } from '@/lib/theme';
import { requestLocale } from '@/server/request-locale';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = getTranslator(await requestLocale());
  return { title: `${t('common.notFound.title')} · ${t('common.appName')}`, robots: { index: false } };
}

export default async function GlobalNotFound() {
  const locale = await requestLocale();
  const theme = themeOrDefault((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang={locale} dir={directionOf(locale)} data-theme={theme}>
      <head>
        {DS_STYLESHEETS.map((href) => (
          <link key={href} rel="stylesheet" href={href} precedence="design-system" />
        ))}
      </head>
      <body>
        <NotFoundContent locale={locale} />
      </body>
    </html>
  );
}
