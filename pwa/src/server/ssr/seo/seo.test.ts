// P5.T1: the SEO kit — JSON-LD serializer and builders, page metadata (canonical, hreflang, robots) and sitemaps.
import { describe, expect, it } from 'vitest';
import { part, providerProfile, showcase, vendorProfile, media } from '../../../../tests/support/public-fixtures';
import { compact, serializeJsonLd } from './json-ld';
import { languageAlternates, metaDescription, pageMetadata } from './metadata';
import { aggregateRating, localBusiness, openingHours, product, showcaseArticle } from './schema';
import { sitemapIndexXml, urlsetXml } from './sitemap';

describe('JSON-LD serializer (GD-15)', () => {
  it('never lets text close the script element or start markup', () => {
    const out = serializeJsonLd({ name: '</script><script>alert(1)</script> & co \u2028' });
    expect(out).not.toMatch(/[<>&\u2028]/);
    expect(JSON.parse(out)).toEqual({ name: '</script><script>alert(1)</script> & co \u2028' });
  });

  it('drops empty members so builders can list optional fields', () => {
    expect(compact({ a: undefined, b: null, c: '', d: [], e: { f: undefined }, g: [1, null], h: 0 })).toEqual({ g: [1], h: 0 });
  });
});

describe('schema.org builders', () => {
  it('describes a provider as AutoRepair with address, geo, hours and the rating of both review paths', () => {
    const p = providerProfile();
    const ld = localBusiness(p, 'https://carpal.app/fa/shop/reza', 'desc', 'https://media/cover.jpg');
    expect(ld['@type']).toBe('AutoRepair');
    expect(ld.aggregateRating).toEqual({
      '@type': 'AggregateRating',
      ratingValue: '4.70',
      reviewCount: 126,
      bestRating: 5,
      worstRating: 1,
    });
    expect(ld.geo).toEqual({ '@type': 'GeoCoordinates', latitude: 35.7, longitude: 51.4 });
    expect(JSON.stringify(ld)).not.toContain('66001122'); // the phone is revealed on click only
    expect(openingHours(p.locations[0]!.hours)?.[0]).toEqual({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: 'Saturday',
      opens: '08:00:00',
      closes: '18:00:00',
    });
  });

  it('hides the street and point of an approximate address, and names hybrids by both types', () => {
    const base = providerProfile();
    const loc = {
      ...base.locations[0]!,
      visibility: 'approximate' as const,
      address: { ...base.locations[0]!.address, address_line_1: null },
    };
    const ld = localBusiness({ ...base, roles: ['provider', 'vendor'], locations: [loc] }, 'u', null, null);
    expect(ld['@type']).toEqual(['AutoRepair', 'AutoPartsStore']);
    expect(ld.geo).toBeUndefined();
    expect((ld.address as Record<string, unknown>).streetAddress).toBeNull();
    expect(localBusiness(vendorProfile(), 'u', null, null)['@type']).toBe('AutoPartsStore');
  });

  it('gives no rating without reviews', () => {
    const p = providerProfile();
    expect(
      aggregateRating({ rating_summary: { ...p.rating_summary, overall: null, count_visit_verified: 0, count_approved_without_visit: 0 } }),
    ).toBeUndefined();
  });

  it('offers a part only at its public price', () => {
    const offer = (o: Parameters<typeof part>[0]) =>
      product(part(o), 'https://carpal.app/en/parts/x', null).offers as Record<string, unknown> | undefined;
    expect(offer({})).toMatchObject({ price: '45', priceCurrency: 'USD', availability: 'https://schema.org/InStock' });
    expect(offer({ price_on_request: true })).toBeUndefined();
    expect(offer({ price: null })).toBeUndefined();
    expect(offer({ is_trade_price: true })).toBeUndefined();
    expect(product(part(), 'u', null).mpn).toBe('31126769717');
  });

  it('describes a showcase as an Article with the after photo first', () => {
    const ld = showcaseArticle(showcase(), 'https://carpal.app/en/post/x', null, 'CarPal', 'https://carpal.app');
    const images = ld.image as { contentUrl: string }[];
    expect(ld['@type']).toBe('Article');
    expect(images.map((i) => i.contentUrl)).toEqual(['https://media.example/after.jpg', 'https://media.example/before.jpg']);
    const pending = showcaseArticle(showcase({ media: [media({ url: null })] }), 'u', null, 'CarPal', 'o');
    expect(pending.image).toEqual([]);
  });
});

describe('page metadata (Docs/22 §6)', () => {
  it('links every language and x-default = fa', () => {
    expect(languageAlternates('/en/shop/x')).toEqual({ fa: '/fa/shop/x', en: '/en/shop/x', 'x-default': '/fa/shop/x' });
    expect(languageAlternates('/en/parts/v/1-arm', { fa: '/fa/parts/v/1-طبق' })['fa']).toBe('/fa/parts/v/1-طبق');
  });

  it('builds canonical, hreflang, Open Graph and the index rule', () => {
    const m = pageMetadata({
      locale: 'en',
      path: '/en/shop/x',
      title: 'T',
      description: 'D',
      image: 'https://m/c.jpg',
      siteName: 'CarPal',
    });
    expect(m.alternates?.canonical).toBe('/en/shop/x');
    expect(m.openGraph).toMatchObject({ locale: 'en_US', alternateLocale: ['fa_IR'], images: [{ url: 'https://m/c.jpg' }] });
    expect(m.robots).toEqual({ index: true, follow: true });
    expect(pageMetadata({ locale: 'fa', path: '/fa', title: 'T', description: 'D', noindex: true, siteName: 'C' }).robots).toEqual({
      index: false,
      follow: true,
    });
  });

  it('cuts descriptions at a word', () => {
    const d = metaDescription(`${'word '.repeat(60)}`);
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d.endsWith('…')).toBe(true);
    expect(metaDescription(' a\n b ')).toBe('a b');
  });
});

describe('sitemaps', () => {
  it('lists every language of a page with its alternates and escapes URLs', () => {
    const xml = urlsetXml('https://carpal.app', [{ paths: { fa: '/fa/shop/a&b', en: '/en/shop/a&b' }, images: ['https://m/x.jpg'] }]);
    expect(xml.match(/<url>/g)).toHaveLength(2);
    expect(xml).toContain('<loc>https://carpal.app/fa/shop/a&amp;b</loc>');
    expect(xml).toContain('hreflang="x-default" href="https://carpal.app/fa/shop/a&amp;b"');
    expect(xml).toContain('<image:loc>https://m/x.jpg</image:loc>');
  });

  it('indexes the per-kind sitemaps', () => {
    expect(sitemapIndexXml('https://carpal.app')).toContain('<loc>https://carpal.app/sitemaps/shops.xml</loc>');
  });
});
