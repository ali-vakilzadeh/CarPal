// W-PUB-04 Directory Page (P6.T7; mirrors C-SEARCH-01 pre-filtered): /<locale>/<city>/<category>[/<brand>] and
// /<locale>/<city>/<brand>, e.g. /fa/tehran/suspension/bmw. H1 ("BMW suspension specialists in Tehran"), an intro
// counted from structured data (shops, verified businesses, verified jobs — no AI text), series refinement chips on
// brand pages (?series=, never indexed), the ranked list with the same cards and match reasons as W-SRCH-01 (organic
// order only; the Featured block stays off), the map in the right rail (loaded after the list), related links
// (nearby cities, related categories, popular brands) and 3 related questions (qna.enabled). Fewer than 3 providers →
// noindex + "Widen your search". JSON-LD: ItemList + BreadcrumbList. Backend reads per view (cached 60 s): search.run
// (+ questions.search with Q&A on); taxonomy from the snapshot cache.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { buttonClass } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { StateView } from '@/components/shell/states';
import { DirectoryRequestHandler, RequestAction } from '@/features/directory/actions';
import {
  DIRECTORY_MIN_RESULTS,
  directoryPath,
  directoryStats,
  facetsPath,
  headingKind,
  indexable,
  type DirectoryFacets,
} from '@/features/directory/model';
import { ResultCardView } from '@/features/search/result-card';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import type { Translate } from '@/lib/i18n/keys';
import { orgPath, questionPath } from '@/lib/seo/urls';
import { brandSeries, directoryLinks, directoryResults, relatedQuestions, resolveDirectory } from '@/server/ssr/directory';
import { pageContext } from '@/server/ssr/page-context';
import { JsonLd } from '@/server/ssr/seo/json-ld';
import { pageMetadata } from '@/server/ssr/seo/metadata';
import { breadcrumbs, itemList } from '@/server/ssr/seo/schema';

type Props = {
  params: Promise<{ locale: string; city: string; facet: string; rest?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function load(props: Props) {
  const [{ locale: raw, city, facet, rest = [] }, sp] = await Promise.all([props.params, props.searchParams]);
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const ctx = await pageContext(locale);
  const series = typeof sp.series === 'string' ? sp.series : null;
  const resolved = await resolveDirectory(ctx, decodeURIComponent(city), decodeURIComponent(facet), rest.map(decodeURIComponent), series);
  if (resolved.kind !== 'ok') notFound();
  const results = await directoryResults(locale, resolved.facets);
  return { locale, ctx, facets: resolved.facets, results };
}

function heading(t: Translate, f: DirectoryFacets): string {
  const vars = {
    category: f.category?.name ?? '',
    brand: f.series ? `${f.brand?.name ?? ''} ${f.series.name}` : (f.brand?.name ?? ''),
    city: f.city.name,
  };
  return t(`directory.h1.${headingKind(f)}`, vars);
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { locale, ctx, facets, results } = await load(props);
  const title = heading(ctx.t, facets);
  const stats = directoryStats(results ?? []);
  return pageMetadata({
    locale,
    // A series refinement points to its brand page (never indexed itself).
    path: facetsPath(locale, facets),
    title: ctx.t('directory.metaTitle', { title }),
    description: ctx.t('directory.metaDescription', { title, shops: stats.shops, jobs: stats.jobs }),
    noindex: !indexable(results?.length ?? 0, facets),
    siteName: ctx.siteName,
  });
}

export default async function DirectoryPage(props: Props) {
  const { locale, ctx, facets, results } = await load(props);
  const { t, f } = ctx;
  const title = heading(t, facets);
  const list = results ?? [];
  const stats = directoryStats(list);
  const [links, questions, series] = await Promise.all([
    directoryLinks(locale, facets),
    relatedQuestions(locale, facets, ctx.flags['qna.enabled'] === true),
    facets.brand ? brandSeries(locale, facets.brand.id) : Promise.resolve([]),
  ]);
  const here = facetsPath(locale, facets);
  const crumbs = [
    { name: facets.city.name, url: `${ctx.origin}/${locale}` },
    ...(facets.category
      ? [{ name: facets.category.name, url: `${ctx.origin}${directoryPath(locale, facets.city.key, facets.category.slug)}` }]
      : []),
    ...(facets.brand ? [{ name: facets.brand.name, url: `${ctx.origin}${here}` }] : []),
  ];
  const few = list.length < DIRECTORY_MIN_RESULTS;
  const otherCities = ctx.region.cities.filter((c) => c.city_key !== facets.city.key);

  return (
    <I18nNamespaces resources={ctx.i18n.resources(['search', 'profiles'])}>
      <JsonLd data={breadcrumbs(crumbs)} />
      {list.length ? (
        <JsonLd
          data={itemList(
            title,
            `${ctx.origin}${here}`,
            list.flatMap((r) => {
              const href = orgPath(locale, r.organization);
              return href ? [{ name: r.organization.name, url: `${ctx.origin}${href}` }] : [];
            }),
          )}
        />
      ) : null}
      <DirectoryRequestHandler />
      <div className="pwa-directory">
        <nav aria-label={t('directory.breadcrumbs')} className="pwa-text-caption">
          <ol className="pwa-plain-list pwa-crumbs">
            <li>
              <a className="pwa-link" href={`/${locale}`}>
                {ctx.siteName}
              </a>
            </li>
            <li>{facets.city.name}</li>
            {facets.category ? (
              <li>
                {facets.brand ? (
                  <a className="pwa-link" href={directoryPath(locale, facets.city.key, facets.category.slug)}>
                    {facets.category.name}
                  </a>
                ) : (
                  facets.category.name
                )}
              </li>
            ) : null}
            {facets.brand ? <li>{facets.brand.name}</li> : null}
          </ol>
        </nav>
        <header className="pwa-stack-sm">
          <h1 className="pwa-text-title m-0">{title}</h1>
          {results === null ? null : (
            <p className="pwa-text-body m-0">
              {t('directory.intro', {
                count: stats.shops,
                verified: f.number(stats.verified),
                jobs: f.number(stats.jobs),
                city: facets.city.name,
              })}
            </p>
          )}
        </header>

        {series.length ? (
          <nav aria-label={t('directory.series')} className="pwa-stack-xs">
            <span className="pwa-text-caption">{t('directory.series')}</span>
            <ul className="pwa-plain-list pwa-chips">
              <li>
                <a
                  href={here}
                  className={cx('cp-chip', !facets.series && 'is-selected')}
                  aria-current={!facets.series ? 'page' : undefined}
                >
                  <span>{t('directory.allSeries')}</span>
                </a>
              </li>
              {series.map((s) => (
                <li key={s.id}>
                  <a
                    href={`${here}?series=${encodeURIComponent(s.slug)}`}
                    className={cx('cp-chip', facets.series?.id === s.id && 'is-selected')}
                    aria-current={facets.series?.id === s.id ? 'page' : undefined}
                    rel="nofollow"
                  >
                    <span dir="auto">{s.name.text}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}

        {results === null ? (
          <StateView
            kind="error"
            t={t}
            action={
              <a className={buttonClass({ variant: 'primary' })} href={here}>
                <span className="cp-btn-label">{t('common.actions.retry')}</span>
              </a>
            }
          />
        ) : (
          <section aria-labelledby="ranked-title" className="pwa-stack">
            <h2 id="ranked-title" className="pwa-text-h2 m-0">
              {t('directory.ranked')}
            </h2>
            <p className="pwa-text-caption m-0">
              {t('directory.organic')}{' '}
              <a className="pwa-link" href={`/${locale}/how-ranking-works`}>
                {t('search.result.howRanking')}
              </a>
            </p>
            {list.length ? (
              <ol className="pwa-plain-list pwa-results">
                {list.map((r) => (
                  <li key={r.result_id}>
                    <ResultCardView
                      r={r}
                      locale={locale}
                      t={t}
                      f={f}
                      bestMatch
                      actions={
                        <RequestAction orgId={r.organization.id} locationId={r.location?.location_id ?? null} name={r.organization.name} />
                      }
                    />
                  </li>
                ))}
              </ol>
            ) : null}
            {few ? (
              <div className="pwa-explain">
                <p className="pwa-text-label m-0">{t('directory.widenTitle')}</p>
                <p className="pwa-text-caption">{t('directory.widenText')}</p>
                <ul className="pwa-plain-list pwa-inline-actions">
                  {facets.brand && facets.category ? (
                    <li>
                      <a className={buttonClass({ size: 'sm' })} href={directoryPath(locale, facets.city.key, facets.category.slug)}>
                        <span className="cp-btn-label">
                          {t('directory.allBrands', { category: facets.category.name, city: facets.city.name })}
                        </span>
                      </a>
                    </li>
                  ) : null}
                  <li>
                    <a className={buttonClass({ size: 'sm' })} href={`/${locale}/map?city=${encodeURIComponent(facets.city.key)}`}>
                      <span className="cp-btn-label">{t('shell.header.browseOnMap')}</span>
                    </a>
                  </li>
                  <li>
                    <a className={buttonClass({ size: 'sm', variant: 'ghost' })} href={`/${locale}/help`}>
                      <span className="cp-btn-label">{t('search.helpMe.ask')}</span>
                    </a>
                  </li>
                </ul>
              </div>
            ) : null}
          </section>
        )}

        <section aria-labelledby="related-title" className="pwa-stack-sm">
          <h2 id="related-title" className="pwa-text-h2 m-0">
            {t('directory.related')}
          </h2>
          {facets.category || facets.brand ? (
            <LinkList
              title={t('directory.nearby')}
              items={otherCities.map((c) => ({
                href: directoryPath(
                  locale,
                  c.city_key,
                  facets.category?.slug ?? facets.brand?.slug,
                  facets.category ? facets.brand?.slug : null,
                ),
                label: c.label.text,
              }))}
            />
          ) : null}
          <LinkList
            title={t('directory.categories')}
            items={links.categories.map((c) => ({
              href: directoryPath(locale, facets.city.key, c.slug, facets.brand?.slug),
              label: c.name,
            }))}
          />
          {facets.category ? (
            <LinkList
              title={t('directory.brands')}
              items={links.brands.map((b) => ({
                href: directoryPath(locale, facets.city.key, facets.category!.slug, b.slug),
                label: b.name,
              }))}
            />
          ) : null}
        </section>

        {questions.length ? (
          <section aria-labelledby="questions-title" className="pwa-stack-sm">
            <h2 id="questions-title" className="pwa-text-h2 m-0">
              {t('directory.questions')}
            </h2>
            <ul className="pwa-plain-list pwa-stack-xs">
              {questions.map((q) => (
                <li key={q.id}>
                  <a className="pwa-link" href={questionPath(locale, q)} dir="auto">
                    {q.title}
                  </a>{' '}
                  <span className="pwa-text-caption">· {t('search.qna.answers', { count: q.answer_count })}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </I18nNamespaces>
  );
}

function LinkList({ title, items }: { title: string; items: { href: string; label: string }[] }) {
  if (!items.length) return null;
  return (
    <nav aria-label={title} className="pwa-stack-xs">
      <h3 className="pwa-text-label m-0">{title}</h3>
      <ul className="pwa-plain-list pwa-chips">
        {items.map((i) => (
          <li key={i.href}>
            <a className="cp-chip" href={i.href}>
              <span dir="auto">{i.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
