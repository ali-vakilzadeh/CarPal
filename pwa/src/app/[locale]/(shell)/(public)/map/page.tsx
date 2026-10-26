// W-MAP-01 Map view, full page (P6.T4): /<locale>/map, not indexed. Opened from Browse on map (header, landing,
// navigation), Open full map on W-SRCH-01 (?session=<id>) and the Location sections of W-PUB-02/03
// (?org=<slug>&place=<location_id>: centred on that business). Only ids travel in the URL (GD-14); the centre of a
// business comes from its public profile (public point, SEC-OUT-4), a city from the region config.
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { MapScreen } from '@/features/map';
import { primaryLocation } from '@/features/profiles';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { serverEnv } from '@/server/env';
import { mapStyleUrl } from '@/server/map-config';
import { pageContext } from '@/server/ssr/page-context';
import { publicRead } from '@/server/ssr/public-reads';
import { chosenCity } from '@/server/ssr/search';

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[\p{L}\p{N}-]{1,120}$/u;
const BUSINESS_ZOOM = 15;

async function localeOf(params: Props['params']): Promise<Locale> {
  const { locale } = await params;
  return isLocale(locale) ? locale : 'fa';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const ctx = await pageContext(await localeOf(params));
  return { title: ctx.t('search.map.metaTitle'), robots: { index: false, follow: true } };
}

export default async function MapPage({ params, searchParams }: Props) {
  const locale = await localeOf(params);
  const [ctx, sp] = await Promise.all([pageContext(locale), searchParams]);
  const { city, fromDefault } = await chosenCity(ctx, sp.city);
  const session = typeof sp.session === 'string' && ID.test(sp.session) ? sp.session.toLowerCase() : null;
  const org = typeof sp.org === 'string' && SLUG.test(sp.org) ? sp.org : null;
  const place = typeof sp.place === 'string' && ID.test(sp.place) ? sp.place.toLowerCase() : null;

  let center = ctx.region.cities.find((c) => c.city_key === city)?.center ?? ctx.region.map.default_center;
  let zoom = ctx.region.map.default_zoom;
  let focusPlaceId: string | null = null;
  if (org) {
    const read = await publicRead(locale, 'public.org_get', { path: { slug: org } }).catch(() => null);
    if (read?.ok) {
      const loc = read.data.locations.find((l) => l.id === place && l.point) ?? primaryLocation(read.data);
      if (loc?.point) {
        center = loc.point;
        zoom = BUSINESS_ZOOM;
        focusPlaceId = loc.id;
      }
    }
  }

  return (
    <I18nNamespaces resources={ctx.i18n.resources(['search', 'profiles'])}>
      <Suspense>
        <MapScreen
          center={center}
          zoom={zoom}
          focusPlaceId={focusPlaceId}
          sessionParam={session}
          styleUrl={mapStyleUrl(ctx.region)}
          privacyVersion={serverEnv().CARPAL_PWA_PRIVACY_VERSION}
          defaultCity={city}
          entry={session ? 'search' : focusPlaceId ? 'profile' : 'map'}
          cityFallback={fromDefault && !focusPlaceId}
        />
      </Suspense>
    </I18nNamespaces>
  );
}
