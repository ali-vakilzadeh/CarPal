// The staff sign-in's calls to the auth host (AC4.T1, GD-04): the /v1/auth/* operations of contract 1.3.0 that the
// console's /id proxy forwards (src/server/bff/auth-proxy.ts), typed from @carpal/api-contracts. Same origin, so the
// auth host's interaction cookie (__Host-cp_ia) travels by itself and the browser sends Origin and Sec-Fetch-Site,
// which the proxy checks. An ATT operation (auth.signin_password, auth.password_reset_start) that the auth host
// refuses with 403 ATTESTATION_REQUIRED (strict mode) is sent once more with a solved proof of work (SEC-BF-7), as
// the PWA's client does. Failures become ApiProblem (src/lib/api/problem.ts). Never logs a body (GD-12).
import { OPERATIONS, type OperationInput, type OperationResponse } from '@carpal/api-contracts';
import { ApiProblem, problemFrom } from '@/lib/api/problem';
import { uuidv7 } from '@/lib/api/uuid';

/** The auth operations the staff sign-in uses. */
export type AuthOperationId =
  | 'auth.signin_password'
  | 'auth.passkey_enrol_options'
  | 'auth.passkey_enrol'
  | 'auth.webauthn_options'
  | 'auth.mfa_verify'
  | 'auth.password_reset_start';

export type PowPurpose = 'signin';

export interface AuthClientOptions {
  fetch?: typeof fetch;
  /** Solves a proof-of-work challenge and returns the CarPal-Pow header value. */
  solvePow?: (purpose: PowPurpose) => Promise<string>;
  /** The page language (Accept-Language). */
  locale?: () => string;
}

export interface AuthClient {
  call<Id extends AuthOperationId>(opId: Id, body: OperationInput<Id>): Promise<OperationResponse<Id>>;
}

/** The /id path of an auth operation (the proxy maps /id/v1/auth/* to the auth host's /v1/auth/*). */
export function authPath(opId: AuthOperationId): string {
  const route = OPERATIONS[opId].routes.find((r) => r.host === 'auth');
  if (!route) throw new Error(`${opId} has no auth-host route`);
  return `/id${route.path}`;
}

export function createAuthClient(o: AuthClientOptions = {}): AuthClient {
  const doFetch = o.fetch ?? ((input, init) => fetch(input, init));
  return {
    async call(opId, body) {
      const op = OPERATIONS[opId];
      const send = async (pow?: string) => {
        const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json; charset=utf-8' });
        if (o.locale) headers.set('accept-language', o.locale());
        if (op.idem) headers.set('idempotency-key', uuidv7());
        if (pow) headers.set('carpal-pow', pow);
        try {
          return await doFetch(authPath(opId), {
            method: op.method,
            headers,
            body: JSON.stringify(body),
            credentials: 'same-origin',
            cache: 'no-store',
          });
        } catch (err) {
          throw new ApiProblem(0, { code: 'NETWORK', title: err instanceof Error ? err.name : 'network' });
        }
      };
      let res = await send();
      if (!res.ok && res.status === 403 && op.att && o.solvePow) {
        const problem = await problemFrom(res.clone());
        if (problem.code === 'ATTESTATION_REQUIRED') res = await send(await o.solvePow('signin'));
      }
      if (!res.ok) throw await problemFrom(res);
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as OperationResponse<typeof opId>;
    },
  };
}

/** auth.pow_challenge through the /id proxy, solved off the main thread (copied from pwa/src/lib/api/browser.ts). */
export async function browserPow(purpose: PowPurpose, doFetch: typeof fetch = (i, init) => fetch(i, init)): Promise<string> {
  const { solvePowChallenge } = await import('@/lib/api/pow');
  const res = await doFetch('/id/oauth/challenge', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ purpose }),
  });
  if (!res.ok) throw await problemFrom(res);
  const c = (await res.json()) as { challenge_id: string; prefix: string; difficulty_bits: number };
  return `${c.challenge_id}.${await solvePowChallenge(c.prefix, c.difficulty_bits)}`;
}
