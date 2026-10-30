// W-PUB-02 Public Provider Profile (mirrors C-PROV-01; P5.T3): the shop's public trust page at /<locale>/shop/<slug>,
// server-rendered and indexable — header band, anchored sections with a sticky section menu (Overview, Services &
// Capabilities, Portfolio, Reviews, Location & Hours, Q&A when the flag is on) and the Request card (right rail from
// 1200 px, the @rail slot; inline below that). LocalBusiness/AutoRepair JSON-LD with the AggregateRating of both
// review paths, canonical and hreflang per language, preview image = cover. Backend reads per view (cached 60 s):
// public.org_get, public.org_reviews, public.org_portfolio, public.availability (DI-26).
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SystemPage } from '@/components/shell/system-page';
import {
  Capabilities,
  LocationHours,
  OrgHeader,
  OrgIntentHandlers,
  Portfolio,
  ProfileViewed,
  ProviderOverview,
  RatingSummaryView,
  RequestCard,
  ReviewList,
  Section,
  SectionMenu,
  orgTypeLabel,
  primaryLocation,
  topCapability,
  type SectionLink,
} from '@/features/profiles';
// Deep import: the public page needs only the button, not the review screens of the barrel.
import { WriteReviewButton } from '@/features/reviews/write-button';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { shopPath } from '@/lib/seo/urls';
import { pageContext, type PageContext } from '@/server/ssr/page-context';
import { firstPortfolio, firstReviews, loadOrg, nextSlots, todayHours } from '@/server/ssr/profiles';
import { JsonLd } from '@/server/ssr/seo/json-ld';
import { metaDescription, pageMetadata, unavailableMetadata } from '@/server/ssr/seo/metadata';
import { localBusiness } from '@/server/ssr/seo/schema';
import type { PublicOrgProfile } from '@carpal/api-contracts';

type Props = { params: Promise<{ locale: string; slug: string }> };

async function resolve(params: Props['params']): Promise<{ locale: Locale; slug: string }> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  return { locale, slug: decodeURIComponent(slug) };
}

function titleOf(p: PublicOrgProfile, ctx: PageContext): string {
  const { t } = ctx;
  const city = primaryLocation(p)?.address.city ?? t('profiles.meta.noLocationCity');
  const top = topCapability(p.provider?.capabilities ?? []);
  if (top && (top.confidence_level === 'strong_evidence' || top.confidence_level === 'verified_expert')) {
    const specialty = top.brand
      ? t('profiles.meta.specialty', { brand: top.brand.text, system: top.service_system.text })
      : t('profiles.meta.systemSpecialty', { system: top.service_system.text });
    return t('profiles.meta.shopTitle', { name: p.name, specialty, city });
  }
  return t('profiles.meta.shopTitleShort', { name: p.name, type: orgTypeLabel(p, t, 'provider'), city });
}

function descriptionOf(p: PublicOrgProfile, ctx: PageContext): string {
  const { t, f } = ctx;
  const count = p.rating_summary.count_visit_verified + p.rating_summary.count_approved_without_visit;
  const rating =
    p.rating_summary.overall && count
      ? t('profiles.meta.ratingSentence', { value: f.number(Number(p.rating_summary.overall), { maximumFractionDigits: 1 }), count })
      : '';
  const base = t('profiles.meta.shopDescription', {
    name: p.name,
    type: orgTypeLabel(p, t, 'provider'),
    city: primaryLocation(p)?.address.city ?? t('profiles.meta.noLocationCity'),
    rating,
  });
  return p.description ? `${metaDescription(p.description.text, 100)} ${base}` : base;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await resolve(params);
  const [page, ctx] = await Promise.all([loadOrg(locale, slug, 'provider'), pageContext(locale)]);
  if (page.kind === 'unavailable') return unavailableMetadata(ctx.t('system.suspended.metaTitle'));
  const p = page.profile;
  return pageMetadata({
    locale,
    path: shopPath(locale, p.slug ?? slug),
    title: titleOf(p, ctx),
    description: descriptionOf(p, ctx),
    image: p.portfolio_thumbnail_url ?? p.logo_url,
    siteName: ctx.siteName,
  });
}

export default async function ProviderProfilePage({ params }: Props) {
  const { locale, slug } = await resolve(params);
  const [page, ctx] = await Promise.all([loadOrg(locale, slug, 'provider'), pageContext(locale)]);
  const { t, f } = ctx;
  if (page.kind === 'unavailable') return <SystemPage kind="suspended" locale={locale} t={t} timeZone={ctx.timeZone} />;
  const p = page.profile;
  const path = shopPath(locale, p.slug ?? slug);
  const [reviews, portfolio, slots] = await Promise.all([firstReviews(locale, p.id), firstPortfolio(locale, p.id), nextSlots(locale, p)]);
  const loc = primaryLocation(p);
  const provider = p.provider;
  const qna = ctx.flags['qna.enabled'] === true;
  const sections: SectionLink[] = [
    { id: 'overview', label: t('profiles.sections.overview') },
    ...(provider ? [{ id: 'services', label: t('profiles.sections.services') }] : []),
    { id: 'portfolio', label: t('profiles.sections.portfolio') },
    { id: 'reviews', label: t('profiles.sections.reviews') },
    { id: 'location', label: t('profiles.sections.location') },
    ...(qna ? [{ id: 'qna', label: t('profiles.sections.qna') }] : []),
  ];
  const description = p.description?.text ?? null;

  return (
    <I18nNamespaces resources={ctx.i18n.resources(['profiles'])}>
      <JsonLd data={localBusiness(p, `${ctx.origin}${path}`, description, p.portfolio_thumbnail_url)} />
      <ProfileViewed orgId={p.id} targetType="provider" />
      <OrgIntentHandlers orgId={p.id} name={p.name} />
      <div className="pwa-profile">
        <OrgHeader profile={p} as="provider" path={path} t={t} f={f} />
        <div className="pwa-profile-inline-request">
          <RequestCard
            orgId={p.id}
            slug={p.slug ?? slug}
            name={p.name}
            rating={p.rating_summary.overall}
            locationId={loc?.id ?? null}
            capabilities={provider?.capabilities ?? []}
            slots={slots}
            todayHours={todayHours(p, locale, ctx.region.region_key, t, f)}
            idSuffix="inline"
          />
        </div>
        <SectionMenu sections={sections} label={t('profiles.sections.label')} />
        <Section id="overview" title={t('profiles.sections.overview')}>
          <ProviderOverview profile={p} locale={locale} t={t} />
        </Section>
        {provider ? (
          <Section id="services" title={t('profiles.sections.services')}>
            <Capabilities provider={provider} />
          </Section>
        ) : null}
        <Section id="portfolio" title={t('profiles.sections.portfolio')}>
          <Portfolio
            orgId={p.id}
            initial={portfolio}
            categories={(provider?.service_categories ?? []).map((c) => ({ id: c.node_id, label: c.label.text }))}
          />
        </Section>
        <Section id="reviews" title={t('profiles.sections.reviews')}>
          <div className="pwa-reviews-write">
            <WriteReviewButton orgId={p.id} slug={p.slug ?? slug} name={p.name} as="provider" />
          </div>
          <div className="pwa-reviews-cols">
            <RatingSummaryView summary={p.rating_summary} />
            <ReviewList orgId={p.id} orgName={p.name} initial={reviews} />
          </div>
        </Section>
        <Section id="location" title={t('profiles.sections.location')}>
          <LocationHours loc={loc} slug={p.slug} name={p.name} locale={locale} regionKey={ctx.region.region_key} t={t} f={f} />
        </Section>
        {qna ? (
          <Section id="qna" title={t('profiles.sections.qna')}>
            <a className="pwa-link" href={`/${locale}/questions`}>
              {t('profiles.qna.link')}
            </a>
          </Section>
        ) : null}
      </div>
    </I18nNamespaces>
  );
}
