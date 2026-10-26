// Data of the public profile pages (P5.T3/T4), shared by each page, its generateMetadata and its @rail slot (the
// cached reads make that one backend call per read and 60 s). Routing rules: an unknown slug is a 404 (no slug
// history, DI-20); a provider-only organization asked for as a parts seller (or the reverse) is moved permanently to
// the page it has; 410 means "no longer public" and renders the suspended state with 200 + noindex (OQ-14). The
// backend answers 404 for suspended, merged and unpublished organizations alike (DI-37), so the 301 for merged
// duplicates of Docs/22 cannot happen yet.
import 'server-only';
import type { PublicOrgProfile, PublicPortfolioItem, PublicReview, Slot } from '@carpal/api-contracts';
import { notFound, permanentRedirect } from 'next/navigation';
import { localNow, locationHours, primaryLocation, rangeText } from '@/features/profiles';
import type { Formatter } from '@/lib/format';
import type { Locale } from '@/lib/i18n/locales';
import type { Translate } from '@/lib/i18n/keys';
import { sellerPath, shopPath } from '@/lib/seo/urls';
import { publicList, publicRead } from './public-reads';

export const REVIEWS_PAGE = 10;
export const PORTFOLIO_PAGE = 12;
export const AVAILABILITY_DAYS = 7;

export type OrgPage = { kind: 'ok'; profile: PublicOrgProfile } | { kind: 'unavailable' };

/** The organization behind /<as>/<slug>, or notFound() / a permanent redirect to its other page. */
export async function loadOrg(locale: Locale, slug: string, as: 'provider' | 'vendor'): Promise<OrgPage> {
  const r = await publicRead(locale, 'public.org_get', { path: { slug } });
  if (!r.ok) {
    if (r.missing === 'gone') return { kind: 'unavailable' };
    notFound();
  }
  const p = r.data;
  if (!p.roles.includes(as)) {
    if (!p.slug) notFound();
    permanentRedirect(as === 'provider' ? sellerPath(locale, p.slug) : shopPath(locale, p.slug));
  }
  return { kind: 'ok', profile: p };
}

type Page<T> = { items: T[]; next_cursor: string | null };
const EMPTY = { items: [], next_cursor: null };

export async function firstReviews(locale: Locale, orgId: string): Promise<Page<PublicReview>> {
  return (
    (await publicList(locale, 'public.org_reviews', { path: { org_id: orgId }, query: { limit: REVIEWS_PAGE, sort: 'recent' } })) ?? EMPTY
  );
}

export async function firstPortfolio(locale: Locale, orgId: string): Promise<Page<PublicPortfolioItem>> {
  return (await publicList(locale, 'public.org_portfolio', { path: { org_id: orgId }, query: { limit: PORTFOLIO_PAGE } })) ?? EMPTY;
}

/** Open slots of the primary location for the coming week, from today in the location's time zone (BA-19: may be none). */
export async function nextSlots(locale: Locale, p: PublicOrgProfile): Promise<Slot[]> {
  const loc = primaryLocation(p);
  if (!loc) return [];
  const from = localNow(loc.timezone).date;
  const r = await publicList(locale, 'public.availability', {
    path: { org_id: p.id },
    query: { location_id: loc.id, from, days: AVAILABILITY_DAYS },
  });
  return r?.slots ?? [];
}

/** "Today: 08:00–18:00" or "Closed today" at the primary location, when it publishes hours. */
export function todayHours(p: PublicOrgProfile, locale: Locale, regionKey: string, t: Translate, f: Formatter): string | null {
  const loc = primaryLocation(p);
  if (!loc?.hours?.weekly.length) return null;
  const today = locationHours(loc, locale, regionKey).find((r) => r.today);
  if (!today) return null;
  return today.ranges.length ? t('profiles.request.todayHours', { hours: rangeText(today, t, f) }) : t('profiles.request.todayClosed');
}
