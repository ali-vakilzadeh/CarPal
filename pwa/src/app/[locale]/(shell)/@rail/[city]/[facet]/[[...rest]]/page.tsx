// Right rail of W-PUB-04 (≥ 1200 px): the map of the listed providers, loaded after the list (DirectoryMap), and Open
// the full map. The same cached reads as the page (search.run, taxonomy), so no extra backend call.
import { RailBox, RightRail } from '@/components/shell/right-rail';
import { buttonClass } from '@/components/ds/button';
import { DirectoryMap } from '@/features/directory/directory-map';
import { placesFromResults } from '@/features/map/places';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale } from '@/lib/i18n/locales';
import { mapStyleUrl } from '@/server/map-config';
import { directoryResults, resolveDirectory } from '@/server/ssr/directory';
import { pageContext } from '@/server/ssr/page-context';

type Props = {
  params: Promise<{ locale: string; city: string; facet: string; rest?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function DirectoryRail({ params, searchParams }: Props) {
  const [{ locale, city, facet, rest = [] }, sp] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) return null;
  const ctx = await pageContext(locale);
  const resolved = await resolveDirectory(
    ctx,
    decodeURIComponent(city),
    decodeURIComponent(facet),
    rest.map(decodeURIComponent),
    typeof sp.series === 'string' ? sp.series : null,
  );
  if (resolved.kind !== 'ok') return null;
  const results = await directoryResults(locale, resolved.facets);
  const places = placesFromResults(results ?? []).map((p) => ({ ...p, result: null }));
  const center = ctx.region.cities.find((c) => c.city_key === resolved.facets.city.key)?.center ?? ctx.region.map.default_center;
  if (!places.length) return null;
  return (
    <I18nNamespaces resources={ctx.i18n.resources(['search'])}>
      <RightRail>
        <div className="pwa-rail-sticky">
          <RailBox title={ctx.t('directory.onMap')}>
            <DirectoryMap places={places} center={center} zoom={ctx.region.map.default_zoom} styleUrl={mapStyleUrl(ctx.region)} />
            <a
              href={`/${locale}/map?city=${encodeURIComponent(resolved.facets.city.key)}`}
              className={buttonClass({ size: 'sm', block: true })}
            >
              <span className="cp-btn-label">{ctx.t('search.map.openFull')}</span>
            </a>
          </RailBox>
        </div>
      </RightRail>
    </I18nNamespaces>
  );
}
