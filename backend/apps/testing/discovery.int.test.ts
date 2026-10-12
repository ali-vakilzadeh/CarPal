// S6 discovery (40 §14, feed.discover): the search projections kept by W2,
// search.run / page / refine / result_event, map.pins, safety.check, the
// public profile reads and feed.discover. Acceptance: a published provider
// appears within one relay cycle and disappears on unpublish; a Persian query
// and its Arabic-character variant return the same results; safety.check
// flags a safety-critical symptom in EN and FA; every result has a reason.
import type { INestApplicationContext } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SafetyLexicon } from '#libs/safety-check/index.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { taxonomyNodes, type Json, type Nodes } from './s4-support.js';
import { client, grantConsent, newId, outbox } from './s5-support.js';
import { flush, near, publishedProvider, publishedVendor, uniquePoint } from './s6-support.js';
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

/** A map-area search (no consent needed) around a point. */
const area = (p: { lat: number; lng: number }, span = 0.05) => ({
  mode: 'map_center',
  viewport: { center: p, zoom: 13, bbox: { south: p.lat - span, west: p.lng - span, north: p.lat + span, east: p.lng + span } },
});

async function search(token: string, body: Json) {
  return app.request<Json>({ method: 'POST', path: '/v1/search', token, body: { search_mode: 'all', entry_point: 'search_box', ...body } });
}

const ids = (res: { body: Json }) => (res.body.results as Json[]).map((r) => r.organization.id as string);

describe('search projections and search.run (S6 acceptance)', () => {
  it('a published provider appears within one relay cycle and disappears on unpublish; every result has reasons', async () => {
    const anon = await app.fixtures.anonymousToken();
    const p = await publishedProvider(app, n, { name: `Dune Garage ${newId().slice(-6)}` });
    expect(ids(await search(anon, { location: area(p.point) }))).not.toContain(p.id);

    await flush(app, worker);
    const found = await search(anon, { location: area(p.point) });
    expect(found.status).toBe(200);
    expect(ids(found)).toContain(p.id);
    const card = (found.body.results as Json[]).find((r) => r.organization.id === p.id)!;
    expect(card).toMatchObject({
      target: { type: 'organization', id: p.id },
      organization: { roles: ['provider'], overall_rating: null, review_count: 0 },
      location: { location_id: p.locationId, visibility: 'exact' },
      is_sponsored: false,
      explanation: { source: 'template' },
    });
    for (const r of found.body.results as Json[]) {
      expect(r.reasons.length).toBeGreaterThan(0);
      expect(r.reasons[0].summary.text.length).toBeGreaterThan(0);
    }
    expect(found.body.interpreted_intent.chips[0]).toMatchObject({ kind: 'target_type', text: 'place', removable: false });
    expect(found.body.safety).toEqual({ flag: false, level: 'none', message_i18n_key: null, urgent_help_available: false });
    expect((await outbox(app, found.body.session_id)).map((e) => e.type)).toContain('search.started');

    const off = await p.c.post(`/v1/orgs/${p.id}/provider/unpublish`, { reason: 'Closed for renovation' });
    expect(off.status).toBe(200);
    await flush(app, worker);
    expect(ids(await search(anon, { location: area(p.point) }))).not.toContain(p.id);
  });

  it('a Persian query and its Arabic-character variant return the same results', async () => {
    // A service node whose Persian name has a Persian yeh or keheh, which Arabic keyboards type as ي / ك.
    const node = await app.fixtures.worker.run({ actorType: 'system' }, async ({ db }) => {
      const { rows } = await sql<{ id: string; fa: string }>`
        SELECT id, name_translations->>'fa' AS fa FROM taxonomy.taxonomy_nodes
         WHERE type IN ('service_system','service_task') AND status = 'active' AND deleted_at IS NULL
           AND name_translations->>'fa' ~ '[یک]' ORDER BY sort_order, id LIMIT 1`.execute(db);
      return rows[0]!;
    });
    const chain = await app.app.get(TaxonomyResolver, { strict: false }).ancestors(node.id);
    const system = chain.length > 1 ? chain[1]! : node.id;
    const point = uniquePoint();
    const p = await publishedProvider(app, n, {
      name: `Persian Service ${newId().slice(-6)}`,
      point,
      services: [chain.length > 1 ? system : node.id],
    });
    await flush(app, worker);
    const anon = await app.fixtures.anonymousToken();
    const arabic = node.fa.replace(/ی/g, 'ي').replace(/ک/g, 'ك');
    expect(arabic).not.toBe(node.fa);
    const persianRes = await search(anon, { query_text: node.fa, location: area(point) });
    const arabicRes = await search(anon, { query_text: arabic, location: area(point) });
    expect(persianRes.status).toBe(200);
    expect(ids(persianRes)).toContain(p.id);
    expect(ids(arabicRes)).toEqual(ids(persianRes));
    expect(arabicRes.body.query_normalized).toBe(persianRes.body.query_normalized);
    const chip = (r: { body: Json }) => (r.body.interpreted_intent.chips as Json[]).find((c) => c.node_id === node.id);
    expect(chip(persianRes)).toBeDefined();
    expect(chip(arabicRes)).toEqual(chip(persianRes));
  });

  it('safety.check flags a safety-critical symptom in EN and FA (and search carries the banner)', async () => {
    const terms = await app.app.get(SafetyLexicon, { strict: false }).terms();
    const critical = terms.find((t) => t.urgency === 'safety_critical')!;
    const node = (await app.app.get(TaxonomyResolver, { strict: false }).get(critical.nodeId))!;
    const anon = await app.fixtures.anonymousToken();
    for (const text of [node.nameTranslations.en!, node.nameTranslations.fa!]) {
      const res = await app.request<Json>({ method: 'POST', path: '/v1/safety/check', token: anon, body: { text: `my car: ${text}` } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ flag: true, level: 'urgent', message_i18n_key: 'safety.banner.urgent', urgent_help_available: true });
    }
    expect(
      (await app.request<Json>({ method: 'POST', path: '/v1/safety/check', token: anon, body: { text: 'oil change please' } })).body.flag,
    ).toBe(false);
    const s = await search(anon, { query_text: node.nameTranslations.en!, location: area(uniquePoint()) });
    expect(s.body.safety).toMatchObject({ flag: true, level: 'urgent' });
    expect(s.body.interpreted_intent.chips.some((c: Json) => c.kind === 'symptom' && c.node_id === critical.nodeId)).toBe(true);
  });

  it('pages, refines and records result events of a session that belongs to its requester', async () => {
    const point = uniquePoint();
    const tag = newId().slice(-6);
    for (const i of [1, 2, 3]) await publishedProvider(app, n, { name: `Oasis ${tag} ${i}`, point: near(point, 0.002 * i, 0) });
    await flush(app, worker);
    const anon = await app.fixtures.anonymousToken();
    const first = await search(anon, { location: area(point), limit: 1, sort: 'distance' });
    expect(first.body.results).toHaveLength(1);
    expect(first.body.next_cursor).toEqual(expect.any(String));
    const sid = first.body.session_id as string;
    const page = await app.request<Json>({
      path: `/v1/search/${sid}/results?cursor=${encodeURIComponent(first.body.next_cursor)}`,
      token: anon,
    });
    expect(page.status).toBe(200);
    expect(page.body.items[0].rank).toBe(2);
    expect(page.body.items.length).toBeGreaterThanOrEqual(2);
    // Another caller cannot page, refine or mark this session (RLS requester_all).
    const other = await app.fixtures.anonymousToken();
    // The cursor is signed for its caller (40 §3.3): another caller's page request is refused before the session is read.
    const foreignPage = await app.request<Json>({
      path: `/v1/search/${sid}/results?cursor=${encodeURIComponent(first.body.next_cursor)}`,
      token: other,
    });
    expect(foreignPage.body.code).toBe('CURSOR_MISMATCH');
    const foreignRefine = await app.request<Json>({ method: 'POST', path: `/v1/search/${sid}/refine`, token: other, body: {} });
    expect(foreignRefine.status, foreignRefine.text).toBe(404);
    const refined = await app.request<Json>({ method: 'POST', path: `/v1/search/${sid}/refine`, token: anon, body: { sort: 'rating' } });
    expect(refined.status).toBe(200);
    expect(refined.body.session_id).not.toBe(sid);
    const resultId = first.body.results[0].result_id as string;
    expect(
      (
        await app.request<Json>({
          method: 'POST',
          path: `/v1/search/${sid}/results/${resultId}/events`,
          token: anon,
          body: { event: 'selected' },
        })
      ).body,
    ).toEqual({ ok: true });
    expect(
      (
        await app.request<Json>({
          method: 'POST',
          path: `/v1/search/${sid}/results/${newId()}/events`,
          token: anon,
          body: { event: 'viewed' },
        })
      ).status,
    ).toBe(404);
    const row = await app.fixtures.worker.run({ actorType: 'system' }, ({ db }) =>
      db.selectFrom('discovery.match_results').select(['selected_at', 'is_sponsored']).where('id', '=', resultId).executeTakeFirstOrThrow(),
    );
    expect(row.selected_at).not.toBeNull();
    expect(row.is_sponsored).toBe(false);
  });

  it('needs sign-in for a vehicle or a device position, and location_usage consent for the position', async () => {
    const anon = await app.fixtures.anonymousToken();
    expect((await search(anon, { vehicle_id: newId(), location: area(uniquePoint()) })).status).toBe(401);
    const user = await app.fixtures.user();
    const token = await app.fixtures.token(user);
    const position = { mode: 'user_position', point: uniquePoint() };
    const denied = await search(token, { location: position });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('LOCATION_CONSENT_REQUIRED');
    await grantConsent(client(app, token), 'location_usage', null, null);
    expect((await search(token, { location: position })).status).toBe(200);
    expect((await search(token, { location: { mode: 'chosen_city', city_key: 'atlantis' } })).body.code).toBe('VALIDATION_FAILED');
  });

  it("parts: a vendor with a fitting item is found for the caller's vehicle, with the item card and its fitment", async () => {
    const point = uniquePoint();
    const v = await publishedVendor(app, n, { name: `Sand Parts ${newId().slice(-6)}`, point });
    const fit = await v.c.post(`${v.vnd}/inventory/${v.itemId}/fitment`, {
      items: [{ brand_node_id: n.brand, model_node_id: n.model, confidence: 'confirmed' }],
    });
    expect(fit.status).toBe(200);
    await flush(app, worker);
    const owner = await app.fixtures.user();
    const vehicle = { id: await app.fixtures.vehicle(owner, n) };
    const token = await app.fixtures.token(owner);
    const parts = await search(token, { search_mode: 'parts', vehicle_id: vehicle.id, location: area(point) });
    expect(parts.status).toBe(200);
    const hit = (parts.body.results as Json[]).find((r) => r.target.id === v.itemId)!;
    expect(hit).toMatchObject({
      target: { type: 'inventory_item' },
      organization: { id: v.id, roles: ['vendor'] },
      item: { id: v.itemId, fitment_confidence_for_vehicle: 'confirmed', price: { amount: '450000.00', currency: 'IRR' } },
      relevant_to_vehicle: true,
    });
    const vendors = await search(token, { search_mode: 'vendors', vehicle_id: vehicle.id, location: area(point), query_text: 'brake pad' });
    const vc = (vendors.body.results as Json[]).find((r) => r.organization.id === v.id)!;
    expect(vc).toMatchObject({ matching_item_count: 1, relevant_to_vehicle: true });
    expect(vc.reasons.map((r: Json) => r.reason_type)).toContain('capability_evidence');
  });
});

describe('map.pins (40 §14.2)', () => {
  it('returns one pin per location with public fields, highlights filters and refuses oversized boxes', async () => {
    const point = uniquePoint();
    const p = await publishedProvider(app, n, { name: `Map Garage ${newId().slice(-6)}`, point });
    await flush(app, worker);
    const anon = await app.fixtures.anonymousToken();
    const viewport = area(point, 0.02).viewport;
    const res = await app.request<Json>({
      method: 'POST',
      path: '/v1/map/pins',
      token: anon,
      body: { viewport, layers: ['providers', 'vendors'] },
    });
    expect(res.status).toBe(200);
    const pin = (res.body.pins as Json[]).find((x) => x.organization_id === p.id)!;
    expect(pin).toMatchObject({ pin_id: p.locationId, roles: ['provider'], point, visibility: 'exact', matches_filters: true, rank: null });
    expect(res.body.attribution).toBe('© OpenStreetMap contributors');
    const dimmed = await app.request<Json>({
      method: 'POST',
      path: '/v1/map/pins',
      token: anon,
      body: { viewport, layers: ['providers'], filters: { verified_only: true } },
    });
    expect((dimmed.body.pins as Json[]).find((x) => x.organization_id === p.id)!.matches_filters).toBe(false);
    const huge = await app.request<Json>({
      method: 'POST',
      path: '/v1/map/pins',
      token: anon,
      body: { viewport: { center: point, zoom: 3, bbox: { south: 0, west: 0, north: 60, east: 80 } }, layers: ['providers'] },
    });
    expect(huge.status).toBe(422);
    expect(huge.body.code).toBe('VALIDATION_FAILED');
    // Ranks of a search session show on its pins.
    const s = await search(anon, { location: area(point, 0.02) });
    const ranked = await app.request<Json>({
      method: 'POST',
      path: '/v1/map/pins',
      token: anon,
      body: { viewport, layers: ['providers'], search_session_id: s.body.session_id },
    });
    expect((ranked.body.pins as Json[]).find((x) => x.organization_id === p.id)!.rank).toBeGreaterThanOrEqual(1);
  });
});

describe('public profiles (40 §14.3)', () => {
  it('serves the profile by slug with its ratings, reviews, portfolio and availability placeholder', async () => {
    const p = await publishedProvider(app, n, { name: `Review Garage ${newId().slice(-6)}` });
    const slug = `review-garage-${newId().slice(-8)}`;
    const author = await app.fixtures.user();
    await app.fixtures.worker.run({ actorType: 'system' }, async ({ db }) => {
      await db.updateTable('organization.organizations').set({ slug }).where('id', '=', p.id).execute();
      await db
        .insertInto('trust.reviews')
        .values({
          author_user_id: author.id,
          subject_organization_id: p.id,
          subject_type: 'provider',
          overall_rating: 4,
          body: 'Quick and honest brake service.',
          content_locale: 'en',
          confirmation_path: 'visit_based',
          verified_status: 'admin_verified',
          status: 'published',
          published_at: new Date(),
          trust_weight: '0.900',
          service_system_node_id: n.system,
        })
        .execute();
    });
    const anon = await app.fixtures.anonymousToken();
    const profile = await app.request<Json>({ path: `/v1/public/orgs/${slug}`, token: anon });
    expect(profile.status).toBe(200);
    expect(profile.headers['cache-control']).toBe('public, max-age=60');
    expect(profile.body).toMatchObject({
      id: p.id,
      slug,
      roles: ['provider'],
      overall_rating: '4',
      review_count: 1,
      rating_summary: { overall: '4', count_visit_verified: 1, count_approved_without_visit: 0, distribution: { '4': 1 } },
      provider: { provider_type: 'garage', badges: [] },
      vendor: null,
    });
    expect(JSON.stringify(profile.body)).not.toContain('trust_weight');
    const reviews = await app.request<Json>({ path: `/v1/public/orgs/${p.id}/reviews`, token: anon });
    expect(reviews.status).toBe(200);
    expect(reviews.body.items).toHaveLength(1);
    expect(reviews.body.items[0], JSON.stringify(reviews.body.items[0])).toMatchObject({
      label: 'verified_visit',
      overall_rating: 4,
      author: { display_name: expect.any(String), avatar_url: null },
    });
    expect((await app.request<Json>({ path: `/v1/public/orgs/${p.id}/reviews?path=approval_based`, token: anon })).body.items).toEqual([]);
    expect((await app.request<Json>({ path: `/v1/public/orgs/no-such-${newId().slice(-6)}`, token: anon })).status).toBe(404);
    expect((await app.request<Json>({ path: `/v1/public/orgs/${p.id}/portfolio`, token: anon })).body).toEqual({
      items: [],
      next_cursor: null,
    });
    const from = new Date().toISOString().slice(0, 10);
    const slots = await app.request<Json>({
      path: `/v1/public/orgs/${p.id}/availability?location_id=${p.locationId}&from=${from}`,
      token: anon,
    });
    expect(slots.body).toEqual({ slots: [] });
    expect(
      (await app.request<Json>({ path: `/v1/public/orgs/${p.id}/availability?location_id=${newId()}&from=${from}`, token: anon })).status,
    ).toBe(422);
  });

  it("searches a vendor's public items (a filter is required) and returns one item with its vendor card", async () => {
    const v = await publishedVendor(app, n, { name: `Item Seller ${newId().slice(-6)}` });
    const anon = await app.fixtures.anonymousToken();
    const path = `/v1/public/orgs/${v.id}/inventory/search`;
    const none = await app.request<Json>({ method: 'POST', path, token: anon, body: {} });
    expect(none.status).toBe(422);
    expect(none.body.errors).toEqual([{ pointer: '/text', code: 'conditional_required' }]);
    const found = await app.request<Json>({ method: 'POST', path, token: anon, body: { text: 'brake' } });
    expect(found.status).toBe(200);
    expect(found.body.items.map((i: Json) => i.id)).toEqual([v.itemId]);
    // Persian name in Arabic letters still matches (search normalization).
    const arabic = await app.request<Json>({ method: 'POST', path, token: anon, body: { text: 'لنت ترمز'.replace(/ی/g, 'ي') } });
    expect(arabic.body.items.map((i: Json) => i.id)).toEqual([v.itemId]);
    expect(
      (await app.request<Json>({ method: 'POST', path, token: anon, body: { part_category_node_id: n.partCategory } })).body.items,
    ).toHaveLength(1);
    const item = await app.request<Json>({ path: `/v1/public/inventory/${v.itemId}`, token: anon });
    expect(item.status).toBe(200);
    expect(item.body).toMatchObject({
      id: v.itemId,
      vendor: { id: v.id, roles: ['vendor'] },
      is_trade_price: false,
      location: { location_id: v.locationId },
    });
    expect(JSON.stringify(item.body)).not.toContain('price_trade');
    expect((await app.request<Json>({ path: `/v1/public/inventory/${newId()}`, token: anon })).status).toBe(404);
    // as_organization_id must be the caller's own provider or fleet.
    const stranger = await app.fixtures.memberOf('provider', 'provider_owner');
    const other = await app.fixtures.org('provider');
    expect(
      (await app.request<Json>({ method: 'POST', path, token: stranger.token, body: { text: 'brake', as_organization_id: other.id } }))
        .status,
    ).toBe(404);
  });
});

describe('feed.discover (40 §19.2)', () => {
  it('computes nearby providers for an anonymous caller', async () => {
    const point = uniquePoint();
    const p = await publishedProvider(app, n, { name: `Feed Garage ${newId().slice(-6)}`, point });
    await flush(app, worker);
    const anon = await app.fixtures.anonymousToken();
    const feed = await app.request<Json>({ method: 'POST', path: '/v1/feed/discover', token: anon, body: { location: area(point, 0.02) } });
    expect(feed.status).toBe(200);
    expect(
      (feed.body.items as Json[]).some((i) => i.kind === 'nearby_provider' && i.ref.id === p.id && i.card.organization.id === p.id),
    ).toBe(true);
  });
});
