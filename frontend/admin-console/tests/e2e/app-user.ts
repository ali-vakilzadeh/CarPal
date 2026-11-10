// E2E helper (AC7.T6): CarPal users and businesses created through the real API, the way the mobile app does it, so
// the console's review suites have Path 2 reviews and objections to work on — never SQL. A user signs up on the auth
// host (proof of work in strict mode), confirms the mailed link, signs in and gets a DPoP-bound cp-mobile token by the
// code flow with PKCE (a public client: no client key needed in either mode). API calls carry a DPoP proof per request
// (nonce retries) and, for ATT operations in strict mode, a proof of work. The PWA's helpers (pwa/tests/e2e) do the
// same as cp-web-consumer, which needs a client key in strict mode; this one does not.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { API, API_AUDIENCE, AUTH, CLIENT_HEADER, newKey, pow, proof, tokenEndpoint, type Key } from './public-api';

const OUTBOX = join(import.meta.dirname, '..', '..', '..', '..', 'backend', '.data', 'outbox-mail.jsonl');
const CLIENT_ID = 'cp-mobile';
const REDIRECT = process.env.CARPAL_E2E_MOBILE_REDIRECT ?? 'https://carpals.ir/oauth/callback';
const b64 = (b: Buffer) => b.toString('base64url');

type Json = Record<string, unknown>;

export interface AppUser {
  email: string;
  name: string;
  /** An API call as this user (a proof of work is added when the server asks for an attestation, ATT in strict mode). */
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Json }>;
}

/** The token of the newest verification link mailed to `to` after `since`. */
async function mailedVerifyToken(to: string, since: string): Promise<string> {
  let token: string | undefined;
  await expect
    .poll(
      () => {
        if (!existsSync(OUTBOX)) return false;
        for (const line of readFileSync(OUTBOX, 'utf8').trim().split('\n').reverse()) {
          const m = JSON.parse(line) as { at: string; to: string; template: string; variables: { link?: string } };
          if (m.to === to && m.template === 'identity.email_verification' && m.at >= since && m.variables.link) {
            token = m.variables.link.split('#')[1];
            return true;
          }
        }
        return false;
      },
      { timeout: 15_000, message: `verification mail to ${to}` },
    )
    .toBe(true);
  return token!;
}

/** True when the server asks for an app attestation (strict mode): the call is repeated with a proof of work. */
async function attestationRequired(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { code?: string };
  return body.code === 'ATTESTATION_REQUIRED';
}

/** A verified user with a cp-mobile access token. */
export async function appUser(prefix: string, name = 'Sara Example'): Promise<AppUser> {
  const email = `ac7-${prefix}-${randomUUID()}@test.carpal.app`;
  const password = `winter tyres ${randomBytes(4).toString('hex')}`;
  const verifier = b64(randomBytes(32));
  const authorize = `${AUTH}/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: 'openid offline_access',
    state: b64(randomBytes(24)),
    nonce: b64(randomBytes(24)),
    code_challenge: b64(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  })}`;
  const start = await fetch(authorize, { redirect: 'manual', headers: { 'carpal-client': CLIENT_HEADER } });
  expect(start.status, await start.clone().text()).toBe(302);
  const interaction = new URL(start.headers.get('location')!).searchParams.get('interaction_id')!;
  const cookie = (start.headers.getSetCookie()[0] ?? '').split(';')[0]!;
  const post = async (path: string, body: unknown) => {
    const send = async (work?: string) =>
      fetch(`${AUTH}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'carpal-client': CLIENT_HEADER,
          'idempotency-key': randomUUID(),
          ...(cookie ? { cookie } : {}),
          ...(work ? { 'carpal-pow': work } : {}),
        },
        body: JSON.stringify(body),
      });
    const res = await send();
    return (await attestationRequired(res)) ? send(await pow()) : res;
  };

  const since = new Date().toISOString();
  const signup = await post('/v1/auth/signup', {
    interaction_id: interaction,
    full_name: name,
    email,
    password,
    locale: 'en',
    terms_version: '1.0',
    privacy_policy_version: '1.0',
  });
  expect(signup.status, await signup.text()).toBe(202);
  const verify = await post('/v1/auth/email/verify', { token: await mailedVerifyToken(email, since) });
  expect(verify.status, await verify.text()).toBe(200);
  const signin = await post('/v1/auth/signin', { interaction_id: interaction, email, password });
  expect(signin.status, await signin.text()).toBe(200);
  const back = await fetch(authorize, { redirect: 'manual', headers: { 'carpal-client': CLIENT_HEADER, ...(cookie ? { cookie } : {}) } });
  expect(back.status, await back.clone().text()).toBe(302);
  const code = new URL(back.headers.get('location')!).searchParams.get('code');
  expect(code, back.headers.get('location') ?? '').toBeTruthy();

  const key = await newKey();
  const token = await codeToken(key, code!, verifier);
  let apiNonce: string | undefined;
  return {
    email,
    name,
    async call(method, path, body) {
      let powValue: string | undefined;
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await fetch(`${API}${path}`, {
          method,
          headers: {
            accept: 'application/json',
            'accept-language': 'en',
            'carpal-client': CLIENT_HEADER,
            'idempotency-key': randomUUID(),
            authorization: `DPoP ${token}`,
            dpop: await proof(key, method, `${API_AUDIENCE}${path.split('?')[0]}`, { token, ...(apiNonce ? { nonce: apiNonce } : {}) }),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(powValue ? { 'carpal-pow': powValue } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const n = res.headers.get('dpop-nonce');
        if (res.status === 401 && n && n !== apiNonce) {
          apiNonce = n;
          continue;
        }
        if (n) apiNonce = n;
        if (!powValue && (await attestationRequired(res))) {
          powValue = await pow();
          continue;
        }
        const text = await res.text();
        return { status: res.status, body: text ? (JSON.parse(text) as Json) : {} };
      }
      throw new Error(`${method} ${path}: too many DPoP nonce retries`);
    },
  };
}

async function codeToken(key: Key, code: string, verifier: string): Promise<string> {
  const htu = await tokenEndpoint();
  let nonce: string | undefined;
  let powValue: string | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${AUTH}/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'carpal-client': CLIENT_HEADER,
        dpop: await proof(key, 'POST', htu, nonce ? { nonce } : {}),
        ...(powValue ? { 'carpal-pow': powValue } : {}),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }).toString(),
    });
    const body = (await res.json()) as { access_token?: string; error?: string; code?: string };
    if (res.ok && body.access_token) return body.access_token;
    if ((body.error ?? body.code) === 'use_dpop_nonce' && res.headers.get('dpop-nonce')) {
      nonce = res.headers.get('dpop-nonce')!;
      // A proof of work is single use and the server took it: solve a new one for the retry.
      if (powValue) powValue = await pow();
      continue;
    }
    if (body.code === 'ATTESTATION_REQUIRED' && !powValue) {
      powValue = await pow();
      continue;
    }
    throw new Error(`code token: ${res.status} ${JSON.stringify(body)}`);
  }
  throw new Error('code token: too many attempts');
}

async function ok(r: Promise<{ status: number; body: Json }>, what: string): Promise<Json> {
  const res = await r;
  expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body;
}

const point = () => ({
  lat: Math.round((35.66 + Math.random() * 0.08) * 1e6) / 1e6,
  lng: Math.round((51.33 + Math.random() * 0.1) * 1e6) / 1e6,
});

export interface Shop {
  id: string;
  name: string;
  owner: AppUser;
}

/** A published provider in Tehran (what the publish check needs: location, profile, a category, a brand), owned by a fresh business user. */
export async function publishedShop(prefix: string): Promise<Shop> {
  const owner = await appUser(`${prefix}-owner`, 'Reza Owner');
  const name = `AC7 Garage ${randomBytes(3).toString('hex')}`;
  const org = await ok(owner.call('POST', '/v1/orgs', { name, organization_type: 'provider', contact_email: 'shop@example.com' }), 'org');
  const id = org.id as string;
  await ok(
    owner.call('POST', `/v1/orgs/${id}/locations`, {
      name: 'Main workshop',
      address_line_1: '14 Sattarkhan Street',
      city: 'Tehran',
      country: 'IR',
      pin: point(),
      public_address_visibility: 'exact',
      timezone: 'Asia/Tehran',
      is_primary: true,
      hours: { weekly: [6, 0, 1, 2, 3].map((d) => ({ day_of_week: d, open: '08:00', close: '18:00' })) },
    }),
    'location',
  );
  const [system, brand] = await Promise.all([firstNode(owner, 'service_system'), firstNode(owner, 'vehicle_brand')]);
  const prv = `/v1/orgs/${id}/provider`;
  await ok(
    owner.call('PUT', `${prv}/profile`, {
      provider_type: 'garage',
      service_modes: ['in_shop'],
      price_tier: 'mid_range',
      warranty_offered: false,
      description_translations: { en: 'Suspension and brakes.', fa: 'جلوبندی و ترمز.' },
      contact_channels: [{ type: 'phone', value: '+982166001122', preferred: true }],
      languages_spoken: ['fa', 'en'],
      response_time_target: 'same_day',
    }),
    'profile',
  );
  await ok(
    owner.call('POST', `${prv}/service-categories`, { taxonomy_node_id: system, experience_level: 'specialist', visibility: 'public' }),
    'category',
  );
  await ok(owner.call('POST', `${prv}/coverage`, { items: [{ brand_node_id: brand, coverage_level: 'specialist' }] }), 'coverage');
  await ok(owner.call('POST', `${prv}/publish`), 'publish');
  return { id, name, owner };
}

async function firstNode(user: AppUser, type: 'service_system' | 'vehicle_brand'): Promise<string> {
  const res = await ok(user.call('GET', `/v1/taxonomy/nodes?type=${type}&limit=5`), 'taxonomy');
  const first = (res.items as { id: string }[] | undefined)?.[0];
  if (!first) throw new Error(`no ${type} node in the taxonomy`);
  return first.id;
}

/** A Path 2 review of the shop by a fresh customer (no visit): pending_approval, waiting for the business. */
export async function path2Review(
  shop: Shop,
  prefix: string,
  o: { rating?: number; body?: string } = {},
): Promise<{ id: string; author: AppUser }> {
  const author = await appUser(`${prefix}-author`, 'Sara Customer');
  const created = await ok(
    author.call('POST', '/v1/reviews', {
      subject_organization_id: shop.id,
      subject_type: 'provider',
      overall_rating: o.rating ?? 2,
      body: o.body ?? `They fixed the noise but it came back after a week (${prefix}).`,
      content_locale: 'en',
    }),
    'review',
  );
  expect(created).toMatchObject({
    status: 'pending_approval',
    confirmation_path: 'approval_based',
    business_confirmation_status: 'pending',
  });
  return { id: created.id as string, author };
}

/** The business answers whether the author was its customer (a rejection opens a review_approval_objection). */
export async function businessAnswers(shop: Shop, reviewId: string, answer: 'confirmed' | 'rejected', note?: string): Promise<void> {
  await ok(
    shop.owner.call('POST', `/v1/orgs/${shop.id}/review-approvals/${reviewId}/answer`, { answer, ...(note ? { note } : {}) }),
    'answer',
  );
}

/** The review as its author sees it (status and verified status after the staff decision). */
export async function authorView(author: AppUser, reviewId: string): Promise<Json> {
  return ok(author.call('GET', `/v1/me/reviews/${reviewId}`), 'my review');
}

// AC8.T6: community content and user reports through the same API.

const BACKEND = join(import.meta.dirname, '..', '..', '..', '..', 'backend');

/** Turns the community flags on in dev (backend `pnpm dev:flags set community on`; posts need community.feed.enabled). */
export function communityOn(): void {
  const tsx = join(BACKEND, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  execFileSync(process.execPath, [tsx, '--conditions=source', 'tools/db/dev-flags-cli.ts', 'set', 'community', 'on'], {
    cwd: BACKEND,
    stdio: 'pipe',
  });
}

/** A published post of the shop (an educational tip: no showcase consent or offer date needed). */
export async function shopPost(shop: Shop, prefix: string): Promise<{ id: string; title: string }> {
  const title = `Brake fluid check ${prefix} ${randomBytes(2).toString('hex')}`;
  const post = await ok(
    shop.owner.call('POST', `/v1/orgs/${shop.id}/posts`, {
      post_type: 'educational_tip',
      title,
      body: `Change the brake fluid every two years; old fluid boils under hard braking (${prefix}).`,
      content_locale: 'en',
      comments_enabled: true,
      visibility: 'public',
    }),
    'post',
  );
  const published = await ok(shop.owner.call('POST', `/v1/orgs/${shop.id}/posts/${post.id as string}/publish`), 'publish post');
  expect(published.status).toBe('published');
  return { id: post.id as string, title };
}

/** A user reports content, an account or an organization (reports.create). */
export async function reportAs(user: AppUser, target: { type: string; id: string }, reason: string, details?: string): Promise<string> {
  const r = await ok(
    user.call('POST', '/v1/reports', { target_type: target.type, target_id: target.id, reason, ...(details ? { details } : {}) }),
    'report',
  );
  return r.report_id as string;
}

/** A post as the public sees it (404 once hidden). */
export async function publicPostStatus(viewer: AppUser, shop: Shop, postId: string): Promise<'visible' | 'gone'> {
  const res = await viewer.call('GET', `/v1/public/orgs/${shop.id}/posts?limit=50`);
  const items = (res.body.items as { id: string }[] | undefined) ?? [];
  return items.some((p) => p.id === postId) ? 'visible' : 'gone';
}
