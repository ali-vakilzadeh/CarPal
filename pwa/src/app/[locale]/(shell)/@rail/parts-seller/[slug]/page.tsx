// Right rail of W-PUB-03 (≥ 1200 px): "Ask about a part" (the inquiry itself starts on a part, C-INV-03), today's
// hours, the static map preview with Get directions. Same cached read as the page.
import { buttonClass } from '@/components/ds/button';
import { RailBox, RightRail } from '@/components/shell/right-rail';
import { DirectionsMenu, StaticMapPreview, primaryLocation } from '@/features/profiles';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale } from '@/lib/i18n/locales';
import { pageContext } from '@/server/ssr/page-context';
import { loadOrg, todayHours } from '@/server/ssr/profiles';

export default async function VendorRail({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return null;
  const [page, ctx] = await Promise.all([loadOrg(locale, decodeURIComponent(slug), 'vendor'), pageContext(locale)]);
  if (page.kind !== 'ok') return null;
  const { t, f } = ctx;
  const p = page.profile;
  const loc = primaryLocation(p);
  const hours = todayHours(p, locale, ctx.region.region_key, t, f);
  return (
    <I18nNamespaces resources={ctx.i18n.resources(['profiles'])}>
      <RightRail>
        <RailBox title={t('profiles.vendor.askTitle')}>
          <p className="pwa-text-caption">{t('profiles.vendor.askText')}</p>
          <a href="#parts" className={buttonClass({ variant: 'primary', block: true })}>
            <span className="cp-btn-label">{t('profiles.vendor.findPart')}</span>
          </a>
          {p.vendor?.trade_customers_supported ? <p className="pwa-text-caption">{t('profiles.vendor.tradeNote')}</p> : null}
        </RailBox>
        {loc ? (
          <RailBox title={t('profiles.location.hours')}>
            {hours ? <p className="pwa-text-body">{hours}</p> : null}
            <StaticMapPreview loc={loc} locale={locale} t={t} slug={p.slug} />
            {loc.point ? <DirectionsMenu point={loc.point} name={p.name} approximate={loc.visibility !== 'exact'} block /> : null}
          </RailBox>
        ) : null}
      </RightRail>
    </I18nNamespaces>
  );
}
