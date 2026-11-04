'use client';
// W-SRCH-01 notices and states (Docs/21 C-SEARCH-01 "States", S-SHARED-01 "Behaviour"):
//   - the red safety banner above the results, which stay visible (server SafetyBlock; safety.check when the search
//     itself failed) with Find urgent help;
//   - no results with concrete widening actions (Widen to N km, Show mobile mechanics, Remove filter: …, Help Me);
//     with facets the filter that removed most results comes first with its count ("Remove Verified businesses only:
//     12 results"), and a few results get the same hint above the list (filters too narrow, P14.T2);
//   - "Add your car for better matches", "Results are less specific without a vehicle" and the vehicle-filter
//     fallback ("Only a few places have evidence for your car here").
import type { SafetyBlock, SearchFacets, SearchFilters } from '@carpal/api-contracts';
import { Button, buttonClass } from '@/components/ds/button';
import { Banner, SafetyBanner } from '@/components/ds/banner';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { narrowingFilter, wideningFilters, type WideningFilter } from './facets';
import type { FilterKey } from './filters';
import { widerDistance, withoutFilter, type ModeTab } from './request';

export function SafetyNotice({ safety }: { safety: SafetyBlock }) {
  const t = useT();
  const locale = useLocale();
  if (!safety.flag) return null;
  return (
    <SafetyBanner
      className="pwa-search-safety"
      title={t('search.safety.title')}
      text={t(safety.level === 'urgent' ? 'search.safety.urgent' : 'search.safety.warning')}
      action={
        safety.urgent_help_available || safety.level === 'urgent' ? (
          <a href={`/${locale}/help?urgent=1`} className={buttonClass({ variant: 'danger', size: 'sm' })}>
            <span className="cp-btn-label">{t('search.safety.findHelp')}</span>
          </a>
        ) : null
      }
    />
  );
}

export const FILTER_NAME: Record<FilterKey, MessageKey> = {
  open_now: 'search.filters.openNow',
  verified_only: 'search.filters.verified',
  min_rating: 'search.filters.rating',
  distance_km: 'search.filters.distance',
  available_within_days: 'search.filters.availability',
  price_tiers: 'search.filters.price',
  service_modes: 'search.filters.comesToMe',
  warranty_offered: 'search.filters.warranty',
  ev_capable: 'search.filters.ev',
  fleet_friendly: 'search.filters.fleet',
  stock_available: 'search.filters.inStock',
  part_conditions: 'search.filters.condition',
  delivery_options: 'search.filters.delivery',
};

/** "Remove Verified businesses only: 12 results" with a server count, else "Remove filter: Verified businesses only". */
function RemoveFilter({ w, filters, onFilters }: { w: WideningFilter; filters: SearchFilters; onFilters: (f: SearchFilters) => void }) {
  const t = useT();
  const f = useFormat();
  const name = t(FILTER_NAME[w.key]);
  const shown = w.without
    ? w.without.capped
      ? t('search.filters.countCapped', { count: f.number(w.without.count) })
      : f.number(w.without.count)
    : '';
  return (
    <Button size="sm" variant="ghost" onClick={() => onFilters(withoutFilter(filters, w.key))}>
      {w.without
        ? t('search.empty.removeCount', { filter: name, shown, count: w.without.count })
        : t('search.empty.remove', { filter: name })}
    </Button>
  );
}

/** Filters too narrow (Docs/21 C-SEARCH-01 "States"): a few results and an active filter that would add more. */
export function NarrowHint({
  filters,
  facets,
  onFilters,
}: {
  filters: SearchFilters;
  facets: SearchFacets | null;
  onFilters: (f: SearchFilters) => void;
}) {
  const t = useT();
  const top = narrowingFilter(filters, facets);
  if (!top) return null;
  return (
    <Banner tone="info" icon="filter" title={t('search.narrow.title')} text={t('search.narrow.text')}>
      <div className="pwa-banner-actions">
        <RemoveFilter w={top} filters={filters} onFilters={onFilters} />
      </div>
    </Banner>
  );
}

export function EmptyResults({
  mode,
  filters,
  facets = null,
  what,
  onFilters,
  helpHref,
}: {
  mode: ModeTab;
  filters: SearchFilters;
  /** The session's facets: orders "Remove filter" by the results each removal brings back. */
  facets?: SearchFacets | null;
  /** "Suspension · BMW 3 Series" — how the search was understood. */
  what: string;
  onFilters: (f: SearchFilters) => void;
  helpHref: string;
}) {
  const t = useT();
  const f = useFormat();
  const wider = widerDistance(filters.distance_km);
  const km = filters.distance_km ?? 50;
  const providers = mode === 'all' || mode === 'providers';
  const removable = wideningFilters(filters, facets, ['distance_km']);
  return (
    <section className="pwa-explain pwa-search-empty" aria-labelledby="search-empty-title">
      <h2 id="search-empty-title" className="pwa-text-label m-0">
        {what ? t('search.empty.titleWhat', { what, km: f.number(km) }) : t('search.empty.title', { km: f.number(km) })}
      </h2>
      <p className="pwa-text-caption">{t('search.empty.text')}</p>
      <div className="pwa-inline-actions">
        {wider ? (
          <Button size="sm" onClick={() => onFilters({ ...filters, distance_km: wider })}>
            {t('search.empty.widen', { km: f.number(wider) })}
          </Button>
        ) : null}
        {providers && !filters.service_modes?.includes('mobile') ? (
          <Button size="sm" onClick={() => onFilters({ ...filters, service_modes: ['mobile'] })}>
            {t('search.empty.mobile')}
          </Button>
        ) : null}
        {removable.map((w) => (
          <RemoveFilter key={w.key} w={w} filters={filters} onFilters={onFilters} />
        ))}
      </div>
      <a className="pwa-link" href={helpHref}>
        {t('search.helpMe.ask')}
      </a>
    </section>
  );
}

export function VehicleMissing({ signedIn, onChoose, garageHref }: { signedIn: boolean; onChoose: () => void; garageHref: string }) {
  const t = useT();
  return (
    <Banner tone="info" icon="car" title={t('search.vehicle.missing')} text={t('search.vehicle.missingText')}>
      <div className="pwa-banner-actions">
        <Button size="sm" onClick={onChoose}>
          {t('search.vehicle.choose')}
        </Button>
        {signedIn ? (
          <a href={garageHref} className={buttonClass({ size: 'sm', variant: 'ghost' })}>
            <span className="cp-btn-label">{t('search.vehicle.add')}</span>
          </a>
        ) : null}
      </div>
    </Banner>
  );
}

export function VehicleFallback({ label, onShowAll }: { label: string; onShowAll?: () => void }) {
  const t = useT();
  return (
    <Banner tone="warn" icon="car" title={t('search.vehicle.fallback', { vehicle: label })} text={t('search.vehicle.fallbackText')}>
      {onShowAll ? (
        <div className="pwa-banner-actions">
          <Button size="sm" onClick={onShowAll}>
            {t('search.vehicle.showAll')}
          </Button>
        </div>
      ) : null}
    </Banner>
  );
}
