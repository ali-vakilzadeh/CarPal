import { describe, expect, it } from 'vitest';
import {
  distanceKm,
  isBlockedAddress,
  MapLinkResolver,
  parseMapLink,
  publicPoint,
  round2,
  validateBBox,
  type MapLinkHost,
} from './index.js';

const hosts: MapLinkHost[] = [
  { host: 'www.google.com', provider_key: 'google', short_link: false },
  { host: 'maps.app.goo.gl', provider_key: 'google', short_link: true },
  { host: 'www.openstreetmap.org', provider_key: 'osm', short_link: false },
  { host: 'balad.ir', provider_key: 'balad', short_link: false },
  { host: 'neshan.org', provider_key: 'neshan', short_link: false },
];

describe('geo math', () => {
  it('rounds like numeric round(x, 2) and keeps exact points', () => {
    expect(round2(35.705)).toBe(35.71);
    expect(round2(-35.705)).toBe(-35.71);
    expect(round2(51.004999)).toBe(51);
    expect(publicPoint({ lat: 35.689198, lng: 51.388973 }, 'approximate')).toEqual({ lat: 35.69, lng: 51.39 });
    expect(publicPoint({ lat: 35.689198, lng: 51.388973 }, 'exact')).toEqual({ lat: 35.689198, lng: 51.388973 });
    expect(distanceKm({ lat: 35.6892, lng: 51.389 }, { lat: 35.8327, lng: 50.9915 })).toBeCloseTo(39.2, 0);
  });

  it('validates bounding boxes', () => {
    expect(validateBBox({ south: 35.6, west: 51.2, north: 35.8, east: 51.5 }, 0.6)).toEqual([]);
    expect(validateBBox({ south: 35.9, west: 51.2, north: 35.8, east: 52.0 }, 0.6).map((e) => e.code)).toEqual(['order', 'out_of_range']);
  });
});

describe('parseMapLink', () => {
  it('reads coordinates from full links of allowlisted hosts', () => {
    expect(parseMapLink('https://www.google.com/maps/place/X/@35.7,51.4,15z/data=!3d35.6997!4d51.3381', hosts)).toEqual({
      lat: 35.6997,
      lng: 51.3381,
      provider_key: 'google',
    });
    expect(parseMapLink('https://www.google.com/maps?q=35.71,51.42', hosts)).toMatchObject({ lat: 35.71, lng: 51.42 });
    expect(parseMapLink('https://www.openstreetmap.org/?mlat=35.7&mlon=51.4#map=17/35.7/51.4', hosts)).toMatchObject({
      provider_key: 'osm',
      lat: 35.7,
    });
    expect(parseMapLink('https://balad.ir/location?latitude=35.75&longitude=51.41', hosts)).toMatchObject({
      provider_key: 'balad',
      lng: 51.41,
    });
    expect(parseMapLink('https://neshan.org/maps/@35.699739,51.338097,15.0z', hosts)).toMatchObject({ lat: 35.699739 });
  });

  it('refuses other hosts, IPs, credentials and http', () => {
    expect(() => parseMapLink('https://evil.example/@35.7,51.4', hosts)).toThrow(expect.objectContaining({ code: 'MAP_LINK_UNSUPPORTED' }));
    expect(() => parseMapLink('http://www.google.com/maps?q=1,2', hosts)).toThrow(
      expect.objectContaining({ code: 'MAP_LINK_UNSUPPORTED' }),
    );
    expect(() => parseMapLink('https://user:pw@www.google.com/maps?q=1,2', hosts)).toThrow(
      expect.objectContaining({ code: 'MAP_LINK_UNSUPPORTED' }),
    );
    expect(() => parseMapLink('https://169.254.169.254/latest', hosts)).toThrow(expect.objectContaining({ code: 'MAP_LINK_UNSUPPORTED' }));
    expect(() => parseMapLink('https://www.google.com/maps/search/garage', hosts)).toThrow(
      expect.objectContaining({ code: 'MAP_LINK_UNRESOLVED' }),
    );
    expect(parseMapLink('https://maps.app.goo.gl/AbCd', hosts)).toHaveProperty('shortLink');
  });
});

describe('SSRF guard', () => {
  it('classifies refused addresses', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '64:ff9b::10.0.0.1',
      '::ffff:7f00:1',
      'not-an-ip',
    ]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '142.250.185.78', '2a00:1450:4001:82a::200e']) expect(isBlockedAddress(a), a).toBe(false);
  });

  it('follows allowlisted redirects with pinned DNS and stops on refused ones', async () => {
    const calls: string[] = [];
    const resolver = (map: Record<string, string>, addresses: Record<string, string> = {}) =>
      new MapLinkResolver({
        lookup: async (h) => [{ address: addresses[h] ?? '142.250.185.78', family: 4 }],
        transport: async (url, address) => {
          calls.push(`${url.hostname}@${address}`);
          const location = map[url.toString()];
          return location ? { status: 302, location } : { status: 200 };
        },
      });
    const ok = resolver({ 'https://maps.app.goo.gl/AbCd': 'https://www.google.com/maps/place/X/@35.7,51.4,15z' });
    await expect(ok.resolve('https://maps.app.goo.gl/AbCd', hosts)).resolves.toEqual({ lat: 35.7, lng: 51.4, provider_key: 'google' });
    expect(calls).toEqual(['maps.app.goo.gl@142.250.185.78']);

    const offList = resolver({ 'https://maps.app.goo.gl/AbCd': 'https://evil.example/@35.7,51.4' });
    await expect(offList.resolve('https://maps.app.goo.gl/AbCd', hosts)).rejects.toMatchObject({ code: 'MAP_LINK_UNRESOLVED' });

    const rebinding = resolver({}, { 'maps.app.goo.gl': '127.0.0.1' });
    await expect(rebinding.resolve('https://maps.app.goo.gl/AbCd', hosts)).rejects.toMatchObject({
      code: 'MAP_LINK_UNRESOLVED',
      detail: 'host resolves to a refused address',
    });

    const loop = resolver({ 'https://maps.app.goo.gl/AbCd': 'https://maps.app.goo.gl/AbCd' });
    await expect(loop.resolve('https://maps.app.goo.gl/AbCd', hosts)).rejects.toMatchObject({ detail: 'too many redirects' });
  });
});
