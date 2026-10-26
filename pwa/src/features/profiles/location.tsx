// Location & Hours (Docs/22 W-PUB-02, C-PROV-01 tab 5; also the vendor's Location): a light static preview first (the
// interactive map is P6 and loads only on request, keeping the page inside the 2.5 s budget, open point 9), the address
// with Copy — or the approximate area when the shop chose that —, Get directions, the service radius of mobile
// mechanics, opening hours in the region's week order with today and "open now" (computed by the server for the
// caller's time zone, BA-28), and access instructions. Server-rendered; directions and copy are client islands.
import type { PublicLocation } from '@carpal/api-contracts';
import { Badge } from '@/components/ds/badge';
import { Icon } from '@/components/ds/icon';
import { buttonClass } from '@/components/ds/button';
import type { Formatter } from '@/lib/format';
import type { Locale } from '@/lib/i18n/locales';
import type { Translate } from '@/lib/i18n/keys';
import { CopyAddress, DirectionsMenu } from './location-actions';
import { hoursRows, localNow, weekOrder, type HoursRow } from './view-model';

/** Address parts joined with the UI language's list comma. */
export function addressLine(parts: readonly (string | null | undefined)[], locale: Locale): string {
  return parts.filter(Boolean).join(locale === 'fa' ? '، ' : ', ');
}

const fullAddress = (loc: PublicLocation, locale: Locale) =>
  addressLine([loc.address.address_line_1, loc.address.city, loc.address.region], locale);

export function rangeText(row: HoursRow, t: Translate, f: Formatter): string {
  if (!row.ranges.length) return t('profiles.location.closed');
  return row.ranges.map((r) => t('profiles.location.range', { open: f.digits(r.open), close: f.digits(r.close) })).join(' · ');
}

/** Rows of the opening-hours table for a location, in display order. */
export function locationHours(loc: PublicLocation, locale: Locale, regionKey: string, now = Date.now()): HoursRow[] {
  const today = localNow(loc.timezone, now);
  return hoursRows(loc.hours, weekOrder(locale, regionKey), today);
}

export function StaticMapPreview({ loc, locale, t }: { loc: PublicLocation; locale: Locale; t: Translate }) {
  return (
    <div className="pwa-map-preview">
      <span
        className={loc.visibility === 'exact' ? 'pwa-map-pin' : 'pwa-map-area'}
        role="img"
        aria-label={t('profiles.location.mapPreview', { place: loc.address.city })}
      >
        <Icon name={loc.visibility === 'exact' ? 'pin' : 'locate'} size={24} />
      </span>
      <a href={`/${locale}/map`} className={buttonClass({ variant: 'secondary', size: 'sm', className: 'pwa-map-open' })}>
        <span className="cp-btn-label">{t('profiles.location.openMap')}</span>
      </a>
      <span className="pwa-map-attr">© OpenStreetMap contributors</span>
    </div>
  );
}

export function HoursTable({ rows, t, f }: { rows: HoursRow[]; t: Translate; f: Formatter }) {
  return (
    <table className="pwa-hours">
      <caption className="sr-only">{t('profiles.location.hours')}</caption>
      <tbody>
        {rows.map((row) => (
          <tr key={row.day} className={row.today ? 'is-today' : undefined} aria-current={row.today ? 'date' : undefined}>
            <th scope="row">
              {t(`profiles.location.day.${row.day}` as Parameters<Translate>[0])}
              {row.today ? <span className="pwa-text-caption"> ({t('profiles.location.today')})</span> : null}
            </th>
            <td>{rangeText(row, t, f)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LocationHours({
  loc,
  locale,
  regionKey,
  t,
  f,
}: {
  loc: PublicLocation | null;
  locale: Locale;
  regionKey: string;
  t: Translate;
  f: Formatter;
}) {
  if (!loc) return <p className="pwa-text-body">{t('profiles.location.noLocation')}</p>;
  const rows = locationHours(loc, locale, regionKey);
  const exact = loc.visibility === 'exact' && loc.address.address_line_1;
  return (
    <div className="pwa-location">
      <StaticMapPreview loc={loc} locale={locale} t={t} />
      <div className="pwa-stack">
        {exact ? (
          <div className="pwa-address">
            <p className="pwa-text-body" dir="auto">
              {loc.name ? (
                <>
                  <bdi>{loc.name}</bdi>
                  <br />
                </>
              ) : null}
              {fullAddress(loc, locale)}
            </p>
            <CopyAddress text={fullAddress(loc, locale)} />
          </div>
        ) : (
          <div className="pwa-explain">
            <p className="pwa-text-label m-0">
              {t('profiles.location.approximate', { area: addressLine([loc.address.city, loc.address.region], locale) })}
            </p>
            <p className="pwa-text-caption">{t('profiles.location.approximateText')}</p>
          </div>
        )}
        {loc.service_radius_km ? (
          <p className="pwa-text-body">{t('profiles.location.radius', { km: f.number(loc.service_radius_km) })}</p>
        ) : null}
        {loc.point ? <DirectionsMenu point={loc.point} /> : null}
        {loc.access_instructions ? (
          <div className="pwa-stack-xs">
            <h3 className="pwa-text-label m-0">{t('profiles.location.access')}</h3>
            <p className="pwa-text-body pwa-ugc" dir="auto">
              {loc.access_instructions.text}
            </p>
          </div>
        ) : null}
      </div>
      <div className="pwa-stack-sm">
        <div className="pwa-section-head">
          <h3 className="pwa-text-label m-0">{t('profiles.location.hours')}</h3>
          {loc.open_now === null ? null : loc.open_now ? (
            <Badge tone="success" icon="check">
              {t('profiles.location.openNow')}
            </Badge>
          ) : (
            <Badge icon="clock">{t('profiles.location.closedNow')}</Badge>
          )}
        </div>
        {loc.hours?.weekly.length ? (
          <HoursTable rows={rows} t={t} f={f} />
        ) : (
          <p className="pwa-text-caption">{t('profiles.location.noHours')}</p>
        )}
        <p className="pwa-text-caption">{t('profiles.location.timeZone', { zone: loc.timezone })}</p>
      </div>
    </div>
  );
}
