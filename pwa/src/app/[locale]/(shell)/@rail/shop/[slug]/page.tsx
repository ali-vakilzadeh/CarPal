// Right rail of W-PUB-02 (≥ 1200 px, Docs/22 "Right rail (sticky)"): the Request appointment card, then the static map
// preview and today's hours. Same cached reads as the page (src/server/ssr/profiles.ts), so no extra backend calls.
import { RightRail } from '@/components/shell/right-rail';
import { RequestCard, StaticMapPreview, primaryLocation } from '@/features/profiles';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale } from '@/lib/i18n/locales';
import { pageContext } from '@/server/ssr/page-context';
import { loadOrg, nextSlots, todayHours } from '@/server/ssr/profiles';

export default async function ProviderRail({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return null;
  const [page, ctx] = await Promise.all([loadOrg(locale, decodeURIComponent(slug), 'provider'), pageContext(locale)]);
  if (page.kind !== 'ok') return null;
  const p = page.profile;
  const loc = primaryLocation(p);
  const slots = await nextSlots(locale, p);
  return (
    <I18nNamespaces resources={ctx.i18n.resources(['profiles'])}>
      <RightRail>
        <div className="pwa-rail-sticky">
          <RequestCard
            orgId={p.id}
            slug={p.slug ?? slug}
            name={p.name}
            rating={p.rating_summary.overall}
            locationId={loc?.id ?? null}
            capabilities={p.provider?.capabilities ?? []}
            slots={slots}
            todayHours={todayHours(p, locale, ctx.region.region_key, ctx.t, ctx.f)}
            heading="h2"
            idSuffix="rail"
          />
          {loc ? <StaticMapPreview loc={loc} locale={locale} t={ctx.t} slug={p.slug} /> : null}
        </div>
      </RightRail>
    </I18nNamespaces>
  );
}
