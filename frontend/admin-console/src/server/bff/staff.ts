// admin.staff_me from the BFF itself (AC3.T2, AC2 notes_for_next): called right after the code exchange and after every
// token refresh, so /bff/session can show the staff member's name, roles, language, time zone and session end
// without the browser ever holding a token. Replaces the PWA's me.get on the api host (GD-07 amendment: the api host
// refuses cp-web-admin tokens).
import type { JWK } from 'jose';
import { ADMIN_OPERATIONS } from '@/lib/api/generated';
import type { StaffMe } from '@carpal/api-contracts';
import { staffRolesOf } from '@/lib/roles';
import { clientHeader, type BffConfig } from './config';
import { dpopProof } from './oauth/dpop';
import type { StaffProfile } from './session/types';

export interface StaffFetch {
  config: Pick<BffConfig, 'adminApiUrl' | 'adminApiAudience' | 'clientId' | 'clientVersion'>;
  fetch: typeof fetch;
}

const STAFF_ME = ADMIN_OPERATIONS['admin.staff_me'];

/** Maps admin.staff_me to the session's profile; null when the body does not have the contract's shape. */
export function staffProfileOf(me: Partial<StaffMe>): StaffProfile | null {
  const expires = typeof me.session_expires_at === 'string' ? Date.parse(me.session_expires_at) : NaN;
  if (typeof me.user_id !== 'string' || !Array.isArray(me.platform_roles) || !Number.isFinite(expires)) return null;
  return {
    userId: me.user_id,
    displayName: typeof me.display_name === 'string' ? me.display_name : '',
    locale: typeof me.locale === 'string' ? me.locale : '',
    timezone: typeof me.timezone === 'string' ? me.timezone : '',
    roles: staffRolesOf(me.platform_roles),
    sessionExpiresAt: expires,
  };
}

/**
 * GET /v1/admin/me with the given token. null when the backend refuses it (not a staff session, roles revoked) or is
 * unreachable; the caller decides what that means (sign-in fails; a refresh keeps the previous profile).
 */
export async function loadStaffProfile(accessToken: string, dpopKey: JWK | undefined, d: StaffFetch): Promise<StaffProfile | null> {
  try {
    const res = await d.fetch(`${d.config.adminApiUrl}${STAFF_ME.path}`, {
      headers: {
        authorization: `${dpopKey ? 'DPoP' : 'Bearer'} ${accessToken}`,
        ...(dpopKey
          ? { dpop: await dpopProof(dpopKey, { method: 'GET', url: `${d.config.adminApiAudience}${STAFF_ME.path}`, accessToken }) }
          : {}),
        'carpal-client': clientHeader(d.config.clientId, d.config.clientVersion),
        accept: 'application/json',
      },
      redirect: 'manual',
    });
    if (!res.ok) return null;
    return staffProfileOf((await res.json()) as Partial<StaffMe>);
  } catch {
    return null;
  }
}
