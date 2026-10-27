// S10 (contract 1.1.0, PWA integration): search facets, the soonest sort with
// next_available_slot, search.session_get and search.page limit, and the
// map.pins changes (open_now, only_matching, counts, profile fields).
// Acceptance: results are the same with and without facets, and each count
// equals the result count of a run with that option; a session is read again
// without a new session or analytics event; closed places leave the map's
// pins, clusters and counts with only_matching.
import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SearchSlotRefreshRule } from '#modules/discovery/discovery-worker.module.js';
import { taxonomyNodes, type Json, type Nodes } from './s4-support.js';
import { newId, outbox } from './s5-support.js';
import { flush, near, publishedProvider, uniquePoint, type PublishedOrg } from './s6-support.js';
import { localDay, rule } from './s7-support.js';
import { createTestApp, createTestWorker, type TestApp } from './test-app.js';

let app: TestApp;
let worker: INestApplicationContext;
let n: Nodes;

beforeAll(async () => {
  app = await createTestApp({ host: 'api' });
  worker = await createTestWorker({ infra: app.infra });
  n = await taxonomyNodes(app);
});
afterAll(async () => {
  await worker.close();
  await app.close();
});

const area = (p: { lat: number; lng: number }, span = 0.02, zoom = 13) => ({
  mode: 'map_center',
  viewport: { center: p, zoom, bbox: { south: p.lat - span, west: p.lng - span, north: p.lat + span, east: p.lng + span } },
});
const ALWAYS_OPEN = { weekly: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, open: '00:00', close: '23:59' })) };
const ALWAYS_CLOSED = { weekly: [] };
const WARRANTY = { warranty_offered: true, warranty_policy_translations: { en: '6 months on parts and labour', fa: 'شش ماه ضمانت' } };

async function search(token: string, body: Json) {
  const res = await app.request<Json>({
    method: 'POST',
    path: '/v1/search',
    token,
    body: { search_mode: 'providers', entry_point: 'search_box', limit: 50, ...body },
  });
  if (res.status !== 200) throw new Error(`search.run ${res.status} ${res.text}`);
  return res.body;
}
const ids = (body: Json) => (body.results as Json[]).map((r) => r.organization.id as string);

describe('search facets (pwa DI-42)', () => {
  let point: { lat: number; lng: number };
  let orgs: Record<'a' | 'b' | 'c' | 'd', PublishedOrg>;
  let token: string;

  beforeAll(async () => {
    point = uniquePoint();
    const tag = newId().slice(-6);
    const make = (k: string, dLat: number, profile: Json, hours: Json) =>
      publishedProvider(app, n, { name: `S10 Facet ${k} ${tag}`, point: near(point, dLat, 0), profile, location: { hours } });
    orgs = {
      a: await make('A', 0.001, { service_modes: ['in_shop'], price_tier: 'budget', ...WARRANTY, languages_spoken: ['fa'] }, ALWAYS_OPEN),
      b: await make('B', 0.002, { service_modes: ['mobile'], price_tier: 'mid_range', languages_spoken: ['fa', 'en'] }, ALWAYS_CLOSED),
      c: await make(
        'C',
        0.003,
        { service_modes: ['in_shop', 'mobile'], price_tier: 'premium', ...WARRANTY, languages_spoken: ['en'] },
        ALWAYS_CLOSED,
      ),
      d: await make('D', 0.004, { service_modes: ['pickup_dropoff'], price_tier: 'mid_range', languages_spoken: ['ar'] }, ALWAYS_OPEN),
    };
    await flush(app, worker);
    token = await app.fixtures.anonymousToken();
  });

  const mine = (body: Json) => ids(body).filter((id) => Object.values(orgs).some((o) => o.id === id));

  it('gives the same results with and without facets, and counts each option as a run with it would', async () => {
    const filters = { warranty_offered: true };
    const plain = await search(token, { location: area(point), filters });
    const withFacets = await search(token, { location: area(point), filters, facets: true });
    expect(plain.facets).toBeNull();
    expect(new Set(mine(plain))).toEqual(new Set([orgs.a.id, orgs.c.id]));
    // Same ranking: ids, ranks and scores identical.
    const key = (b: Json) => (b.results as Json[]).map((r) => [r.organization.id, r.rank, r.match_score]);
    expect(key(withFacets)).toEqual(key(plain));

    const f = withFacets.facets as Json;
    expect(f.result_count).toBe(plain.results.length);
    expect(f.capped).toBe(false);
    expect((f.facets as Json[]).map((x) => x.key)).toEqual([
      'min_rating',
      'verified_only',
      'open_now',
      'available_within_days',
      'service_modes',
      'price_tiers',
      'provider_types',
      'badges',
      'languages',
      'warranty_offered',
      'ev_capable',
      'fleet_friendly',
    ]);
    expect(f.without_filter).toEqual([{ key: 'warranty_offered', count_without: plain.results.length + 2 }]);
    const facet = (k: string) => (f.facets as Json[]).find((x) => x.key === k)!.counts as Json[];
    expect(facet('warranty_offered')).toEqual([{ value: 'true', count: plain.results.length, selected: true }]);

    // Every option of these facets equals a run with that option (the facet's own selection replaced).
    const checks: [string, (v: string) => Json][] = [
      ['service_modes', (v) => ({ ...filters, service_modes: [v] })],
      ['price_tiers', (v) => ({ ...filters, price_tiers: [v] })],
      ['languages', (v) => ({ ...filters, languages: [v] })],
      ['open_now', () => ({ ...filters, open_now: true })],
      ['min_rating', (v) => ({ ...filters, min_rating: v })],
    ];
    for (const [k, apply] of checks)
      for (const c of facet(k)) {
        const run = await search(token, { location: area(point), filters: apply(c.value as string) });
        expect([k, c.value, c.count]).toEqual([k, c.value, run.results.length]);
      }
    const modes = Object.fromEntries(facet('service_modes').map((c) => [c.value, c.count]));
    expect(modes).toMatchObject({ in_shop: 2, mobile: 1, pickup_dropoff: 0 });
    expect(facet('languages').map((c) => c.value)).toEqual(expect.arrayContaining(['fa', 'en']));
  });

  it('names the filter that removed most results when the list is empty', async () => {
    const body = await search(token, {
      location: area(point),
      filters: { warranty_offered: true, open_now: true, price_tiers: ['mid_range'] },
      facets: true,
    });
    expect(mine(body)).toEqual([]);
    const impact = Object.fromEntries((body.facets.without_filter as Json[]).map((x) => [x.key, x.count_without]));
    // Without the price tier: A (budget, warranty, open). Without open now / warranty: nothing (B, D are mid_range but only D is open, without warranty).
    expect(impact).toMatchObject({ price_tiers: 1, open_now: 0, warranty_offered: 1 });
  });

  it('refine keeps the facets flag of the session and lets the client turn it off', async () => {
    const first = await search(token, { location: area(point), facets: true });
    const refined = await app.request<Json>({
      method: 'POST',
      path: `/v1/search/${first.session_id}/refine`,
      token,
      body: { filters: { open_now: true } },
    });
    expect(refined.status).toBe(200);
    expect(refined.body.facets).not.toBeNull();
    expect(new Set(ids(refined.body).filter((id) => [orgs.a.id, orgs.d.id, orgs.b.id, orgs.c.id].includes(id)))).toEqual(
      new Set([orgs.a.id, orgs.d.id]),
    );
    const off = await app.request<Json>({
      method: 'POST',
      path: `/v1/search/${refined.body.session_id}/refine`,
      token,
      body: { facets: false },
    });
    expect(off.body.facets).toBeNull();
  });
});

describe('search.session_get and search.page limit (pwa DI-46, backend DI-46)', () => {
  it('reads the first page again without a new session or event; 404 for another caller and after 24 hours', async () => {
    const point = uniquePoint();
    const tag = newId().slice(-6);
    for (let i = 0; i < 3; i++)
      await publishedProvider(app, n, { name: `S10 Session ${i} ${tag}`, point: near(point, 0.001 * (i + 1), 0) });
    await flush(app, worker);
    const token = await app.fixtures.anonymousToken();
    const run = await search(token, { location: area(point), limit: 2, facets: true, filters: { verified_only: false } });
    expect(run.results.length).toBe(2);
    expect(run.next_cursor).toEqual(expect.any(String));
    const events = (await outbox(app, run.session_id)).length;

    const again = await app.request<Json>({ path: `/v1/search/${run.session_id}?limit=2`, token });
    expect(again.status).toBe(200);
    const { next_cursor: cursor, ...rest } = again.body;
    const { next_cursor: _runCursor, ...runRest } = run;
    expect(rest).toEqual(runRest);
    expect(cursor).toEqual(expect.any(String));
    expect((await outbox(app, run.session_id)).length).toBe(events);
    const sessions = await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db.selectFrom('discovery.match_sessions').select('id').where('id', '=', run.session_id).execute(),
    );
    expect(sessions).toHaveLength(1);

    // The fresh cursor pages on with the chosen page size.
    const page = await app.request<Json>({
      path: `/v1/search/${run.session_id}/results?cursor=${encodeURIComponent(cursor)}&limit=1`,
      token,
    });
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0].rank).toBe(3);

    const other = await app.fixtures.anonymousToken();
    expect((await app.request<Json>({ path: `/v1/search/${run.session_id}`, token: other })).status).toBe(404);

    // created_at is immutable (core.tg_touch): copies of the session for the same caller, created 23 and 25 hours ago.
    const copyAt = async (hoursAgo: number) => {
      const id = newId();
      await app.fixtures.worker.run({ actorType: 'system' }, async ({ db }) => {
        const row = await db.selectFrom('discovery.match_sessions').selectAll().where('id', '=', run.session_id).executeTakeFirstOrThrow();
        const { id: _id, created_at: _c, updated_at: _u, version: _v, query_normalized: _q, ...copy } = row as Json;
        await db
          .insertInto('discovery.match_sessions')
          .values({ ...copy, id, created_at: new Date(Date.now() - hoursAgo * 3_600_000) } as never)
          .execute();
      });
      return id;
    };
    expect((await app.request<Json>({ path: `/v1/search/${await copyAt(23)}`, token })).status).toBe(200);
    const old = await app.request<Json>({ path: `/v1/search/${await copyAt(25)}`, token });
    expect(old.status).toBe(404);
    expect(old.body.code).toBe('NOT_FOUND');
  });
});

describe('soonest sort and next_available_slot (pwa DI-43, DI-73)', () => {
  it('orders providers by their first open slot, fills the card slot and never shows a passed one', async () => {
    const point = uniquePoint();
    const tag = newId().slice(-6);
    const early = await publishedProvider(app, n, { name: `S10 Early ${tag}`, point: near(point, 0.001, 0) });
    const late = await publishedProvider(app, n, { name: `S10 Late ${tag}`, point: near(point, 0.002, 0) });
    const none = await publishedProvider(app, n, { name: `S10 None ${tag}`, point: near(point, 0.003, 0) });
    await rule(early, localDay(1).dayOfWeek);
    await rule(late, localDay(3).dayOfWeek);
    await flush(app, worker);
    const token = await app.fixtures.anonymousToken();
    const body = await search(token, { location: area(point), sort: 'soonest' });
    const mine = (body.results as Json[]).filter((r) => [early.id, late.id, none.id].includes(r.organization.id));
    expect(mine.map((r) => r.organization.id)).toEqual([early.id, late.id, none.id]);
    const [e, l, x] = mine.map((r) => r.next_available_slot as string | null);
    expect(Date.parse(e!)).toBeGreaterThan(Date.now());
    expect(Date.parse(e!)).toBeLessThan(Date.parse(l!));
    expect(x).toBeNull();
    expect(Date.parse(e!)).toBe(localDay(1).at('09:00').getTime());

    // available_within_days: 1 = today or tomorrow (the early provider only); 0 = today (neither).
    const tomorrow = await search(token, { location: area(point), filters: { available_within_days: 1 } });
    expect(ids(tomorrow).filter((id) => [early.id, late.id, none.id].includes(id))).toEqual([early.id]);
    const today = await search(token, { location: area(point), filters: { available_within_days: 0 } });
    expect(ids(today).filter((id) => [early.id, late.id, none.id].includes(id))).toEqual([]);

    // A projected slot that has passed: the card re-reads the calendar, and the W15 rule projects it again.
    const doc = (await app.infra.search.get('providers', early.id))!;
    await app.infra.search.upsert('providers', early.id, { ...doc, next_available_at: new Date(Date.now() - 3_600_000).toISOString() });
    const stale = await search(token, { location: area(point), sort: 'soonest' });
    const card = (stale.results as Json[]).find((r) => r.organization.id === early.id)!;
    expect(card.next_available_slot).toBe(e);
    expect(await worker.get(SearchSlotRefreshRule).run()).toBeGreaterThanOrEqual(1);
    expect((await app.infra.search.get('providers', early.id))!.next_available_at).toBe(e);
  });
});

describe('map.pins (pwa DI-44, DI-45)', () => {
  it('judges open now per location, leaves closed places out with only_matching and counts the viewport', async () => {
    const point = uniquePoint();
    const tag = newId().slice(-6);
    const open = await publishedProvider(app, n, {
      name: `S10 Open ${tag}`,
      point: near(point, 0.0005, 0),
      location: { hours: ALWAYS_OPEN },
    });
    const closed = await publishedProvider(app, n, {
      name: `S10 Closed ${tag}`,
      point: near(point, 0.0005, 0.0005),
      location: { hours: ALWAYS_CLOSED },
    });
    await flush(app, worker);
    const token = await app.fixtures.anonymousToken();
    const pins = async (body: Json) => {
      const res = await app.request<Json>({ method: 'POST', path: '/v1/map/pins', token, body: { layers: ['providers'], ...body } });
      if (res.status !== 200) throw new Error(`map.pins ${res.status} ${res.text}`);
      return res.body;
    };
    const viewport = area(point, 0.002, 10).viewport;
    const total = (b: Json) => (b.pins as Json[]).length + (b.clusters as Json[]).reduce((s, c) => s + (c.count as number), 0);

    const highlight = await pins({ viewport, filters: { open_now: true } });
    expect(highlight.counts).toEqual({ matching: 1, others: 1 });
    expect(total(highlight)).toBe(2);
    const only = await pins({ viewport, filters: { open_now: true }, only_matching: true });
    expect(only.counts).toEqual({ matching: 1, others: 0 });
    expect(total(only)).toBe(1);

    const close = await pins({ viewport: area(point, 0.002, 15).viewport, filters: { open_now: true } });
    const byOrg = Object.fromEntries((close.pins as Json[]).map((p) => [p.organization_id, p]));
    expect(byOrg[open.id]).toMatchObject({
      matches_filters: true,
      open_now: true,
      organization_type: 'provider',
      verified: false,
      review_count: 0,
    });
    expect(byOrg[open.id].slug).toEqual(expect.any(String));
    expect(byOrg[closed.id]).toMatchObject({ matches_filters: false, open_now: false, result_id: null });

    // With a search session, pins carry the session's result id (search.result_event).
    const s = await search(token, { location: area(point, 0.002) });
    const result = (s.results as Json[]).find((r) => r.organization.id === open.id)!;
    const ranked = await pins({ viewport: area(point, 0.002, 15).viewport, search_session_id: s.session_id });
    expect((ranked.pins as Json[]).find((p) => p.organization_id === open.id)).toMatchObject({
      result_id: result.result_id,
      rank: result.rank,
    });
  });
});
