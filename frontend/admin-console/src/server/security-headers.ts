// Page security headers (AC1.T5; reviewed and completed with the BFF in AC3.T6). Adapted from
// pwa/src/server/security-headers.ts: a nonce-based strict CSP with Trusted Types, no framing, COOP/CORP same-origin,
// and stricter than the PWA where the console allows it: no media or map origins yet (added with AC8/AC9), every
// browser feature off except WebAuthn (passkeys, GD-04), no referrer, and private/no-store/noindex on every page
// (GD-12: the console is internal and every page may carry personal data). Pure functions; the proxy passes the nonce.

export interface CspOptions {
  nonce: string;
  /** next dev: React needs eval for its debug stacks and HMR talks over a WebSocket. */
  dev: boolean;
  https: boolean;
}

/** Next.js's own client and bundler policies, plus the narrow 'default' policy of the boot script (src/lib/theme.ts). */
export const TRUSTED_TYPES_POLICIES = ['nextjs', 'nextjs#bundler', 'default'] as const;

export function contentSecurityPolicy(o: CspOptions): string {
  const join = (...parts: string[]) => parts.filter(Boolean).join(' ');
  const directives: [string, string][] = [
    ['default-src', "'self'"],
    ['script-src', join("'self'", `'nonce-${o.nonce}'`, "'strict-dynamic'", o.dev ? "'unsafe-eval'" : '')],
    ['style-src', join("'self'", `'nonce-${o.nonce}'`)],
    ['img-src', join("'self'", 'data:', 'blob:')],
    ['font-src', "'self'"],
    ['connect-src', join("'self'", o.dev ? 'ws:' : '')],
    ['worker-src', "'none'"],
    ['manifest-src', "'none'"],
    ['frame-src', "'none'"],
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

/** Everything off except passkeys (WebAuthn get/create) on this origin. */
export const PERMISSIONS_POLICY =
  'publickey-credentials-get=(self), publickey-credentials-create=(self), geolocation=(), camera=(), microphone=(), payment=(), usb=(), display-capture=(), browsing-topics=()';

export function pageSecurityHeaders(o: CspOptions & { hsts: boolean }): Record<string, string> {
  return {
    'content-security-policy': contentSecurityPolicy(o),
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': PERMISSIONS_POLICY,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    // GD-12: never cached by the browser or a proxy, never indexed.
    'cache-control': 'private, no-store',
    'x-robots-tag': 'noindex, nofollow',
    ...(o.hsts ? { 'strict-transport-security': 'max-age=63072000; includeSubDomains' } : {}),
  };
}

/** A fresh nonce per response: 128 random bits, base64. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
