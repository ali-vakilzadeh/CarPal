// Map links (40 SEC-IN-9, geo.resolve_map_link): a full map URL is parsed
// locally (coordinate patterns per provider, no network call). A short link is
// expanded only when its host is in the region's map_link_hosts allowlist:
// DNS resolved once and pinned, private/loopback/link-local/metadata ranges
// refused, no cookies or credentials, at most 3 redirects each re-checked
// against the allowlist, only the Location header read (no body), 3 s timeout,
// and the final URL parsed locally like a full URL.
import { lookup as dnsLookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { ApiError } from '#libs/contract/index.js';

export interface MapLinkHost {
  host: string;
  provider_key: string;
  short_link: boolean;
}

export interface ResolvedPoint {
  lat: number;
  lng: number;
  provider_key: string;
}

const NUM = String.raw`(-?\d{1,3}(?:\.\d{1,15})?)`;
/** Coordinate patterns, tried in order on the decoded URL (path, query and fragment). */
const PATTERNS: RegExp[] = [
  new RegExp(String.raw`!3d${NUM}!4d${NUM}`), // Google place data (most precise)
  new RegExp(String.raw`@${NUM},${NUM}`), // /maps/@lat,lng,zoom (Google, Neshan)
  new RegExp(String.raw`[?&](?:q|query|ll|destination|daddr|center)=(?:loc:)?${NUM},\s?${NUM}`),
  new RegExp(String.raw`[?&]mlat=${NUM}&mlon=${NUM}`), // OpenStreetMap marker
  new RegExp(String.raw`[?&]latitude=${NUM}&longitude=${NUM}`), // Balad
  new RegExp(String.raw`#map=\d{1,2}/${NUM}/${NUM}`), // OpenStreetMap view
  new RegExp(String.raw`#\d{1,2}(?:\.\d+)?/${NUM}/${NUM}`), // Balad view
];

function hostEntry(url: URL, hosts: MapLinkHost[]): MapLinkHost | undefined {
  return hosts.find((h) => h.host === url.hostname.toLowerCase());
}

function strictUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ApiError('MAP_LINK_UNRESOLVED', { detail: 'not a URL' });
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    isIP(url.hostname.replace(/^\[|\]$/g, ''))
  ) {
    throw new ApiError('MAP_LINK_UNSUPPORTED', { detail: 'only https links without credentials, ports or IP hosts' });
  }
  return url;
}

/** Parses coordinates from a full map URL of an allowlisted host. No network access. */
export function parseMapLink(input: string, hosts: MapLinkHost[]): ResolvedPoint | { shortLink: URL; host: MapLinkHost } {
  if (input.length > 2048) throw new ApiError('MAP_LINK_UNRESOLVED', { detail: 'URL too long' });
  const url = strictUrl(input);
  const host = hostEntry(url, hosts);
  if (!host) throw new ApiError('MAP_LINK_UNSUPPORTED');
  let text: string;
  try {
    text = decodeURIComponent(`${url.pathname}${url.search}${url.hash}`);
  } catch {
    text = `${url.pathname}${url.search}${url.hash}`;
  }
  for (const p of PATTERNS) {
    const m = p.exec(text);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0)) {
      return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), provider_key: host.provider_key };
    }
  }
  if (host.short_link) return { shortLink: url, host };
  throw new ApiError('MAP_LINK_UNRESOLVED', { detail: 'no coordinates in the link' });
}

// ------------------------------------------------------------- SSRF guard

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64 (checked again through the embedded IPv4)
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** True for private, loopback, link-local, metadata, multicast, documentation and reserved addresses. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return blocked.check(mapped[1]!, 'ipv4');
  if (lower.startsWith('::ffff:')) return true; // hex-form mapped addresses: refuse rather than decode
  return blocked.check(address, 'ipv6');
}

/** One hop: connect to the pinned address and read only the status and Location header. */
export type ResolverTransport = (
  url: URL,
  address: string,
  family: 4 | 6,
  timeoutMs: number,
) => Promise<{ status: number; location?: string }>;

const httpsTransport: ResolverTransport = (url, address, family, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        servername: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { 'user-agent': 'CarPal-MapLink/1', accept: '*/*' }, // no cookies, no credentials
        lookup: (_h, _o, cb) => cb(null, address, family), // DNS pinned to the checked address
        timeout: timeoutMs,
      },
      (res) => {
        const location = res.headers.location;
        res.destroy(); // never read the body
        resolve({ status: res.statusCode ?? 0, ...(location ? { location } : {}) });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });

export interface ResolverOptions {
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  transport?: ResolverTransport;
  timeoutMs?: number;
  maxRedirects?: number;
}

export class MapLinkResolver {
  constructor(private readonly o: ResolverOptions = {}) {}

  async resolve(input: string, hosts: MapLinkHost[]): Promise<ResolvedPoint> {
    const first = parseMapLink(input, hosts);
    if (!('shortLink' in first)) return first;
    const deadline = Date.now() + (this.o.timeoutMs ?? 3_000);
    const maxRedirects = this.o.maxRedirects ?? 3;
    const lookup = this.o.lookup ?? ((h: string) => dnsLookup(h, { all: true, verbatim: true }));
    const transport = this.o.transport ?? httpsTransport;
    let url = first.shortLink;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ApiError('MAP_LINK_UNRESOLVED', { detail: 'timeout' });
      const addresses = await lookup(url.hostname).catch(() => []);
      if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
        throw new ApiError('MAP_LINK_UNRESOLVED', { detail: 'host resolves to a refused address' });
      }
      const target = addresses[0]!;
      let res: { status: number; location?: string };
      try {
        res = await transport(url, target.address, target.family === 6 ? 6 : 4, remaining);
      } catch (err) {
        throw new ApiError('MAP_LINK_UNRESOLVED', { detail: `expansion failed: ${(err as Error).message}` });
      }
      if (res.status >= 300 && res.status < 400 && res.location) {
        let next: URL;
        try {
          next = strictUrl(new URL(res.location, url).toString());
        } catch {
          throw new ApiError('MAP_LINK_UNRESOLVED', { detail: 'redirect to a refused URL' });
        }
        if (!hostEntry(next, hosts)) throw new ApiError('MAP_LINK_UNRESOLVED', { detail: 'redirect leaves the allowlist' });
        const parsed = parseMapLink(next.toString(), hosts);
        if (!('shortLink' in parsed)) return parsed;
        url = parsed.shortLink;
        continue;
      }
      throw new ApiError('MAP_LINK_UNRESOLVED', { detail: `short link answered ${res.status}` });
    }
    throw new ApiError('MAP_LINK_UNRESOLVED', { detail: 'too many redirects' });
  }
}
