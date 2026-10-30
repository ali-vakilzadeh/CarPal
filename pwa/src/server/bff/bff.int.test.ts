// P2.T9 integration: the BFF against the live backend in lite mode (`pnpm dev` in backend/ with the env of GD-05:
// CARPAL_OAUTH_REDIRECT_URIS listing https://localhost:3000/bff/oauth/callback; CARPAL_RATE_LIMIT_SCALE=100 keeps the
// auth buckets out of the way, BA-25). The hosted sign-in UI does not exist yet (P4), so the test plays the browser:
// /bff/login → /id/oauth/authorize (proxied) → /id/v1/auth/* → /id/oauth/authorize again → /bff/oauth/callback.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from './crypto';
import { DEFAULT_LIFETIMES } from './config';
import { createBff, type Bff } from './index';
import { LiteSessionStore } from './session/store';
import { Browser } from './test-support';
import { secretOf, totp } from '../../../tests/support/totp';
import { CONSUMER_TEMPLATE_KEYS } from '@/features/notifications/catalog';

const API = process.env.CARPAL_API_URL ?? 'http://127.0.0.1:8080';
const AUTH = process.env.CARPAL_AUTH_URL ?? 'http://127.0.0.1:8082';
const OUTBOX = join(import.meta.dirname, '..', '..', '..', '..', 'backend', '.data', 'outbox-mail.jsonl');
const PASSWORD = 'correct horse battery staple';
// Docs/40 Url is https-only, so the registered redirect URI is https://localhost:3000/bff/oauth/callback (the BFF
// handler is called directly here; no server listens on that origin).
const ORIGIN = 'https://localhost:3000';

interface Seen {
  url: string;
  method: string;
}

let bff: Bff;
let store: LiteSessionStore;
const clock = { offset: 0 };
const upstream: Seen[] = [];
const browserSaw: string[] = [];

beforeAll(async () => {
  const health = await fetch(`${API}/v1/health`).catch(() => null);
  if (!health?.ok) throw new Error(`backend not reachable at ${API}: run \`pnpm dev\` in backend/ with the env of pwa/README.md`);
  store = new LiteSessionStore({ sweepMs: 0 });
  bff = createBff({
    config: {
      origin: ORIGIN,
      apiUrl: API,
      authUrl: AUTH,
      apiAudience: 'https://api.carpal.app',
      clientId: 'cp-web-consumer',
      ssrClientId: 'cp-ssr',
      clientVersion: '0.1.0',
      strict: false,
      locales: ['fa', 'en'],
      ...DEFAULT_LIFETIMES,
    },
    store,
    now: () => Date.now() + clock.offset,
    fetch: async (input, init) => {
      upstream.push({ url: String(input), method: init?.method ?? 'GET' });
      return fetch(input, init);
    },
  });
});

/** A browser that records every response it receives (headers and body) for the "no tokens in the browser" check. */
class RecordingBrowser extends Browser {
  constructor(b: Bff) {
    super(b, ORIGIN);
  }

  override async fetch(path: string, init: RequestInit & { site?: string } = {}): Promise<Response> {
    const res = await super.fetch(path, init);
    const body = await res.clone().text();
    browserSaw.push([...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n'), body);
    return res;
  }
}

function verificationToken(email: string): string {
  const lines = readFileSync(OUTBOX, 'utf8').trim().split('\n').reverse();
  for (const line of lines) {
    const m = JSON.parse(line) as { to: string; template: string; variables: { link?: string } };
    if (m.to === email && m.template === 'identity.email_verification') return m.variables.link!.split('#')[1]!;
  }
  throw new Error(`no verification mail for ${email}`);
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Signs a fresh user up and in through the BFF and the proxied hosted sign-in endpoints. */
async function signUpAndIn(browser: RecordingBrowser, email: string): Promise<Response> {
  const login = await browser.fetch('/bff/login?return_to=%2Fen%2Fgarage');
  expect(login.status).toBe(303);
  const authorizePath = new URL(login.headers.get('location')!).pathname + new URL(login.headers.get('location')!).search;
  const toSignin = await browser.fetch(authorizePath);
  expect(toSignin.status).toBe(302);
  const signin = new URL(toSignin.headers.get('location')!);
  expect(`${signin.origin}${signin.pathname}`).toBe(`${ORIGIN}/id/signin`);
  const interaction = signin.searchParams.get('interaction_id')!;
  expect(browser.cookies.get('__Host-cp_ia')).toBe(interaction);

  const post = (path: string, body: unknown) =>
    browser.fetch(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'idempotency-key': uuidv7() },
    });
  const signup = await post('/id/v1/auth/signup', {
    interaction_id: interaction,
    full_name: 'Sara Example',
    email,
    password: PASSWORD,
    locale: 'en',
    terms_version: '1.0',
    privacy_policy_version: '1.0',
  });
  expect(signup.status).toBe(202);
  expect(await json(signup)).toEqual({ next: 'verify_email' });
  expect((await post('/id/v1/auth/email/verify', { token: verificationToken(email) })).status).toBe(200);
  const first = await post('/id/v1/auth/signin', { interaction_id: interaction, email, password: PASSWORD });
  expect(await json(first)).toEqual({ next: 'complete' });

  // The hosted UI sends the browser back to the same authorize URL; the auth host answers with the code.
  const back = await browser.fetch(authorizePath);
  expect(back.status).toBe(302);
  const callback = new URL(back.headers.get('location')!);
  expect(`${callback.origin}${callback.pathname}`).toBe(`${ORIGIN}/bff/oauth/callback`);
  return browser.fetch(`${callback.pathname}${callback.search}`);
}

describe('BFF against the live backend', () => {
  it('a guest gets an anonymous token lazily and reads config.client through the forwarder', async () => {
    const browser = new RecordingBrowser(bff);
    const res = await browser.fetch('/api/v1/config/client', { headers: { 'accept-language': 'fa' } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toHaveProperty('flags');
    expect(res.headers.get('carpal-contract')).toBe('1.1.0');
    expect(browser.cookies.get('__Host-cp_sid')).toBeTruthy();
  });

  it('keeps a guest the same anonymous principal across token renewals (DI-17): its search session stays readable', async () => {
    const browser = new RecordingBrowser(bff);
    const csrf = await browser.csrf();
    const write = (path: string, body: unknown) =>
      browser.fetch(path, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      });
    const run = await write('/api/v1/search', {
      search_mode: 'providers',
      entry_point: 'search_box',
      query_text: 'brake pads',
      location: { mode: 'chosen_city', city_key: 'tehran' },
    });
    expect(run.status).toBe(200);
    const sessionId = (await json(run)).session_id as string;
    // Renew the anonymous token (16 min later): same DPoP key, so the same anonymous key on the backend.
    clock.offset += 16 * 60_000;
    try {
      const refine = await write(`/api/v1/search/${sessionId}/refine`, { sort: 'distance' });
      expect(refine.status).toBe(200);
    } finally {
      clock.offset -= 16 * 60_000;
    }
    const grants = upstream.filter((u) => u.url.endsWith('/oauth/token'));
    expect(grants.length).toBeGreaterThanOrEqual(2);
  });

  it('signs a user in with the code flow, calls me.get, refreshes after expiry, and logs out (P2 acceptance)', async () => {
    const browser = new RecordingBrowser(bff);
    await browser.fetch('/bff/csrf');
    const guestSid = browser.cookies.get('__Host-cp_sid');
    const email = `p2-${uuidv7()}@test.carpal.app`;

    const done = await signUpAndIn(browser, email);
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/en/garage');
    const sid = browser.cookies.get('__Host-cp_sid')!;
    expect(sid).not.toBe(guestSid);
    const view = await json(await browser.fetch('/bff/session'));
    expect(view).toMatchObject({ signed_in: true, locale: 'en', user: { display_name: 'Sara Example', acr: 'aal1' } });

    const me = await browser.fetch('/api/v1/me');
    expect(me.status).toBe(200);
    expect(await json(me)).toMatchObject({ email, status: 'active', locale: 'en' });

    // Refresh after the access token expired (clock moved past the 5-minute lifetime): rotation, then the call works.
    const before = (await store.get(sid))!.user!;
    clock.offset += 6 * 60_000;
    const again = await browser.fetch('/api/v1/me');
    expect(again.status).toBe(200);
    const after = (await store.get(sid))!.user!;
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(after.accessToken).not.toBe(before.accessToken);
    // The rotated-out refresh token is dead.
    const reuse = await fetch(`${AUTH}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'carpal-client': 'cp-web-consumer/0.1.0 (web 1.0)' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: 'cp-web-consumer',
        refresh_token: before.refreshToken,
      }).toString(),
    });
    expect(reuse.status).toBe(400);
    expect(await json(reuse)).toMatchObject({ error: 'invalid_grant' });
    // Reuse revoked the whole family (SEC-AU-5): the session has ended; sign in again for the rest.
    const ended = await browser.fetch('/api/v1/me');
    expect(ended.status).toBe(401);
    expect(await json(ended)).toMatchObject({ code: 'SESSION_ENDED' });

    clock.offset = 0;
    const second = new RecordingBrowser(bff);
    await signInExisting(second, email);
    const sid2 = second.cookies.get('__Host-cp_sid')!;
    const rt = (await store.get(sid2))!.user!.refreshToken;
    const csrf = await second.csrf();
    const logout = await second.fetch('/bff/logout', { method: 'POST', headers: { 'x-csrf-token': csrf } });
    expect(logout.status).toBe(200);
    expect(await store.get(sid2)).toBeNull();
    // logout revoked the refresh token at the auth server.
    const revoked = await fetch(`${AUTH}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'carpal-client': 'cp-web-consumer/0.1.0 (web 1.0)' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'cp-web-consumer', refresh_token: rt }).toString(),
    });
    expect(revoked.status).toBe(400);
    const guest = await second.fetch('/api/v1/me');
    expect(guest.status).toBe(401);
  });

  it('never let an access, refresh or ID token reach the browser', async () => {
    expect(browserSaw.length).toBeGreaterThan(10);
    const all = browserSaw.join('\n');
    expect(all).not.toMatch(/cprt_[A-Za-z0-9_-]{20,}/);
    expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
  });

  it('answers 404 for paths outside the consumer audience without calling the backend', async () => {
    const browser = new RecordingBrowser(bff);
    const count = upstream.length;
    for (const path of [
      '/api/v1/orgs/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/locations',
      '/api/v1/admin/flags',
      '/api/v1/orgs/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/fleet/members',
    ])
      expect((await browser.fetch(path)).status, path).toBe(404);
    expect(upstream.length).toBe(count);
  });

  it('records how the backend treats cp-ssr on search operations (DI-14)', async () => {
    const cred = await bff.ssr.ssr();
    const res = await fetch(`${API}/v1/search`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cred.accessToken}`,
        'carpal-client': 'cp-ssr/0.1.0 (web 1.0)',
        'content-type': 'application/json',
        'accept-language': 'en',
      },
      body: JSON.stringify({
        search_mode: 'providers',
        entry_point: 'directory_page',
        location: { mode: 'chosen_city', city_key: 'tehran' },
      }),
    });
    // Backend scopes are not enforced per operation today: cp-ssr can run search (DI-14 resolved for now).
    expect(res.status).toBe(200);
  });
});

// P7 (garage): the upload pipeline through the BFF and the storage listener's CORS (DI-08), a vehicle document,
// and an ownership transfer between two users (P7.T8, BA-04).
const WEB = 'http://localhost:3000'; // a dev origin the storage listener allows by default (backend DEV_MEDIA_CORS_ORIGINS)

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

async function signedInUser(name: string): Promise<{ browser: RecordingBrowser; send: Send }> {
  const browser = new RecordingBrowser(bff);
  const done = await signUpAndIn(browser, `p7-${name}-${uuidv7()}@test.carpal.app`);
  expect(done.status).toBe(303);
  const csrf = await browser.csrf();
  const send: Send = (method, path, body) =>
    browser.fetch(path, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      headers: {
        'content-type': 'application/json',
        ...(method === 'GET' ? {} : { 'x-csrf-token': csrf, 'idempotency-key': uuidv7() }),
      },
    });
  return { browser, send };
}

async function firstCar(send: Send): Promise<{ brand: string; model: string }> {
  const brands = (await json(await send('GET', '/api/v1/taxonomy/nodes?type=vehicle_brand&limit=5'))).items as { id: string }[];
  for (const b of brands) {
    const models = (await json(await send('GET', `/api/v1/taxonomy/nodes?type=vehicle_model&parent_id=${b.id}&limit=5`))).items as {
      id: string;
    }[];
    if (models[0]) return { brand: b.id, model: models[0].id };
  }
  throw new Error('no vehicle brand with a model in the taxonomy');
}

/** A VIN outside the check-digit WMIs (W…), fresh per run (one owner per VIN, BA-04). */
function freshVin(): string {
  const chars = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
  let v = 'WBA';
  for (let i = 0; i < 14; i++) v += chars[Math.floor(Math.random() * chars.length)];
  return v;
}

describe('P7 garage against the live backend', () => {
  it('uploads a PDF through the BFF and a signed PUT the storage listener allows for the web origin, waits for a clean scan and reads it back', async () => {
    const { send } = await signedInUser('upload');
    const me = await json(await send('GET', '/api/v1/me'));
    const bytes = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
    const sha = createHash('sha256').update(bytes).digest('base64');
    const init = await send('POST', '/api/v1/media/uploads', {
      purpose: 'vehicle_document',
      owner: { type: 'user', id: me.id },
      mime_type: 'application/pdf',
      file_size_bytes: bytes.length,
      checksum_sha256: sha,
    });
    expect(init.status).toBe(201);
    const ticket = (await json(init)) as { upload_id: string; url: string; headers: Record<string, string> };

    // The browser's preflight and PUT (DI-08): allowed for the web origin, nothing extra exposed, no credentials.
    const preflight = await fetch(ticket.url, {
      method: 'OPTIONS',
      headers: {
        origin: WEB,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type,x-amz-checksum-sha256',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    const put = await fetch(ticket.url, {
      method: 'PUT',
      headers: {
        origin: WEB,
        'content-type': ticket.headers['Content-Type']!,
        'x-amz-checksum-sha256': ticket.headers['x-amz-checksum-sha256']!,
      },
      body: bytes,
    });
    expect(put.status).toBe(200);
    expect(put.headers.get('access-control-allow-origin')).toBe(WEB);

    const complete = await send('POST', `/api/v1/media/uploads/${ticket.upload_id}/complete`);
    expect(complete.status).toBe(202);
    const asset = (await json(complete)) as { id: string; scan_status: string };
    let scan = asset.scan_status;
    for (let i = 0; i < 60 && scan !== 'clean'; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const got = await send('GET', `/api/v1/media/${asset.id}`);
      if (got.status === 200) scan = ((await json(got)) as { scan_status: string }).scan_status;
    }
    expect(scan).toBe('clean');

    // A document on a car, then the in-place preview path: a signed URL read cross-origin into a blob.
    const car = await firstCar(send);
    const created = await send('POST', '/api/v1/me/vehicles', { brand_node_id: car.brand, model_node_id: car.model, year: 2015 });
    expect(created.status).toBe(201);
    const vehicleId = (await json(created)).id as string;
    const doc = await send('POST', `/api/v1/me/vehicles/${vehicleId}/documents`, {
      document_type: 'insurance',
      title: 'Third-party insurance',
      media_asset_id: asset.id,
      visibility: 'private',
      expires_at: '2027-03-20',
    });
    expect(doc.status).toBe(201);
    const docs = (await json(await send('GET', `/api/v1/me/vehicles/${vehicleId}/documents`))).items as { media_asset_id: string }[];
    expect(docs.map((d) => d.media_asset_id)).toContain(asset.id);
    const signed = await send('POST', `/api/v1/media/${asset.id}/download-url`, { variant: 'original' });
    expect(signed.status).toBe(200);
    const file = await fetch(((await json(signed)) as { url: string }).url, { headers: { origin: WEB } });
    expect(file.status).toBe(200);
    expect(file.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(file.headers.get('content-disposition')).toBe('attachment');
    expect((await file.text()).startsWith('%PDF-')).toBe(true);
  }, 90_000);

  it('moves a car to its buyer: request with a message, the owner sees it and accepts, the buyer owns it (P7.T8)', async () => {
    const owner = await signedInUser('owner');
    const buyer = await signedInUser('buyer');
    const car = await firstCar(owner.send);
    const vin = freshVin();
    const created = await owner.send('POST', '/api/v1/me/vehicles', {
      brand_node_id: car.brand,
      model_node_id: car.model,
      year: 2012,
      vin,
      nickname: 'Silver',
    });
    expect(created.status).toBe(201);

    // The buyer adds the same VIN: 409 DUPLICATE with vin_transfer_available, then asks for the car.
    const dup = await buyer.send('POST', '/api/v1/me/vehicles', { brand_node_id: car.brand, model_node_id: car.model, year: 2012, vin });
    expect(dup.status).toBe(409);
    expect(await json(dup)).toMatchObject({ code: 'DUPLICATE', vin_transfer_available: true });
    const asked = await buyer.send('POST', '/api/v1/me/vehicle-transfers', { vin, message: 'Bought it last week.' });
    expect(asked.status).toBe(201);
    const outgoing = (await json(asked)) as { id: string; status: string; requester_display: string | null };
    expect(outgoing).toMatchObject({ status: 'pending', requester_display: null });

    const incoming = (await json(await owner.send('GET', '/api/v1/me/vehicle-transfers?direction=incoming&status=pending'))).items as {
      id: string;
      message: string;
      requester_display: string;
    }[];
    expect(incoming.find((t) => t.id === outgoing.id)).toMatchObject({
      message: 'Bought it last week.',
      requester_display: 'Sara', // the backend shows the buyer's first name only
    });
    const decided = await owner.send('POST', `/api/v1/me/vehicle-transfers/${outgoing.id}/decision`, { decision: 'accept' });
    expect(decided.status).toBe(200);
    expect(await json(decided)).toMatchObject({ status: 'accepted' });

    const theirs = (await json(await buyer.send('GET', '/api/v1/me/vehicles'))).items as { vin_last4: string | null; nickname?: string }[];
    expect(theirs.some((v) => v.vin_last4 === vin.slice(-4) && v.nickname === undefined)).toBe(true);
    const left = (await json(await owner.send('GET', '/api/v1/me/vehicles'))).items as { vin_last4: string | null }[];
    expect(left.some((v) => v.vin_last4 === vin.slice(-4))).toBe(false);
  }, 90_000);
});

async function signInExisting(browser: RecordingBrowser, email: string): Promise<void> {
  const login = await browser.fetch('/bff/login?return_to=%2Fen');
  const loc = new URL(login.headers.get('location')!);
  const authorizePath = `${loc.pathname}${loc.search}`;
  const interaction = new URL((await browser.fetch(authorizePath)).headers.get('location')!).searchParams.get('interaction_id')!;
  const res = await browser.fetch('/id/v1/auth/signin', {
    method: 'POST',
    body: JSON.stringify({ interaction_id: interaction, email, password: PASSWORD }),
    headers: { 'content-type': 'application/json' },
  });
  expect(await res.json()).toEqual({ next: 'complete' });
  const back = new URL((await browser.fetch(authorizePath)).headers.get('location')!);
  const done = await browser.fetch(`${back.pathname}${back.search}`);
  expect(done.headers.get('location')).toBe('/en');
}

// P8 (community): Q&A between two users through the BFF — a question, a clean and a held answer (contact data,
// BA-17), helpful reactions (idempotent), the server refusing writes on someone else's content (DI-50), accept, the
// accepted answer that cannot be deleted, comments, a duplicate report, and the Discover feed. Needs the community
// flags on: `pnpm dev:flags set community on` in backend/ (DI-18, P8.T0).
describe('P8 community against the live backend', () => {
  it('asks, answers, reacts, accepts, comments and reports through the BFF', async () => {
    const asker = await signedInUser('asker');
    const helper = await signedInUser('helper');
    const flags = (await json(await asker.send('GET', '/api/v1/config/client'))).flags as { key: string; enabled: boolean }[];
    const on = (k: string) => flags.find((f) => f.key === k)?.enabled === true;
    expect(on('qna.enabled') && on('community.comments.enabled'), 'run `pnpm dev:flags set community on` in backend/').toBe(true);

    const systems = (await json(await asker.send('GET', '/api/v1/taxonomy/nodes?type=service_system&limit=5'))).items as { id: string }[];
    const created = await asker.send('POST', '/api/v1/questions', {
      category_node_id: systems[0]!.id,
      title: `Which winter tyres fit an E90 ${uuidv7().slice(-6)}?`,
      body: 'Mostly city driving in Tehran, some trips north in winter.',
      content_locale: 'en',
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('etag')).toBe('"v1"');
    const q = (await json(created)) as { id: string; status: string; author: { display_name: string } };
    expect(q).toMatchObject({ status: 'open', answer_count: 0 });

    const answered = await helper.send('POST', `/api/v1/questions/${q.id}/answers`, {
      body: '225/45 R17 front and 255/40 R17 rear with run-flat.',
      content_locale: 'en',
    });
    expect(answered.status).toBe(201);
    const good = (await json(answered)) as { id: string };
    const heldRes = await helper.send('POST', `/api/v1/questions/${q.id}/answers`, {
      body: 'Call me on 0912 345 6789 for a price.',
      content_locale: 'en',
    });
    expect(heldRes.status).toBe(201);
    const held = (await json(heldRes)) as { id: string };

    // The held answer is visible to its author only.
    const askerView = (await json(await asker.send('GET', `/api/v1/questions/${q.id}`))) as { answers: { items: { id: string }[] } };
    expect(askerView.answers.items.map((a) => a.id)).toEqual([good.id]);
    const helperView = (await json(await helper.send('GET', `/api/v1/questions/${q.id}`))) as { answers: { items: { id: string }[] } };
    expect(helperView.answers.items.map((a) => a.id).sort()).toEqual([good.id, held.id].sort());

    // Helpful: one per user (put twice = once), removable.
    const target = { target: { type: 'answer', id: good.id }, reaction_type: 'helpful' };
    expect(await json(await asker.send('PUT', '/api/v1/reactions', target))).toEqual({ count: 1 });
    expect(await json(await asker.send('PUT', '/api/v1/reactions', target))).toEqual({ count: 1 });
    expect(await json(await asker.send('POST', '/api/v1/reactions/remove', target))).toEqual({ count: 0 });
    expect(await json(await asker.send('PUT', '/api/v1/reactions', target))).toEqual({ count: 1 });

    // The server decides authorship: someone else's answer cannot be deleted, only the asker accepts.
    expect((await asker.send('DELETE', `/api/v1/answers/${good.id}`)).status).toBe(404);
    expect((await helper.send('POST', `/api/v1/questions/${q.id}/accept`, { answer_id: good.id })).status).toBe(404);
    const accepted = await asker.send('POST', `/api/v1/questions/${q.id}/accept`, { answer_id: good.id });
    expect(accepted.status).toBe(200);
    expect(await json(accepted)).toMatchObject({ status: 'answered', accepted_answer_id: good.id });
    const del = await helper.send('DELETE', `/api/v1/answers/${good.id}`);
    expect(del.status).toBe(409);
    expect(await json(del)).toMatchObject({ code: 'INVALID_TRANSITION' });

    // Comments on the question; a second report of the same comment is a duplicate.
    const comment = await helper.send('POST', '/api/v1/comments', {
      target: { type: 'question', id: q.id },
      body: 'Same question for my E91.',
      content_locale: 'en',
    });
    expect(comment.status).toBe(201);
    const c = (await json(comment)) as { id: string; status: string };
    const listed = (await json(await asker.send('GET', `/api/v1/comments?target_type=question&target_id=${q.id}`))).items as {
      id: string;
    }[];
    expect(listed.map((x) => x.id)).toContain(c.id);
    const report = { target_type: 'comment', target_id: c.id, reason: 'spam' };
    expect((await asker.send('POST', '/api/v1/reports', report)).status).toBe(201);
    const again = await asker.send('POST', '/api/v1/reports', report);
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ code: 'DUPLICATE' });

    // Discover (feed.discover): the pilot city, no vehicle.
    const feed = await asker.send('POST', '/api/v1/feed/discover', { location: { mode: 'chosen_city', city_key: 'tehran' }, limit: 20 });
    expect(feed.status).toBe(200);
    expect(Array.isArray((await json(feed)).items)).toBe(true);
  }, 120_000);
});

// P9 (account): profile with ETag and the session's display name, the welcome notification and read marks, the
// notification matrix (full replace; marketing needs the consent), consents granted and withdrawn with the dependent
// preference, a data export request (one open per type), sessions, an authenticator app enrolled with a real TOTP
// code (10 recovery codes), and AAL2 operations asking for a step-up once the account has a second factor (BA-11).
describe('P9 account against the live backend', () => {
  it('profile, notifications, preferences, consents, data requests, TOTP and step-up through the BFF', async () => {
    const user = await signedInUser('p9');
    const write = async (method: string, path: string, body: unknown, ifMatch: string) =>
      user.browser.fetch(path, {
        method,
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', 'x-csrf-token': await user.browser.csrf(), 'if-match': ifMatch },
      });

    // Profile: me.update with the ETag of me.get; the BFF session view follows the new display name.
    const me = await user.send('GET', '/api/v1/me');
    const patch = await write('PATCH', '/api/v1/me', { display_name: 'Sara M.' }, me.headers.get('etag')!);
    expect(patch.status, await patch.clone().text()).toBe(200);
    expect(((await json(await user.browser.fetch('/bff/session'))).user as { display_name: string }).display_name).toBe('Sara M.');

    // Notifications: the welcome arrives in-app (the outbox dispatcher runs in the background).
    let items: { id: string; template_key: string }[] = [];
    for (let i = 0; i < 40 && items.length === 0; i++) {
      items = (await json(await user.send('GET', '/api/v1/me/notifications?limit=10'))).items as typeof items;
      if (!items.length) await new Promise((r) => setTimeout(r, 250));
    }
    expect(items.map((n) => n.template_key)).toContain('system.welcome');
    for (const n of items) expect(CONSUMER_TEMPLATE_KEYS as readonly string[]).toContain(n.template_key);
    expect(((await json(await user.send('GET', '/api/v1/me/notifications/unread-count'))).count as number) >= 1).toBe(true);
    expect((await user.send('POST', '/api/v1/me/notifications/read', { up_to: new Date().toISOString() })).status).toBe(200);
    expect((await json(await user.send('GET', '/api/v1/me/notifications/unread-count'))).count).toBe(0);

    // Notification matrix: every channel × category; marketing on without the consent is refused.
    const prefs = (await json(await user.send('GET', '/api/v1/me/notification-preferences'))).items as {
      channel: string;
      category: string;
      enabled: boolean;
    }[];
    expect(prefs).toHaveLength(44);
    const off = prefs.map((p) => (p.channel === 'push' && p.category === 'community' ? { ...p, enabled: false } : p));
    expect((await user.send('PUT', '/api/v1/me/notification-preferences', { items: off })).status).toBe(200);
    const marketing = prefs.map((p) => (p.channel === 'email' && p.category === 'marketing' ? { ...p, enabled: true } : p));
    const refused = await user.send('PUT', '/api/v1/me/notification-preferences', { items: marketing });
    expect(refused.status).toBe(403);
    expect(await json(refused)).toMatchObject({ code: 'CONSENT_REQUIRED' });

    // Consents: grant marketing (+ the preference), withdraw it — the preference goes off with it.
    const granted = await user.send('POST', '/api/v1/me/consents', {
      consent_type: 'marketing',
      policy_version: '2026-10',
      granted_to: { type: 'platform' },
    });
    expect(granted.status).toBe(201);
    const consent = (await json(granted)) as { id: string };
    const pref = await user.send('GET', '/api/v1/me/preferences');
    expect((await write('PATCH', '/api/v1/me/preferences', { marketing_opt_in: true }, pref.headers.get('etag')!)).status).toBe(200);
    expect((await user.send('POST', `/api/v1/me/consents/${consent.id}/withdraw`)).status).toBe(200);
    expect((await json(await user.send('GET', '/api/v1/me/preferences'))).marketing_opt_in).toBe(false);
    const active = (await json(await user.send('GET', '/api/v1/me/consents?active=true'))).items as { consent_type: string }[];
    expect(active.some((c) => c.consent_type === 'marketing')).toBe(false);

    // Data export: AAL2 is met by the fresh sign-in of an account without a second factor (BA-11); one open per type.
    const dsr = await user.send('POST', '/api/v1/me/data-requests', { request_type: 'export' });
    expect(dsr.status, await dsr.clone().text()).toBe(201);
    expect(await json(dsr)).toMatchObject({ request_type: 'export', status: 'received', export_available: false });
    expect((await user.send('POST', '/api/v1/me/data-requests', { request_type: 'export' })).status).toBe(409);
    expect(((await json(await user.send('GET', '/api/v1/me/data-requests'))).items as unknown[]).length).toBe(1);

    // Sessions: this sign-in is listed as current; no organization memberships.
    const sessions = (await json(await user.send('GET', '/api/v1/me/sessions'))).items as { current: boolean; client_id: string }[];
    expect(sessions.some((s) => s.current && s.client_id === 'cp-web-consumer')).toBe(true);
    const memberships = (await json(await user.send('GET', '/api/v1/me/memberships'))).items as { organization: unknown }[];
    expect(memberships.every((m) => m.organization === null)).toBe(true);

    // Authenticator app: enrol, confirm with a real code, 10 recovery codes once.
    const enrol = await user.send('POST', '/api/v1/me/mfa-methods/totp', { label: 'Phone' });
    expect(enrol.status, await enrol.clone().text()).toBe(201);
    const { method, otpauth_uri } = (await json(enrol)) as { method: { id: string; status: string }; otpauth_uri: string };
    expect(method.status).toBe('pending');
    const confirm = await user.send('POST', `/api/v1/me/mfa-methods/${method.id}/confirm`, { code: totp(secretOf(otpauth_uri)) });
    expect(confirm.status, await confirm.clone().text()).toBe(200);
    expect(((await json(confirm)).recovery_codes as string[]).length).toBe(10);
    expect((await json(await user.send('GET', '/api/v1/me'))).mfa_enabled).toBe(true);

    // The session that enrolled keeps AAL2 for its fresh-sign-in window (the backend decides "no second factor" per
    // session at sign-in, DI-56). A new sign-in now needs the code: the hosted sign-in step answers next = mfa, and a
    // code of the next 30-second window (the confirming one is spent) completes it at aal2.
    const email = (await json(await user.send('GET', '/api/v1/me'))).email as string;
    const second = new RecordingBrowser(bff);
    const login = await second.fetch('/bff/login?return_to=%2Fen');
    const loc = new URL(login.headers.get('location')!);
    const authorizePath = `${loc.pathname}${loc.search}`;
    const interaction = new URL((await second.fetch(authorizePath)).headers.get('location')!).searchParams.get('interaction_id')!;
    const post = (path: string, body: unknown) =>
      second.fetch(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const first = await json(await post('/id/v1/auth/signin', { interaction_id: interaction, email, password: PASSWORD }));
    expect(first).toMatchObject({ next: 'mfa' });
    expect(first.mfa_methods).toContain('totp_mfa');
    await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 500));
    const verified = await post('/id/v1/auth/mfa/verify', {
      interaction_id: interaction,
      method: 'totp_mfa',
      code: totp(secretOf(otpauth_uri)),
    });
    expect(await json(verified)).toEqual({ next: 'complete' });
    const back = new URL((await second.fetch(authorizePath)).headers.get('location')!);
    expect((await second.fetch(`${back.pathname}${back.search}`)).headers.get('location')).toBe('/en');
    expect(((await json(await second.fetch('/bff/session'))).user as { acr: string }).acr).toBe('aal2');
  }, 120_000);
});
