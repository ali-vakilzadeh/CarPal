// Right rail of W-PUB-05 (≥ 1200 px): the provider card with "Request similar service", and more from this provider.
// Same cached reads as the page.
import { RailBox, RightRail } from '@/components/shell/right-rail';
import { OrgCard, RequestSimilarButton, ShowcaseCard } from '@/features/profiles';
import { I18nNamespaces } from '@/lib/i18n/client';
import { isLocale } from '@/lib/i18n/locales';
import { parseIdSlug } from '@/lib/seo/urls';
import { pageContext } from '@/server/ssr/page-context';
import { firstPortfolio } from '@/server/ssr/profiles';
import { publicRead } from '@/server/ssr/public-reads';

export default async function ShowcaseRail({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  const parsed = parseIdSlug(id);
  if (!isLocale(locale) || !parsed) return null;
  const read = await publicRead(locale, 'showcases.get', { path: { item_id: parsed.id } }).catch(() => null);
  if (!read?.ok) return null;
  const item = read.data;
  const ctx = await pageContext(locale);
  const more = (await firstPortfolio(locale, item.organization.id)).items.filter((x) => x.id !== item.id).slice(0, 3);
  return (
    <I18nNamespaces resources={ctx.i18n.resources(['profiles'])}>
      <RightRail>
        <RailBox title={item.organization.name}>
          <OrgCard org={item.organization} locale={locale} t={ctx.t} f={ctx.f} headingLevel={3} />
          <RequestSimilarButton orgId={item.organization.id} name={item.organization.name} />
        </RailBox>
        {more.length ? (
          <RailBox title={ctx.t('profiles.showcase.moreFrom', { name: item.organization.name })}>
            <div className="pwa-stack-sm">
              {more.map((x) => (
                <ShowcaseCard key={x.id} item={x} />
              ))}
            </div>
          </RailBox>
        ) : null}
      </RightRail>
    </I18nNamespaces>
  );
}
