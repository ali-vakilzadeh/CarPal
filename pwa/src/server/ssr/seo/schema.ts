// Structured data builders (P5.T1): Organization (CarPal itself), AutoRepair / AutoPartsStore (LocalBusiness) with an
// AggregateRating built from the published reviews of both confirmation paths (the same weighted score the profile
// shows, Docs/22 W-PUB-02), Product/Offer for parts with a public price only, and Article/ImageObject for showcases.
// Public fields only: no trade price, no contact data beyond the website (the phone is revealed on click, Docs/22
// open point 7), no exact point for shops that publish an approximate area.
import type {
  HoursSpec,
  PartCondition,
  PublicInventoryItem,
  PublicLocation,
  PublicOrgProfile,
  PublicPortfolioItem,
  StockStatus,
} from '@carpal/api-contracts';
import type { JsonLdValue } from './json-ld';

const CONTEXT = 'https://schema.org';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const; // 0 = Sunday (BA-28)

type Json = { [key: string]: JsonLdValue };

export function siteOrganization(origin: string, name: string, description: string): Json {
  return { '@context': CONTEXT, '@type': 'Organization', name, url: `${origin}/`, description, logo: `${origin}/icon.svg` };
}

export function postalAddress(loc: PublicLocation): Json {
  return {
    '@type': 'PostalAddress',
    streetAddress: loc.visibility === 'exact' ? loc.address.address_line_1 : null,
    addressLocality: loc.address.city,
    addressRegion: loc.address.region,
    addressCountry: loc.address.country,
  };
}

export function openingHours(hours: HoursSpec | null): Json[] | undefined {
  if (!hours?.weekly.length) return undefined;
  return hours.weekly.map((h) => ({
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: DAYS[h.day_of_week],
    opens: h.open,
    closes: h.close,
  }));
}

export function aggregateRating(p: Pick<PublicOrgProfile, 'rating_summary'>): Json | undefined {
  const s = p.rating_summary;
  const count = s.count_visit_verified + s.count_approved_without_visit;
  if (!s.overall || count === 0) return undefined;
  return { '@type': 'AggregateRating', ratingValue: s.overall, reviewCount: count, bestRating: 5, worstRating: 1 };
}

const PRICE_RANGE = { budget: '$', mid_range: '$$', premium: '$$$', unspecified: undefined } as const;

/** AutoRepair (providers), AutoPartsStore (vendors) or both (hybrids), for the profile at `url`. */
export function localBusiness(p: PublicOrgProfile, url: string, description: string | null, image: string | null): Json {
  const types = [p.roles.includes('provider') ? 'AutoRepair' : null, p.roles.includes('vendor') ? 'AutoPartsStore' : null].filter(Boolean);
  const primary = p.locations[0];
  return {
    '@context': CONTEXT,
    '@type': types.length === 1 ? types[0]! : types,
    '@id': `${url}#business`,
    name: p.name,
    url,
    description,
    image,
    logo: p.logo_url,
    sameAs: p.website ? [p.website] : undefined,
    priceRange: p.price_tier ? PRICE_RANGE[p.price_tier] : undefined,
    address: primary ? postalAddress(primary) : undefined,
    geo:
      primary?.point && primary.visibility === 'exact'
        ? { '@type': 'GeoCoordinates', latitude: primary.point.lat, longitude: primary.point.lng }
        : undefined,
    areaServed: primary?.service_radius_km
      ? {
          '@type': 'GeoCircle',
          geoMidpoint: primary.point ? { '@type': 'GeoCoordinates', latitude: primary.point.lat, longitude: primary.point.lng } : undefined,
          geoRadius: primary.service_radius_km * 1000,
        }
      : undefined,
    openingHoursSpecification: openingHours(primary?.hours ?? null),
    aggregateRating: aggregateRating(p),
  };
}

const CONDITION: Record<PartCondition, string> = {
  new: 'https://schema.org/NewCondition',
  used: 'https://schema.org/UsedCondition',
  refurbished: 'https://schema.org/RefurbishedCondition',
  remanufactured: 'https://schema.org/RefurbishedCondition',
};
const AVAILABILITY: Record<StockStatus, string> = {
  in_stock: 'https://schema.org/InStock',
  low_stock: 'https://schema.org/LimitedAvailability',
  out_of_stock: 'https://schema.org/OutOfStock',
  available_on_request: 'https://schema.org/BackOrder',
};

/** Product with an Offer only when the item has a public price (never a trade price or "price on request"). */
export function product(item: PublicInventoryItem, url: string, vendorUrl: string | null): Json {
  const publicPrice = item.price && !item.is_trade_price && !item.price_on_request ? item.price : null;
  const images = item.media.filter((m) => m.media_type === 'image' && m.url).map((m) => m.url!);
  return {
    '@context': CONTEXT,
    '@type': 'Product',
    name: item.name.text,
    description: item.description?.text,
    image: images.length ? images : item.image_url ? [item.image_url] : undefined,
    url,
    brand: item.brand ? { '@type': 'Brand', name: item.brand } : undefined,
    mpn: item.oem_numbers[0] ?? item.aftermarket_numbers[0],
    category: item.part_category.text,
    itemCondition: CONDITION[item.condition],
    offers: publicPrice
      ? {
          '@type': 'Offer',
          url,
          price: publicPrice.amount,
          priceCurrency: publicPrice.currency,
          availability: AVAILABILITY[item.stock_status],
          itemCondition: CONDITION[item.condition],
          seller: { '@type': 'Organization', name: item.vendor.name, url: vendorUrl },
        }
      : undefined,
  };
}

/** Article for a before/after showcase; images are the servable after/before photos (after first, Docs/22 W-PUB-05). */
export function showcaseArticle(item: PublicPortfolioItem, url: string, authorUrl: string | null, siteName: string, origin: string): Json {
  const servable = item.media.filter((m) => m.media_type === 'image' && m.url);
  const ordered = [...servable.filter((m) => m.role === 'after'), ...servable.filter((m) => m.role !== 'after')];
  return {
    '@context': CONTEXT,
    '@type': 'Article',
    headline: item.title,
    description: item.description ?? item.caption,
    inLanguage: item.content_locale,
    url,
    datePublished: item.published_at,
    author: { '@type': 'Organization', name: item.organization.name, url: authorUrl },
    publisher: { '@type': 'Organization', name: siteName, url: `${origin}/` },
    about: [item.service_system.text, item.vehicle.brand?.text, item.vehicle.model?.text].filter(Boolean) as string[],
    image: ordered.map((m) => ({
      '@type': 'ImageObject',
      contentUrl: m.url,
      width: m.width ?? undefined,
      height: m.height ?? undefined,
      caption: m.caption ?? undefined,
    })),
  };
}

/** A ranked list of businesses (W-PUB-04 directory pages): position = rank, each item the profile URL. */
export function itemList(name: string, url: string, items: readonly { name: string; url: string }[]): Json {
  return {
    '@context': CONTEXT,
    '@type': 'ItemList',
    name,
    url,
    numberOfItems: items.length,
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, url: it.url })),
  };
}

/** Breadcrumbs (W-PUB-04: city › category › brand). */
export function breadcrumbs(items: readonly { name: string; url: string }[]): Json {
  return {
    '@context': CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.url })),
  };
}
