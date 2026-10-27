// Page security headers (GD-15, SEC-WEB-4, P2.T8): a nonce-based strict CSP with Trusted Types, no framing,
// COOP/CORP same-origin, a Permissions-Policy that allows only geolocation and camera (consumer origin), and
// strict-origin-when-cross-origin referrers. Pure functions: the proxy passes the per-request nonce and the origins.

export interface CspOptions {
  nonce: string;
  /** next dev: React needs eval for its debug stacks and HMR talks over a WebSocket. */
  dev: boolean;
  https: boolean;
  /** Signed media and upload URLs (storage listener in dev, media.carpal-usercontent.app in prod; BA-06). */
  mediaOrigins: readonly string[];
  /** Vector tiles and the map style (GD-12); empty until a style URL is configured. */
  tileOrigins: readonly string[];
  /**
   * frame-src blob: for the in-place PDF preview of private documents (W-GAR-02, P7): documents are served as
   * attachments (SEC-UP-4), so the garage reads them into a blob and frames that. Only pages that need it.
   */
  documentFrames?: boolean;
}

/**
 * Trusted Types policies the app may create: Next.js's own client policy and its bundler policy, plus 'default'
 * (P3): Next.js 16.4.3's Turbopack runtime loads lazy chunks with a plain script.src assignment and React creates
 * <script> elements through innerHTML, so the boot script (src/lib/theme.ts BOOT_SCRIPT) installs a narrow default
 * policy — same-origin /_next/static/ script URLs, and HTML that cannot create markup.
 */
export const TRUSTED_TYPES_POLICIES = ['nextjs', 'nextjs#bundler', 'default'] as const;

export function contentSecurityPolicy(o: CspOptions): string {
  const media = o.mediaOrigins.join(' ');
  const tiles = o.tileOrigins.join(' ');
  const join = (...parts: string[]) => parts.filter(Boolean).join(' ');
  const directives: [string, string][] = [
    ['default-src', "'self'"],
    ['script-src', join("'self'", `'nonce-${o.nonce}'`, "'strict-dynamic'", o.dev ? "'unsafe-eval'" : '')],
    ['style-src', join("'self'", `'nonce-${o.nonce}'`)],
    ['img-src', join("'self'", 'data:', 'blob:', media, tiles)],
    ['media-src', join("'self'", 'blob:', media)],
    ['font-src', "'self'"],
    ['connect-src', join("'self'", media, tiles, o.dev ? 'ws:' : '')],
    ['worker-src', "'self'"],
    ['manifest-src', "'self'"],
    ['frame-src', o.documentFrames ? 'blob:' : "'none'"],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['form-action', "'self'"],
    ['frame-ancestors', "'none'"],
  ];
  // Next.js dev (React refresh, the error overlay) assigns HTML and script URLs without a policy; production does not.
  if (!o.dev) {
    directives.push(['require-trusted-types-for', "'script'"]);
    directives.push(['trusted-types', TRUSTED_TYPES_POLICIES.join(' ')]);
  }
  if (o.https) directives.push(['upgrade-insecure-requests', '']);
  return directives.map(([k, v]) => (v ? `${k} ${v}` : k)).join('; ');
}

export const PERMISSIONS_POLICY =
  'geolocation=(self), camera=(self), microphone=(), payment=(), usb=(), display-capture=(), browsing-topics=()';

export function pageSecurityHeaders(o: CspOptions & { hsts: boolean }): Record<string, string> {
  return {
    'content-security-policy': contentSecurityPolicy(o),
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': PERMISSIONS_POLICY,
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...(o.hsts ? { 'strict-transport-security': 'max-age=63072000; includeSubDomains; preload' } : {}),
  };
}

/** A fresh nonce per response: 128 random bits, base64. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** Origins of a list of URLs (invalid or empty entries skipped). */
export function originsOf(...urls: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    try {
      out.add(new URL(u).origin);
    } catch {
      // ignore
    }
  }
  return [...out];
}

/**
 * Signed-in tools and other private pages (Docs/22 §6): never cached, never indexed. Locale-prefixed app routes, the
 * hosted sign-in (/id) and the link-token pages (/l).
 */
export const PRIVATE_SECTIONS = new Set([
  'home',
  'garage',
  'help',
  'appointments',
  'review',
  'settings',
  'notifications',
  'saved',
  'activity',
  'onboarding',
  'login',
  'signup',
]);

/** Pages that preview private PDFs in a frame (W-GAR-01/02: /<locale>/garage/…). */
export function framesDocuments(pathname: string, locales: readonly string[]): boolean {
  const [first, second] = pathname.split('/').slice(1);
  return !!first && locales.includes(first) && second === 'garage';
}

export function isPrivatePage(pathname: string, locales: readonly string[]): boolean {
  const [first, second] = pathname.split('/').slice(1);
  if (first === 'id' || first === 'l') return true;
  return !!first && locales.includes(first) && !!second && PRIVATE_SECTIONS.has(second);
}
