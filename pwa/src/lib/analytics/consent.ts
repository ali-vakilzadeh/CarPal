// Cookie and tracking consent (Docs/22 §2.5, P3.T6): a first-party cookie records the visitor's choice. Essential
// cookies (session, CSRF, language, theme) need no consent; "analytics" gates every product analytics event
// (GD-17). No cookie = not asked yet = no analytics. Bump CONSENT_VERSION when the purposes change, so everyone is
// asked again.
export const CONSENT_COOKIE = 'cp_consent';
export const CONSENT_VERSION = 1;
export const CONSENT_MAX_AGE_S = 180 * 24 * 60 * 60;

export interface Consent {
  analytics: boolean;
}

/** "v1.a1" = version 1, analytics allowed; anything unreadable or older counts as not asked. */
export function parseConsent(value: string | null | undefined): Consent | null {
  const m = /^v(\d+)\.a([01])$/.exec(value ?? '');
  if (!m || Number(m[1]) !== CONSENT_VERSION) return null;
  return { analytics: m[2] === '1' };
}

export function serializeConsent(c: Consent): string {
  return `v${CONSENT_VERSION}.a${c.analytics ? 1 : 0}`;
}

export function consentCookieString(c: Consent, secure: boolean): string {
  return `${CONSENT_COOKIE}=${serializeConsent(c)}; Path=/; Max-Age=${CONSENT_MAX_AGE_S}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** The consent in document.cookie (browser only). */
export function readConsentCookie(cookieHeader: string): Consent | null {
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === CONSENT_COOKIE) return parseConsent(v.join('='));
  }
  return null;
}
