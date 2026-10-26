// W-PUB-08 Public Part Page (mirrors C-INV-02; P5.T5) at /<locale>/parts/<vendor-slug>/<item_id>-<slug> (DI-13): gallery,
// name and part numbers, condition, the public price or "Price on request", stock status, warranty, the fitment table
// with the visitor's car highlighted, the seller card with directions, and Ask about stock (auth-intent for guests,
// then the C-INV-03 form). A wrong vendor or item slug moves permanently to the canonical URL; out of stock stays a
// normal page (200); a removed item is the W-SYS-01 "no longer available" body with 200 + noindex (OQ-14; the backend
// answers 404 for removed items today, DI-37). Trade prices never reach this HTML: server rendering is anonymous.
// The slug follows the item's name in each language, so hreflang links need the other language's read (cached).
// Stock "last updated" and AI alternatives have no public field yet (P5 report).
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import type { PublicInventoryItem } from '@carpal/api-contracts';
import { Badge } from '@/components/ds/badge';
import { SystemPage } from '@/components/shell/system-page';
import { AskAboutStock, DirectionsMenu, FitmentTable, OrgCard, PartGallery, PriceText, Section, stockTone } from '@/features/profiles';
import { I18nNamespaces } from '@/lib/i18n/client';
import { LOCALES, isLocale, type Locale } from '@/lib/i18n/locales';
import { parseIdSlug, partPath, sellerPath, slugify } from '@/lib/seo/urls';
import { serverEnv } from '@/server/env';
import { pageContext } from '@/server/ssr/page-context';
import { publicRead, type Read } from '@/server/ssr/public-reads';
import { JsonLd } from '@/server/ssr/seo/json-ld';
import { metaDescription, pageMetadata, unavailableMetadata } from '@/server/ssr/seo/metadata';
import { product } from '@/server/ssr/seo/schema';

type Props = { params: Promise<{ locale: string; vendor: string; item: string }> };

async function load(params: Props['params']): Promise<{ locale: Locale; read: Read<PublicInventoryItem>; id: string }> {
  const { locale, vendor, item } = await params;
  if (!isLocale(locale)) notFound();
  const parsed = parseIdSlug(item);
  if (!parsed) notFound();
  const read = await publicRead(locale, 'public.inventory_get', { path: { item_id: parsed.id } });
  if (!read.ok) {
    if (read.missing === 'not_found') notFound();
    return { locale, read, id: parsed.id };
  }
  const it = read.data;
  if (!it.vendor.slug) notFound();
  const canonical = partPath(locale, it.vendor.slug, it.id, it.name.text);
  // Compared through slugify (idempotent), so a differently normalized but equal slug never loops through a redirect.
  if (decodeURIComponent(vendor) !== it.vendor.slug || slugify(parsed.slug) !== slugify(it.name.text)) permanentRedirect(canonical);
  return { locale, read, id: parsed.id };
}

/** The part page in every language (the slug follows each language's name). */
async function alternates(id: string, current: PublicInventoryItem, locale: Locale): Promise<Partial<Record<Locale, string>>> {
  const out: Partial<Record<Locale, string>> = { [locale]: partPath(locale, current.vendor.slug!, current.id, current.name.text) };
  await Promise.all(
    LOCALES.filter((l) => l !== locale).map(async (l) => {
      try {
        const r = await publicRead(l, 'public.inventory_get', { path: { item_id: id } });
        if (r.ok && r.data.vendor.slug) out[l] = partPath(l, r.data.vendor.slug, r.data.id, r.data.name.text);
      } catch {
        /* the other language's link falls back to the same slug */
      }
    }),
  );
  return out;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, read, id } = await load(params);
  const ctx = await pageContext(locale);
  const { t, f } = ctx;
  if (!read.ok) return unavailableMetadata(t('system.gone.metaTitle'));
  const it = read.data;
  const alt = await alternates(id, it, locale);
  const price = it.price && !it.price_on_request && !it.is_trade_price ? `${f.money(it.price.amount, it.price.currency)}.` : '';
  const base = t('profiles.meta.partDescription', {
    name: it.name.text,
    condition: t(`profiles.parts.condition.${it.condition}`),
    seller: it.vendor.name,
    price,
  });
  return pageMetadata({
    locale,
    path: alt[locale]!,
    alternates: alt,
    title: t('profiles.meta.partTitle', { name: it.name.text, seller: it.vendor.name }),
    description: it.description ? `${metaDescription(it.description.text, 90)} ${base}` : base,
    image: it.media.find((m) => m.media_type === 'image' && m.url)?.url ?? it.image_url,
    siteName: ctx.siteName,
  });
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="pwa-text-caption">{term}</dt>
      <dd className="pwa-text-body">{children}</dd>
    </>
  );
}

export default async function PartPage({ params }: Props) {
  const { locale, read } = await load(params);
  const ctx = await pageContext(locale);
  const { t, f } = ctx;
  if (!read.ok) return <SystemPage kind="gone" locale={locale} t={t} timeZone={ctx.timeZone} />;
  const it = read.data;
  const path = partPath(locale, it.vendor.slug!, it.id, it.name.text);
  const vendorUrl = `${ctx.origin}${sellerPath(locale, it.vendor.slug!)}`;
  const out = it.stock_status === 'out_of_stock';
  const numbers = [
    ...it.oem_numbers.map((n) => ({ kind: t('profiles.part.oem'), n })),
    ...it.aftermarket_numbers.map((n) => ({ kind: t('profiles.part.aftermarket'), n })),
  ];

  return (
    <I18nNamespaces resources={ctx.i18n.resources(['profiles'])}>
      <JsonLd data={product(it, `${ctx.origin}${path}`, vendorUrl)} />
      <div className="pwa-profile">
        <article className="pwa-part">
          <PartGallery media={it.media} name={it.name.text} />
          <div className="pwa-stack">
            {it.brand ? <p className="pwa-text-caption">{it.brand}</p> : null}
            <h1 className="pwa-text-title m-0" dir="auto">
              {it.name.text}
            </h1>
            <div className="pwa-org-facts">
              <PriceText item={it} t={t} f={f} />
              <Badge tone={stockTone(it.stock_status)} icon={out ? 'close' : 'check'}>
                {t(`profiles.parts.stock.${it.stock_status}`)}
              </Badge>
            </div>
            {out ? <p className="pwa-text-body">{t('profiles.part.outOfStockText')}</p> : null}
            <AskAboutStock
              itemId={it.id}
              itemName={it.name.text}
              vendorName={it.vendor.name}
              outOfStock={out}
              policyVersion={serverEnv().CARPAL_PWA_PRIVACY_VERSION}
            />
            <dl className="pwa-dl pwa-facts" aria-label={t('profiles.part.details')}>
              <Fact term={t('profiles.part.condition')}>{t(`profiles.parts.condition.${it.condition}`)}</Fact>
              <Fact term={t('profiles.part.origin')}>{t(`profiles.parts.origin.${it.part_origin}`)}</Fact>
              <Fact term={t('profiles.parts.category')}>{it.part_category.text}</Fact>
              {it.position.length ? (
                <Fact term={t('profiles.part.position')}>{it.position.map((p) => t(`profiles.part.positions.${p}`)).join(' · ')}</Fact>
              ) : null}
              <Fact term={t('profiles.part.warranty')}>{it.warranty_note ?? t('profiles.part.noWarranty')}</Fact>
              {numbers.map((x) => (
                <Fact key={`${x.kind}-${x.n}`} term={x.kind}>
                  <bdi dir="ltr">{x.n}</bdi>
                </Fact>
              ))}
            </dl>
            {it.description ? (
              <p className="pwa-text-body pwa-ugc" dir="auto" lang={it.description.locale}>
                {it.description.text}
              </p>
            ) : null}
          </div>
        </article>
        <Section id="fitment" title={t('profiles.fitment.fits')}>
          <FitmentTable fitment={it.fitment} />
        </Section>
        <Section id="seller" title={t('profiles.part.seller')}>
          <div className="pwa-stack-sm">
            <OrgCard org={it.vendor} locale={locale} t={t} f={f} detail={it.location?.city ?? null} />
            {it.location?.point ? (
              <DirectionsMenu
                point={it.location.point}
                name={it.vendor.name}
                approximate={it.location.visibility !== 'exact'}
                address={it.location.visibility !== 'exact' ? it.location.city : null}
              />
            ) : null}
          </div>
        </Section>
      </div>
    </I18nNamespaces>
  );
}
