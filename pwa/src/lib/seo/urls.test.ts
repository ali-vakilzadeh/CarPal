import { describe, expect, it } from 'vitest';
import { idSlug, inLocale, orgPath, parseIdSlug, partPath, sellerPath, shopPath, showcasePath, slugify } from './urls';

const ID = '01a17000-0000-7000-8000-0000000000f1';

describe('public URLs (Docs/22 §6, DI-13)', () => {
  it('slugifies Latin and Persian text and keeps zero-width joiners inside words', () => {
    expect(slugify('Front Control-Arm (E90)!')).toBe('front-control-arm-e90');
    expect(slugify('Lemförder 31126769717')).toBe('lemförder-31126769717');
    expect(slugify('طبق جلو')).toBe('طبق-جلو');
    expect(slugify('نیم‌گرد')).toBe('نیمگرد');
    expect(slugify('—')).toBe('');
  });

  it('cuts long slugs at a word, never past 60 characters', () => {
    const slug = slugify('word '.repeat(40));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('builds and parses <id>-<slug> segments', () => {
    expect(idSlug(ID, 'Front control arm')).toBe(`${ID}-front-control-arm`);
    expect(idSlug(ID, '!!!')).toBe(ID);
    expect(parseIdSlug(`${ID}-front-control-arm`)).toEqual({ id: ID, slug: 'front-control-arm' });
    expect(parseIdSlug(ID.toUpperCase())).toEqual({ id: ID, slug: '' });
    expect(parseIdSlug(encodeURIComponent(`${ID}-طبق-جلو`))).toEqual({ id: ID, slug: 'طبق-جلو' });
    expect(parseIdSlug('not-an-id')).toBeNull();
    expect(parseIdSlug('%E0%A4%A')).toBeNull();
  });

  it('builds page paths and swaps the language segment', () => {
    expect(shopPath('fa', 'reza-auto')).toBe('/fa/shop/reza-auto');
    expect(sellerPath('en', 'mina-parts')).toBe('/en/parts-seller/mina-parts');
    expect(partPath('en', 'mina-parts', ID, 'Front control arm')).toBe(`/en/parts/mina-parts/${ID}-front-control-arm`);
    expect(showcasePath('fa', ID, 'Arm replaced')).toBe(`/fa/post/${ID}-arm-replaced`);
    expect(inLocale('/fa/shop/x', 'en')).toBe('/en/shop/x');
    expect(inLocale('/fa', 'en')).toBe('/en');
  });

  it('links an organization to its shop page (providers, hybrids) or its seller page', () => {
    expect(orgPath('en', { slug: 'a', roles: ['provider', 'vendor'] })).toBe('/en/shop/a');
    expect(orgPath('en', { slug: 'b', roles: ['vendor'] })).toBe('/en/parts-seller/b');
    expect(orgPath('en', { slug: null, roles: ['vendor'] })).toBeNull();
  });
});
