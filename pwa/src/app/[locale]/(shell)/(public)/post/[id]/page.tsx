// W-PUB-05 Showcase / Post Page (mirrors C-PROV-02 and C-COMM-02; P5.T6) at /<locale>/post/<id>-<slug>: a published
// before/after showcase (showcases.get, a provider's portfolio item). Consumer posts have no public read yet (DI-02;
// posts.public_list is per organization and behind community.feed.enabled), so this route shows showcases. The
// right rail (@rail) holds "Request similar service" and more from this provider; on smaller screens they follow the
// body. A wrong slug moves permanently to the canonical URL; a removed showcase (e.g. the customer withdrew consent)
// is the "no longer available" body with 200 + noindex (OQ-14; the backend answers 404 today, DI-37). Article and
// ImageObject JSON-LD; preview image = the after photo. Comments and reactions come in P8.
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import type { PublicPortfolioItem } from '@carpal/api-contracts';
import { SystemPage } from '@/components/shell/system-page';
import { RequestSimilarButton, Section, ShowcaseBody, ShowcaseCard, previewImage } from '@/features/profiles';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { orgPath, parseIdSlug, showcasePath, slugify } from '@/lib/seo/urls';
import { pageContext } from '@/server/ssr/page-context';
import { firstPortfolio } from '@/server/ssr/profiles';
import { publicRead, type Read } from '@/server/ssr/public-reads';
import { JsonLd } from '@/server/ssr/seo/json-ld';
import { metaDescription, pageMetadata, unavailableMetadata } from '@/server/ssr/seo/metadata';
import { showcaseArticle } from '@/server/ssr/seo/schema';

type Props = { params: Promise<{ locale: string; id: string }> };

async function loadShowcase(params: Props['params']): Promise<{ locale: Locale; read: Read<PublicPortfolioItem> }> {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const parsed = parseIdSlug(id);
  if (!parsed) notFound();
  const read = await publicRead(locale, 'showcases.get', { path: { item_id: parsed.id } });
  if (!read.ok) {
    if (read.missing === 'not_found') notFound();
    return { locale, read };
  }
  if (slugify(parsed.slug) !== slugify(read.data.title)) permanentRedirect(showcasePath(locale, read.data.id, read.data.title));
  return { locale, read };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, read } = await loadShowcase(params);
  const ctx = await pageContext(locale);
  const { t } = ctx;
  if (!read.ok) return unavailableMetadata(t('system.gone.metaTitle'));
  const item = read.data;
  const base = t('profiles.meta.showcaseDescription', {
    title: item.title,
    name: item.organization.name,
    system: item.service_system.text,
  });
  return pageMetadata({
    locale,
    path: showcasePath(locale, item.id, item.title),
    title: t('profiles.meta.showcaseTitle', { title: item.title, name: item.organization.name }),
    description: item.description ? `${metaDescription(item.description, 100)} ${base}` : base,
    image: previewImage(item.media) ?? item.organization.portfolio_thumbnail_url,
    type: 'article',
    siteName: ctx.siteName,
  });
}

export default async function ShowcasePage({ params }: Props) {
  const { locale, read } = await loadShowcase(params);
  const ctx = await pageContext(locale);
  const { t, f } = ctx;
  if (!read.ok) return <SystemPage kind="gone" locale={locale} t={t} timeZone={ctx.timeZone} />;
  const item = read.data;
  const path = showcasePath(locale, item.id, item.title);
  const author = orgPath(locale, item.organization);
  const more = (await firstPortfolio(locale, item.organization.id)).items.filter((x) => x.id !== item.id).slice(0, 4);
  return (
    <I18nNamespaces resources={ctx.i18n.resources(['profiles'])}>
      <JsonLd data={showcaseArticle(item, `${ctx.origin}${path}`, author ? `${ctx.origin}${author}` : null, ctx.siteName, ctx.origin)} />
      <div className="pwa-profile">
        <ShowcaseBody item={item} locale={locale} t={t} f={f} priority />
        <div className="pwa-profile-inline-request">
          <RequestSimilarButton orgId={item.organization.id} name={item.organization.name} />
        </div>
        {more.length ? (
          <Section
            id="more"
            title={t('profiles.showcase.moreFrom', { name: item.organization.name })}
            className="pwa-profile-inline-request"
          >
            <div className="pwa-showcase-grid">
              {more.map((x) => (
                <ShowcaseCard key={x.id} item={x} />
              ))}
            </div>
          </Section>
        ) : null}
      </div>
    </I18nNamespaces>
  );
}
