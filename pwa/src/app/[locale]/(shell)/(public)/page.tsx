// W-PUB-01 Landing Page (P5.T2): explain CarPal in five seconds and get the visitor to a useful search or sign-up — hero
// with Your car + What's wrong → search (P6 runs it), How it works, Trust explained with "How ranking works", popular
// specialists in the chosen city (search.run, chosen_city), recent showcases (feed.discover), For businesses.
// States: no city chosen (the city picker is the first field of its section); no providers in the city ("We're
// launching in Tehran first" + sign-up). Signed-in visitors go to their home (server when the cookie is present,
// SignedInRedirect otherwise, P4.T7). SEO: title and description per language, Organization JSON-LD, hreflang.
// Backend reads per view and city (cached 60 s): search.run, feed.discover (both the search bucket, DI-26).
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { buttonClass } from '@/components/ds/button';
import { Icon, type IconName } from '@/components/ds/icon';
import { SignedInRedirect } from '@/components/shell/signed-in-redirect';
import { buildLoginUrl } from '@/lib/api/login-url';
import { CITY_COOKIE, CityPicker, LandingHero, RememberCity, ShowcaseTeasers, showcaseTeasers } from '@/features/landing';
import { OrgCard } from '@/features/profiles';
import { I18nNamespaces } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverEnv } from '@/server/env';
import { serverSession } from '@/server/session';
import { pageContext } from '@/server/ssr/page-context';
import { publicList } from '@/server/ssr/public-reads';
import { JsonLd } from '@/server/ssr/seo/json-ld';
import { pageMetadata } from '@/server/ssr/seo/metadata';
import { siteOrganization } from '@/server/ssr/seo/schema';

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const POPULAR = 6;

const STEPS: { icon: IconName; title: MessageKey; text: MessageKey }[] = [
  { icon: 'car', title: 'landing.how.car', text: 'landing.how.carText' },
  { icon: 'chat', title: 'landing.how.problem', text: 'landing.how.problemText' },
  { icon: 'shield', title: 'landing.how.match', text: 'landing.how.matchText' },
];
const TRUST: { icon: IconName; title: MessageKey; text: MessageKey }[] = [
  { icon: 'shield', title: 'landing.trust.verified', text: 'landing.trust.verifiedText' },
  { icon: 'wrench', title: 'landing.trust.specialist', text: 'landing.trust.specialistText' },
  { icon: 'check', title: 'landing.trust.visit', text: 'landing.trust.visitText' },
];

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = await localeOf(params);
  const ctx = await pageContext(locale);
  return pageMetadata({
    locale,
    path: `/${locale}`,
    title: ctx.t('landing.metaTitle'),
    description: ctx.t('landing.metaDescription'),
    siteName: ctx.siteName,
  });
}

export default async function LandingPage({ params, searchParams }: Props) {
  const locale = await localeOf(params);
  if ((await serverSession()).view.signed_in) redirect(`/${locale}/home`);
  const [ctx, sp, cookieStore] = await Promise.all([pageContext(locale), searchParams, cookies()]);
  const { t, f } = ctx;
  const cities = ctx.region.cities.map((c) => ({ key: c.city_key, label: c.label.text }));
  const asked = typeof sp.city === 'string' ? sp.city : cookieStore.get(CITY_COOKIE)?.value;
  const city = cities.find((c) => c.key === asked) ?? null;

  const location = city ? ({ mode: 'chosen_city', city_key: city.key } as const) : null;
  const [search, feed] = location
    ? await Promise.all([
        publicList(locale, 'search.run', { body: { search_mode: 'providers', entry_point: 'directory_page', location, limit: POPULAR } }),
        publicList(locale, 'feed.discover', { body: { location, limit: 20 } }),
      ])
    : [null, null];
  const popular = search?.results.slice(0, POPULAR) ?? [];
  const teasers = showcaseTeasers(feed?.items ?? []);
  const signupHref = buildLoginUrl({ returnTo: `/${locale}`, locale, screen: 'signup' });

  return (
    <I18nNamespaces resources={ctx.i18n.resources(['landing', 'profiles'])}>
      <JsonLd data={siteOrganization(ctx.origin, ctx.siteName, t('landing.metaDescription'))} />
      <SignedInRedirect to={`/${locale}/home`} />
      <RememberCity city={city?.key ?? null} />
      <div className="pwa-landing">
        <section className="pwa-hero" aria-labelledby="hero-title">
          <h1 id="hero-title" className="pwa-text-title m-0">
            {t('landing.hero.headline')}
          </h1>
          <LandingHero city={city?.key ?? null} />
        </section>

        <section className="pwa-landing-section" aria-labelledby="how-title">
          <h2 id="how-title" className="pwa-text-h2 m-0">
            {t('landing.how.title')}
          </h2>
          <ol className="pwa-plain-list pwa-how-list">
            {STEPS.map((s, i) => (
              <li key={s.title} className="pwa-how-item">
                <span className="pwa-tile" aria-hidden="true">
                  <Icon name={s.icon} size={20} />
                </span>
                <span className="pwa-stack-xs">
                  <span className="pwa-text-label">
                    {f.number(i + 1)}. {t(s.title)}
                  </span>
                  <span className="pwa-text-caption">{t(s.text)}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="pwa-landing-section" aria-labelledby="trust-title">
          <h2 id="trust-title" className="pwa-text-h2 m-0">
            {t('landing.trust.title')}
          </h2>
          <ul className="pwa-plain-list pwa-how-list">
            {TRUST.map((s) => (
              <li key={s.title} className="pwa-how-item">
                <span className="pwa-tile" aria-hidden="true">
                  <Icon name={s.icon} size={20} />
                </span>
                <span className="pwa-stack-xs">
                  <span className="pwa-text-label">{t(s.title)}</span>
                  <span className="pwa-text-caption">{t(s.text)}</span>
                </span>
              </li>
            ))}
          </ul>
          <a className="pwa-link" href={`/${locale}/how-ranking-works`}>
            {t('landing.trust.link')}
          </a>
        </section>

        <section className="pwa-landing-section" aria-labelledby="popular-title">
          <div className="pwa-section-head">
            <h2 id="popular-title" className="pwa-text-h2 m-0">
              {t('landing.popular.title')}
            </h2>
            <CityPicker cities={cities} value={city?.key ?? null} />
          </div>
          {!city ? (
            <p className="pwa-text-caption">{t('landing.popular.chooseText')}</p>
          ) : popular.length === 0 ? (
            <div className="pwa-explain">
              <p className="pwa-text-label m-0">{t('landing.popular.emptyTitle')}</p>
              <p className="pwa-text-caption">{t('landing.popular.emptyText')}</p>
              <a href={signupHref} className={buttonClass({ variant: 'primary', size: 'sm' })}>
                <span className="cp-btn-label">{t('landing.popular.notify')}</span>
              </a>
            </div>
          ) : (
            <ul className="pwa-plain-list pwa-card-grid">
              {popular.map((r) => (
                <li key={r.result_id}>
                  <OrgCard org={r.organization} locale={locale} t={t} f={f} detail={r.location?.city ?? null} />
                </li>
              ))}
            </ul>
          )}
        </section>

        {teasers.length ? (
          <section className="pwa-landing-section" aria-labelledby="showcases-title">
            <h2 id="showcases-title" className="pwa-text-h2 m-0">
              {t('landing.showcases.title')}
            </h2>
            <ShowcaseTeasers items={teasers} locale={locale} t={t} />
          </section>
        ) : null}

        <section className="pwa-landing-section pwa-explain" aria-labelledby="business-title">
          <h2 id="business-title" className="pwa-text-h2 m-0">
            {t('landing.business.title')}
          </h2>
          <p className="pwa-text-body">{t('landing.business.text')}</p>
          <a href={serverEnv().CARPAL_PWA_PORTAL_SIGNUP_URL} className={buttonClass({ variant: 'secondary' })} rel="noopener">
            <Icon name="store" size={20} />
            <span className="cp-btn-label">{t('landing.business.cta')}</span>
          </a>
        </section>
      </div>
    </I18nNamespaces>
  );
}
