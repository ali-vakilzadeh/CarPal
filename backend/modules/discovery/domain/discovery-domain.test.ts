// Discovery rules (S6): rule-based interpretation, match scores with reasons
// (54 §5: evidence over claims, never empty, urgency weights, favourites),
// reason summaries and map clustering.
import { describe, expect, it } from 'vitest';
import { searchTokens } from '#libs/i18n/index.js';
import { cluster } from './clustering.js';
import { interpret, ngrams } from './intent.js';
import { scoreItem, scoreProvider, scoreVendor, type MatchContext, type ProviderFacts } from './ranking.js';
import { reasonSummary, templateExplanation } from './reasons.js';

const terms = new Map([
  ['brake pads', [{ nodeId: 'task-pads', type: 'service_task' }]],
  ['brake', [{ nodeId: 'sys-brakes', type: 'service_system' }]],
  ['toyota', [{ nodeId: 'brand-toyota', type: 'vehicle_brand' }]],
  ['لنت ترمز', [{ nodeId: 'task-pads', type: 'service_task' }]],
]);
const cities = new Map([['tehran', 'tehran']]);

describe('interpret', () => {
  it('prefers the longest taxonomy phrase, reads target words and cities, and leaves the rest as free text', () => {
    const r = interpret(searchTokens('Toyota brake pads shop in Tehran Karimi'), terms, cities);
    expect(r.nodes.map((x) => x.nodeId)).toEqual(['brand-toyota', 'task-pads']);
    expect(r.targetHint).toBe('provider');
    expect(r.cityKey).toBe('tehran');
    expect(r.residual).toBe('karimi');
    expect(interpret(searchTokens('لنت ترمز قطعات'), terms, cities)).toMatchObject({
      nodes: [{ nodeId: 'task-pads' }],
      targetHint: 'vendor',
      residual: '',
    });
    expect(ngrams(['a', 'b', 'c'])).toEqual(['a', 'b', 'c', 'a b', 'b c', 'a b c']);
  });
});

const ctx = (o: Partial<MatchContext> = {}): MatchContext => ({
  services: new Set(['sys-brakes']),
  partCategories: new Set(),
  vehicle: null,
  urgency: null,
  maxDistanceKm: 50,
  favorites: new Set(),
  ...o,
});
const provider = (o: Partial<ProviderFacts> = {}): ProviderFacts => ({
  organization_id: 'p',
  capabilities: [],
  service_node_ids: ['sys-brakes'],
  brand_node_ids: ['brand-toyota'],
  model_node_ids: [],
  overall_rating: null,
  review_count: 0,
  verified: false,
  badges: [],
  measured_response_time_minutes: null,
  response_time_target: null,
  activity_status: 'active',
  service_modes: ['in_shop'],
  ...o,
});

describe('scores (54 §5)', () => {
  it('ranks verified evidence over claims and always explains itself', () => {
    const claim = scoreProvider(provider(), 5, ctx());
    const evidence = scoreProvider(
      provider({ capabilities: [{ brand: null, model: null, series: null, system: 'sys-brakes', task: null, level: 2, evidence: 5 }] }),
      5,
      ctx(),
    );
    expect(evidence.score).toBeGreaterThan(claim.score);
    expect(claim.reasons[0]).toMatchObject({ reason_type: 'capability_evidence', values: { level: 0, offered: true } });
    expect(evidence.reasons[0]).toMatchObject({ reason_type: 'capability_evidence', values: { level: 2, jobs: 5 } });
    for (const s of [claim, evidence, scoreProvider(provider(), null, ctx({ services: new Set() }))])
      expect(s.reasons.length).toBeGreaterThan(0);
  });

  it('adds the favourite bonus and the urgency reason, and rates vehicle relevance', () => {
    const base = scoreProvider(provider(), 10, ctx());
    const fav = scoreProvider(provider(), 10, ctx({ favorites: new Set(['p']) }));
    expect(fav.score - base.score).toBeCloseTo(5, 5);
    expect(fav.reasons.map((r) => r.reason_type)).toContain('user_preference');
    const urgent = scoreProvider(provider({ measured_response_time_minutes: 30 }), 10, ctx({ urgency: 'safety_critical' }));
    expect(urgent.reasons).toContainEqual({ reason_type: 'urgency_fit', values: { urgency_level: 'safety_critical', fast: true } });
    expect(scoreProvider(provider(), 10, ctx({ vehicle: { brand: 'brand-toyota' } })).relevant_to_vehicle).toBe(true);
    expect(scoreProvider(provider(), 10, ctx({ vehicle: { brand: 'brand-bmw' } })).relevant_to_vehicle).toBe(false);
    const vendor = (fitment: number) =>
      scoreVendor(
        {
          organization_id: 'v',
          part_category_node_ids: [],
          brand_node_ids: [],
          overall_rating: null,
          review_count: 0,
          verified: false,
          measured_response_time_minutes: null,
        },
        { count: 1, inStock: 1, fitment, bestConfidence: fitment === 1 ? 'confirmed' : null },
        3,
        ctx({ vehicle: { brand: 'b' } }),
      );
    expect(vendor(1).score).toBeGreaterThan(vendor(0).score);
    const item = (stock: string) =>
      scoreItem(
        {
          stock_status: stock,
          data_quality_score: 80,
          condition: 'new',
          price_on_request: false,
          fitmentWeight: 1,
          bestConfidence: 'confirmed',
        },
        { overall: null, count: 0 },
        2,
        ctx({ vehicle: { brand: 'b' } }),
        undefined,
      );
    expect(item('in_stock').score).toBeGreaterThan(item('out_of_stock').score);
  });

  it('summarizes reasons in EN and FA with taxonomy labels', () => {
    const labels = new Map([['sys-brakes', { text: 'Brakes', locale: 'en' as const }]]);
    const r = {
      reason_type: 'capability_evidence' as const,
      values: { level: 3, jobs: 9, system_node_id: 'sys-brakes', task_node_id: null, brand_node_id: null },
    };
    expect(reasonSummary(r, 'en', labels).text).toBe('Specialist in Brakes · 9 verified jobs');
    expect(reasonSummary({ reason_type: 'location', values: { distance_km: '3.4' } }, 'fa', labels)).toEqual({
      text: '3.4 کیلومتر فاصله',
      locale: 'fa',
    });
    expect(templateExplanation([r, { reason_type: 'user_preference', values: { favorite: true } }], 'en', labels)).toBe(
      'Specialist in Brakes · 9 verified jobs; In your favourites',
    );
  });
});

describe('cluster', () => {
  it('keeps single pins when zoomed in and groups them by grid cell otherwise', () => {
    const pins = [0, 1, 2].map((i) => ({ id: `p${i}`, point: { lat: 35.7 + i * 0.0001, lng: 51.4 } }));
    expect(cluster(pins, 15)).toMatchObject({ pins: { length: 3 }, clusters: [] });
    const c = cluster([...pins, { id: 'far', point: { lat: 30, lng: 50 } }], 8);
    expect(c.pins.map((p) => p.id)).toEqual(['far']);
    expect(c.clusters).toHaveLength(1);
    expect(c.clusters[0]).toMatchObject({ count: 3, expansion_zoom: 10 });
  });
});
