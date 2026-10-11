// Who is calling (L3 output, L4 input). Tokens carry no roles (SEC-AU-3):
// roles and memberships are resolved per request by libs/authz.

export type Acr = 'aal1' | 'aal2' | 'aal3';

/** No token presented (PUB(no token) routes only). */
export interface NoPrincipal {
  kind: 'none';
}

/** Anonymous client token (SEC-AU-14): attributable to a device key, no user. */
export interface AnonymousPrincipal {
  kind: 'anonymous';
  clientId: string;
  tokenId: string;
  /** Hash of the device key, used as RLS anon_key and rate-limit key. */
  anonKey: string;
  scopes: string[];
}

/** A signed-in user on the api host, or a staff member on the admin host. */
export interface UserPrincipal {
  kind: 'user' | 'staff';
  userId: string;
  clientId: string;
  sessionId: string;
  acr: Acr;
  /** Epoch seconds of the last authentication (step-up window, SEC-AU-10). */
  authTime: number;
  tokenId: string;
  scopes: string[];
}

export type Principal = NoPrincipal | AnonymousPrincipal | UserPrincipal;

export const isUser = (p: Principal): p is UserPrincipal => p.kind === 'user' || p.kind === 'staff';

/** Stable key of the caller for rate limits, idempotency and cursors. */
export function principalKey(p: Principal): string {
  switch (p.kind) {
    case 'user':
    case 'staff':
      return `u:${p.userId}`;
    case 'anonymous':
      return `a:${p.anonKey}`;
    default:
      return 'none';
  }
}
