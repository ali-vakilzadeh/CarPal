// E2E helper (AC6.T6): reads config.client on the api host as an anonymous client, the way every CarPal app gets
// its flags and exchange rates. The console's own BFF cannot do it: the api host refuses admin tokens (BR-18), and
// the console forwards admin-api operations only. So the test asks the auth host for an anonymous cp-mobile token
// (SEC-AU-14: DPoP-bound; in strict mode the attestation is a proof of work, SEC-BF-7) and calls config.client with
// a DPoP proof, like the PWA BFF does for visitors (pwa/src/server/bff/oauth/token-client.ts).
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

const AUTH = process.env.CARPAL_AUTH_URL ?? 'http://127.0.0.1:8082';
const API = process.env.CARPAL_API_URL ?? 'http://127.0.0.1:8080';
// DPoP proofs name the public URLs (htu): the issuer's token endpoint and the api audience, not the local ports.
const API_AUDIENCE = process.env.CARPAL_API_AUDIENCE ?? 'https://api.carpals.ir';
const CLIENT_ID = 'cp-mobile';
const CLIENT_HEADER = 'cp-mobile/1.0.0 (android 14)';

export interface ClientConfig {
  flags: { key: string; enabled: boolean }[];
  region: { currency: string; display_currencies: string[]; exchange_rates: { currency: string; per_usd: string; updated_at: string }[] };
}

interface Key {
  privateKey: CryptoKey;
  publicJwk: JWK;
}

async function newKey(): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  return { privateKey, publicJwk: await exportJWK(publicKey) };
}

const b64url = (buf: Buffer) => buf.toString('base64url');

async function proof(key: Key, method: string, url: string, o: { token?: string; nonce?: string } = {}): Promise<string> {
  const u = new URL(url);
  const claims: Record<string, unknown> = { htm: method, htu: `${u.protocol}//${u.host}${u.pathname}`, jti: b64url(randomBytes(16)) };
  if (o.token) claims.ath = b64url(createHash('sha256').update(o.token).digest());
  if (o.nonce) claims.nonce = o.nonce;
  return new SignJWT(claims).setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: key.publicJwk }).setIssuedAt().sign(key.privateKey);
}

function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/** auth.pow_challenge + a solution: the CarPal-PoW header value. */
async function pow(): Promise<string> {
  const res = await fetch(`${AUTH}/oauth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'carpal-client': CLIENT_HEADER },
    body: JSON.stringify({ purpose: 'anonymous' }),
  });
  if (!res.ok) throw new Error(`pow challenge: ${res.status} ${await res.text()}`);
  const c = (await res.json()) as { challenge_id: string; prefix: string; difficulty_bits: number };
  for (let i = 0; ; i++) {
    if (
      leadingZeroBits(
        createHash('sha256')
          .update(c.prefix + i)
          .digest(),
      ) >= c.difficulty_bits
    )
      return `${c.challenge_id}.${i}`;
    if (i % 20_000 === 0) await new Promise<void>((r) => setImmediate(r));
  }
}

async function tokenEndpoint(): Promise<string> {
  const res = await fetch(`${AUTH}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`discovery: ${res.status}`);
  return ((await res.json()) as { token_endpoint: string }).token_endpoint;
}

async function anonymousToken(key: Key): Promise<string> {
  const url = `${AUTH}/oauth/token`;
  const htu = await tokenEndpoint();
  let nonce: string | undefined;
  let powValue: string | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      'carpal-client': CLIENT_HEADER,
      dpop: await proof(key, 'POST', htu, nonce ? { nonce } : {}),
    };
    if (powValue) headers['carpal-pow'] = powValue;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ grant_type: 'urn:carpal:params:oauth:grant-type:anonymous', client_id: CLIENT_ID }).toString(),
    });
    const body = (await res.json()) as { access_token?: string; error?: string; code?: string };
    if (res.ok && body.access_token) return body.access_token;
    const error = body.error ?? body.code;
    if (error === 'use_dpop_nonce' && res.headers.get('dpop-nonce')) {
      nonce = res.headers.get('dpop-nonce')!;
      // A challenge is single use and the server already took it: solve a new one for the retry.
      if (powValue) powValue = await pow();
    } else if (error === 'ATTESTATION_REQUIRED' && !powValue) powValue = await pow();
    else throw new Error(`anonymous token: ${res.status} ${JSON.stringify(body)}`);
  }
  throw new Error('anonymous token: too many attempts');
}

/** GET /v1/config/client on the api host, anonymously (what the PWA and the apps read). */
export async function readClientConfig(locale: 'en' | 'fa' = 'en'): Promise<ClientConfig> {
  const key = await newKey();
  const token = await anonymousToken(key);
  const url = `${API}/v1/config/client`;
  let nonce: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        'accept-language': locale,
        'carpal-client': CLIENT_HEADER,
        authorization: `DPoP ${token}`,
        dpop: await proof(key, 'GET', `${API_AUDIENCE}/v1/config/client`, { token, ...(nonce ? { nonce } : {}) }),
      },
    });
    if (res.ok) return (await res.json()) as ClientConfig;
    const n = res.headers.get('dpop-nonce');
    if (res.status === 401 && n && n !== nonce) {
      nonce = n;
      continue;
    }
    throw new Error(`config.client: ${res.status} ${await res.text()}`);
  }
  throw new Error('config.client: too many attempts');
}

export const rateOf = (c: ClientConfig, currency: string): number =>
  Number(c.region.exchange_rates.find((r) => r.currency === currency)?.per_usd ?? NaN);

export const flagOf = (c: ClientConfig, key: string): boolean | undefined => c.flags.find((f) => f.key === key)?.enabled;
