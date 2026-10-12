// S3 taxonomy (40 §11): version, snapshot, node_get, suggest; TaxonomyResolver
// (NodeId<type> checks, parent chains), the safety lexicon (L18) and cache
// invalidation. Responses are checked against the contract by the pipeline.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '#libs/contract/index.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { NodeTypeChecker } from '#libs/http-pipeline/index.js';
import { SafetyCheck } from '#libs/safety-check/index.js';
import { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';
import { createTestApp, type TestApp } from './test-app.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deep assertions on validated responses
type Json = Record<string, any>;

let app: TestApp;
let resolver: TaxonomyResolver;
let anon: string;
const idOf = new Map<string, string>();

async function nodeId(type: string, slug: string): Promise<string> {
  const key = `${type}:${slug}`;
  if (!idOf.has(key)) {
    const res = await app.request<Json>({ path: `/v1/taxonomy/nodes?type=${type}&limit=500`, token: anon });
    for (const n of res.body.items) idOf.set(`${n.type}:${n.slug}`, n.id);
  }
  const id = idOf.get(key);
  if (!id) throw new Error(`no node ${key}`);
  return id;
}

beforeAll(async () => {
  app = await createTestApp({ host: 'api' });
  resolver = app.app.get(TaxonomyResolver, { strict: false });
  anon = await app.fixtures.anonymousToken();
});
afterAll(() => app.close());

describe('taxonomy.version / config.client', () => {
  it('returns the catalog version, cacheable for 5 min, and config.client shows the same version', async () => {
    const res = await app.request<Json>({ path: '/v1/taxonomy/version', token: anon });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body.version).toMatch(/^t[0-9a-z]+-[0-9a-z]+$/);
    const cfg = await app.request<Json>({ path: '/v1/config/client', token: anon });
    expect(cfg.body.taxonomy_version).toBe(res.body.version);
  });
});

describe('taxonomy.snapshot', () => {
  it('lists active nodes of one type in the requested locale with an ETag and a 1 h public cache', async () => {
    const res = await app.request<Json>({
      path: '/v1/taxonomy/nodes?type=service_system',
      token: anon,
      headers: { 'accept-language': 'fa' },
    });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers['content-language']).toBe('fa');
    expect(res.headers.etag).toMatch(/^"t[0-9a-z]+-[0-9a-z]+"$/);
    expect(res.body.items.length).toBe(24);
    expect(res.body.next_cursor).toBeNull();
    expect(res.body.items.every((n: Json) => n.type === 'service_system' && n.status === 'active' && n.name.locale === 'fa')).toBe(true);
    const orders = res.body.items.map((n: Json) => n.sort_order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('filters by parent and pages with a signed cursor', async () => {
    const brakes = await nodeId('service_system', 'brakes');
    const first = await app.request<Json>({ path: `/v1/taxonomy/nodes?type=service_task&parent_id=${brakes}&limit=2`, token: anon });
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.items.every((n: Json) => n.parent_id === brakes)).toBe(true);
    const second = await app.request<Json>({
      path: `/v1/taxonomy/nodes?type=service_task&parent_id=${brakes}&limit=2&cursor=${first.body.next_cursor}`,
      token: anon,
    });
    expect(second.status).toBe(200);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
    // The cursor is bound to the filters (40 §3.3).
    const other = await app.request<Json>({
      path: `/v1/taxonomy/nodes?type=symptom&limit=2&cursor=${first.body.next_cursor}`,
      token: anon,
    });
    expect(other.status).toBe(400);
    expect(other.body.code).toBe('CURSOR_MISMATCH');
  });

  it('needs a type (422) and refuses unknown query parameters (400)', async () => {
    expect((await app.request({ path: '/v1/taxonomy/nodes', token: anon })).status).toBe(422);
    expect((await app.request({ path: '/v1/taxonomy/nodes?type=symptom&q=x', token: anon })).status).toBe(400);
  });
});

describe('taxonomy.node_get', () => {
  it('returns one node with resolved labels and attributes; 404 for unknown ids', async () => {
    const id = await nodeId('symptom', 'brake-problem');
    const res = await app.request<Json>({ path: `/v1/taxonomy/nodes/${id}`, token: anon, headers: { 'accept-language': 'en' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, type: 'symptom', slug: 'brake-problem', attributes: { safety_critical: true }, status: 'active' });
    expect(res.body.name.locale).toBe('en');
    expect((await app.request({ path: `/v1/taxonomy/nodes/${uuidv7()}`, token: anon })).status).toBe(404);
  });
});

describe('taxonomy.suggest', () => {
  const suggest = (text: string, types: string[], extra: Json = {}, locale = 'fa') =>
    app.request<Json>({
      method: 'POST',
      path: '/v1/taxonomy/suggest',
      token: anon,
      body: { text, types, ...extra },
      headers: { 'accept-language': locale },
    });

  it('matches Persian input and its Arabic-character variant identically', async () => {
    // "lent" brake pad in Persian with Persian yeh/kaf, then typed with Arabic yeh (U+064A) and kaf (U+0643).
    const persian = await suggest('لنت ترمز', ['service_task', 'part_category', 'symptom']);
    const arabic = await suggest('لنت ترمز'.replace(/ی/g, 'ي').replace(/ک/g, 'ك'), ['service_task', 'part_category', 'symptom']);
    expect(persian.status).toBe(200);
    expect(persian.body.items.length).toBeGreaterThan(0);
    expect(arabic.body.items.map((i: Json) => i.node.id)).toEqual(persian.body.items.map((i: Json) => i.node.id));
    const kaf = await suggest('کلاچ', ['service_task', 'part_category', 'service_system']);
    const kafArabic = await suggest('كلاچ', ['service_task', 'part_category', 'service_system']);
    expect(kaf.body.items.length).toBeGreaterThan(0);
    expect(kafArabic.body.items.map((i: Json) => i.node.id)).toEqual(kaf.body.items.map((i: Json) => i.node.id));
  });

  it('matches names by prefix in English, synonyms and Latin transliterations, at most 10 items', async () => {
    const en = await suggest('brak', ['symptom', 'service_system'], {}, 'en');
    expect(en.status).toBe(200);
    expect(en.body.items.length).toBeGreaterThan(0);
    expect(en.body.items.length).toBeLessThanOrEqual(10);
    expect(en.body.items[0].matched_term.toLowerCase()).toMatch(/^brak/);
    const translit = await suggest('tormoz', ['service_system']);
    expect(translit.body.items.some((i: Json) => i.match_kind === 'transliteration')).toBe(true);
    const digits = await suggest('۴', ['vehicle_model']); // Persian digit normalized to 4
    expect(digits.status).toBe(200);
  });

  it('filters by type and by an ancestor node', async () => {
    const brand = await nodeId('vehicle_brand', 'peugeot');
    const res = await suggest('20', ['vehicle_model', 'vehicle_series'], { parent_id: brand }, 'en');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const i of res.body.items) expect(await resolver.ancestors(i.node.id)).toContain(brand);
  });
});

describe('TaxonomyResolver and NodeTypeChecker', () => {
  it('require() answers REFERENCE_NOT_FOUND for unknown ids and TAXONOMY_MISMATCH for another type', async () => {
    const brand = await nodeId('vehicle_brand', 'peugeot');
    await expect(resolver.require(brand, ['vehicle_brand'], '/brand_node_id')).resolves.toMatchObject({ id: brand });
    const err1 = await resolver.require(uuidv7(), ['vehicle_brand'], '/brand_node_id').catch((e: unknown) => e);
    expect(err1).toBeInstanceOf(ApiError);
    expect((err1 as ApiError).code).toBe('REFERENCE_NOT_FOUND');
    expect((err1 as ApiError).errors).toEqual([{ pointer: '/brand_node_id', code: 'reference_not_found' }]);
    const err2 = await resolver.require(brand, ['vehicle_model'], '/model_node_id').catch((e: unknown) => e);
    expect((err2 as ApiError).code).toBe('TAXONOMY_MISMATCH');
  });

  it('checks parent chains (model under brand)', async () => {
    const peugeot = await nodeId('vehicle_brand', 'peugeot');
    const res = await app.request<Json>({ path: `/v1/taxonomy/nodes?type=vehicle_model&parent_id=${peugeot}&limit=1`, token: anon });
    const model = res.body.items[0].id as string;
    await expect(resolver.requireDescendant(model, peugeot, '/model_node_id')).resolves.toBeUndefined();
    const other = await nodeId('vehicle_brand', 'toyota');
    const err = await resolver.requireDescendant(model, other, '/model_node_id').catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('TAXONOMY_MISMATCH');
  });

  it('the pipeline NodeTypeChecker reports every bad reference in one 422', async () => {
    const checker = app.app.get(NodeTypeChecker, { strict: false });
    const brand = await nodeId('vehicle_brand', 'peugeot');
    const err = await checker
      .check([
        { pointer: '/a', id: brand, types: ['vehicle_model'] },
        { pointer: '/b', id: uuidv7(), types: ['vehicle_brand'] },
        { pointer: '/c', id: brand, types: ['vehicle_brand', 'vehicle_model'] },
      ])
      .catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('TAXONOMY_MISMATCH');
    expect((err as ApiError).errors?.map((e) => e.pointer)).toEqual(['/a', '/b']);
  });
});

describe('safety lexicon (L18)', () => {
  it('flags safety-critical symptoms in EN and FA, including keywords and Latin transliterations', async () => {
    const safety = app.app.get(SafetyCheck, { strict: false });
    for (const text of ['My BRAKES feel soft', 'بوی سوختگی میاد', 'tormoz kar nemikone', 'ماشین جوش آورده', 'airbag light is on']) {
      const r = await safety.check(text);
      expect(r.safety_flag, text).toBe(true);
      expect(r.urgency).toBe('safety_critical');
    }
    const quiet = await safety.check('I need an oil change');
    expect(quiet).toEqual({ safety_flag: false, urgency: null, matched_node_ids: [] });
  });
});
