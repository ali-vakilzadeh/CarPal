// W-PUB-03 Public Vendor Profile (mirrors C-VEND-01; P5.T4) at /<locale>/parts-seller/<slug>: header band (seller type,
// pickup/delivery, Verified Business, Follow), Overview, Parts (search within the seller, filters, grid), Fitment
// coverage, Reviews with the seller sub-ratings, Location; the right rail holds "Ask about a part", hours and the map
// preview. Public prices only: server rendering never asks for trade prices, and the page only notes "Trade prices for
// verified businesses". AutoPartsStore JSON-LD. Backend reads per view (cached 60 s): public.org_get,
// public.org_inventory_search, public.org_reviews (DI-26).
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SystemPage } from '@/components/shell/system-page';
import {
  FitmentCoverage,
  LocationHours,
  OrgHeader,
  OrgIntentHandlers,
  ProfileViewed,
  RatingSummaryView,
  ReviewList,
  Section,
  SectionMenu,
  VendorOverview,
  VendorParts,
  orgTypeLabel,
  primaryLocation,
  type SectionLink,
} from '@/features/profiles';
// Deep import: the public page needs only the button, not the review screens of the barrel.
import { WriteReviewButton } from '@/features/reviews/write-button';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { sellerPath } from '@/lib/seo/urls';
import { pageContext } from '@/server/ssr/page-context';
import { firstReviews, loadOrg } from '@/server/ssr/profiles';
import { JsonLd } from '@/server/ssr/seo/json-ld';
import { metaDescription, pageMetadata, unavailableMetadata } from '@/server/ssr/seo/metadata';
import { localBusiness } from '@/server/ssr/seo/schema';
import { firstParts, partCategories } from '@/server/ssr/vendors';

type Props = { params: Promise<{ locale: string; slug: string }> };

async function resolve(params: Props['params']): Promise<{ locale: Locale; slug: string }> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  return { locale, slug: decodeURIComponent(slug) };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await resolve(params);
  const [page, ctx] = await Promise.all([loadOrg(locale, slug, 'vendor'), pageContext(locale)]);
  const { t, f } = ctx;
  if (page.kind === 'unavailable') return unavailableMetadata(t('system.suspended.metaTitle'));
  const p = page.profile;
  const city = primaryLocation(p)?.address.city ?? t('profiles.meta.noLocationCity');
  const count = p.rating_summary.count_visit_verified + p.rating_summary.count_approved_without_visit;
  const rating =
    p.rating_summary.overall && count
      ? t('profiles.meta.ratingSentence', { value: f.number(Number(p.rating_summary.overall), { maximumFractionDigits: 1 }), count })
      : '';
  const base = t('profiles.meta.sellerDescription', { name: p.name, type: orgTypeLabel(p, t, 'vendor'), city, rating });
  return pageMetadata({
    locale,
    path: sellerPath(locale, p.slug ?? slug),
    title: t('profiles.meta.sellerTitle', { name: p.name, city }),
    description: p.description ? `${metaDescription(p.description.text, 100)} ${base}` : base,
    image: p.logo_url ?? p.portfolio_thumbnail_url,
    siteName: ctx.siteName,
  });
}

export default async function VendorProfilePage({ params }: Props) {
  const { locale, slug } = await resolve(params);
  const [page, ctx] = await Promise.all([loadOrg(locale, slug, 'vendor'), pageContext(locale)]);
  const { t, f } = ctx;
  if (page.kind === 'unavailable') return <SystemPage kind="suspended" locale={locale} t={t} timeZone={ctx.timeZone} />;
  const p = page.profile;
  const vendorSlug = p.slug ?? slug;
  const path = sellerPath(locale, vendorSlug);
  const [reviews, parts] = await Promise.all([firstReviews(locale, p.id), firstParts(locale, p)]);
  const loc = primaryLocation(p);
  const sections: SectionLink[] = [
    { id: 'overview', label: t('profiles.sections.overview') },
    { id: 'parts', label: t('profiles.sections.parts') },
    { id: 'fitment', label: t('profiles.sections.fitment') },
    { id: 'reviews', label: t('profiles.sections.reviews') },
    { id: 'location', label: t('profiles.sections.location') },
  ];

  return (
    <I18nNamespaces resources={ctx.i18n.resources(['profiles'])}>
      <JsonLd data={localBusiness(p, `${ctx.origin}${path}`, p.description?.text ?? null, p.logo_url)} />
      <ProfileViewed orgId={p.id} targetType="vendor" />
      <OrgIntentHandlers orgId={p.id} name={p.name} />
      <div className="pwa-profile">
        <OrgHeader profile={p} as="vendor" path={path} t={t} f={f} />
        <SectionMenu sections={sections} label={t('profiles.sections.label')} />
        <Section id="overview" title={t('profiles.sections.overview')}>
          <VendorOverview profile={p} t={t} />
        </Section>
        <Section id="parts" title={t('profiles.sections.parts')}>
          {p.vendor?.trade_customers_supported ? <p className="pwa-text-caption">{t('profiles.vendor.tradeNote')}</p> : null}
          <VendorParts
            orgId={p.id}
            vendorSlug={vendorSlug}
            categories={partCategories(p)}
            initial={parts.page}
            initialCategory={parts.category}
          />
        </Section>
        <Section id="fitment" title={t('profiles.sections.fitment')}>
          {p.vendor ? <FitmentCoverage vendor={p.vendor} t={t} /> : <p className="pwa-text-body">{t('profiles.fitment.empty')}</p>}
        </Section>
        <Section id="reviews" title={t('profiles.sections.reviews')}>
          <div className="pwa-reviews-write">
            <WriteReviewButton orgId={p.id} slug={vendorSlug} name={p.name} as="vendor" />
          </div>
          <div className="pwa-reviews-cols">
            <RatingSummaryView summary={p.rating_summary} vendor />
            <ReviewList orgId={p.id} orgName={p.name} initial={reviews} vendor />
          </div>
        </Section>
        <Section id="location" title={t('profiles.sections.location')}>
          <LocationHours loc={loc} slug={p.slug} name={p.name} locale={locale} regionKey={ctx.region.region_key} t={t} f={f} />
        </Section>
      </div>
    </I18nNamespaces>
  );
}
