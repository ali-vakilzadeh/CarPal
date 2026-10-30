// P8.T7 (units): the community view models — the contact-data rule (checked against the backend's autoModeration, a
// drift check like the analytics registry), question indexing, answer order, reaction vocabulary and the optimistic
// step, the Discover feed's cards and blocks, Q&A filters in the URL, the ask body, report reasons, related-question
// words and the attention dates.
import type { FeedItem, PublicAnswer, PublicOrgCard, VehicleDocument } from '@carpal/api-contracts';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reportReasons, parseReportTarget } from '@/components/shell/report';
import { searchWords } from '@/server/ssr/community';
import { hasContext, questionBody } from './ask-form';
import { daysUntil, expiringDocuments } from './home';
import {
  BLOCK_EVERY,
  excerpt,
  feedBlocks,
  heldForReview,
  isIndexable,
  orderAnswers,
  questionContext,
  reactionsFor,
  readFeedItem,
  textLength,
  toggled,
} from './model';
import { parseQaFilters, qaFilterQuery, qaSearchBody } from './qa-filters';

const backendRules = join(__dirname, '../../../../backend/modules/community/domain/rules.ts');
const ID = (n: number) => `0195f3b1-6a2b-7c3d-8e4f-${String(n).padStart(12, '0')}`;

const org = (n: number): PublicOrgCard => ({
  id: ID(n),
  slug: `shop-${n}`,
  name: `Shop ${n}`,
  organization_type: 'independent_garage' as PublicOrgCard['organization_type'],
  roles: ['provider'],
  verified: true,
  overall_rating: '4.5',
  review_count: 3,
  top_badges: [],
  price_tier: null,
  measured_response_time_minutes: null,
  logo_url: null,
  portfolio_thumbnail_url: null,
});

const answer = (n: number, helpful: number, at: string): PublicAnswer => ({
  id: ID(n),
  question_id: ID(0),
  author: { display_name: `A${n}`, avatar_url: null },
  organization: null,
  body: 'An answer body',
  content_locale: 'en',
  helpful_count: helpful,
  accepted: false,
  created_at: at,
});

describe('contact-data rule (GD-22, BA-17)', () => {
  const samples = [
    'Use winter tyres on 17 inch wheels',
    'call me on 0912 345 6789',
    'زنگ بزنید ۰۹۱۲۳۴۵۶۷۸۹',
    'mail sara@example.com please',
    'see www.example.ir for prices',
    'check carpal.app later',
    'https://example.com/tyres',
    'Plate 22 B 345 is mine',
    'The price was 1,850,000 toman',
    'سلام، لاستیک زمستانی برای E90',
  ];

  it('matches the backend autoModeration exactly', async () => {
    const backend = (await import(/* @vite-ignore */ pathToFileURL(backendRules).href)) as {
      autoModeration: (...t: string[]) => 'approved' | 'pending';
    };
    for (const s of samples) expect(heldForReview(s), s).toBe(backend.autoModeration(s) === 'pending');
    expect(heldForReview('title', 'call 09123456789')).toBe(backend.autoModeration('title', 'call 09123456789') === 'pending');
  });

  it('holds links, emails and phones in any digits', () => {
    expect(heldForReview('Use winter tyres')).toBe(false);
    expect(heldForReview('زنگ بزنید ۰۹۱۲۳۴۵۶۷۸۹')).toBe(true);
    expect(heldForReview(null, undefined, 'a@b.co')).toBe(true);
  });

  it('counts code points', () => {
    expect(textLength('  سلام  ')).toBe(4);
    expect(textLength('🚗🚗')).toBe(2);
  });
});

describe('questions', () => {
  it('indexes only answered questions with an accepted answer (OQ-20)', () => {
    expect(isIndexable({ status: 'answered', accepted_answer_id: ID(1) })).toBe(true);
    expect(isIndexable({ status: 'open', accepted_answer_id: null })).toBe(false);
    expect(isIndexable({ status: 'closed', accepted_answer_id: ID(1) })).toBe(false);
  });

  it('orders accepted first, then helpful, then oldest', () => {
    const list = [answer(1, 2, '2026-10-02T00:00:00Z'), answer(2, 5, '2026-10-03T00:00:00Z'), answer(3, 2, '2026-10-01T00:00:00Z')];
    expect(orderAnswers(list, null).map((a) => a.id)).toEqual([ID(2), ID(3), ID(1)]);
    expect(orderAnswers(list, ID(1)).map((a) => a.id)).toEqual([ID(1), ID(2), ID(3)]);
  });

  it('shows the public context only', () => {
    expect(
      questionContext({
        vehicle: { brand: { text: 'BMW', locale: 'en' }, model: { text: '3 Series', locale: 'en' }, series: null },
        category: { text: 'Tyres', locale: 'en' },
        symptom: null,
      }),
    ).toEqual(['BMW 3 Series', 'Tyres']);
  });

  it('cuts excerpts at the limit', () => {
    expect(excerpt('a  b\nc')).toBe('a b c');
    expect([...excerpt('x'.repeat(300), 10)].length).toBe(10);
  });

  it('picks the longest title words for related questions', () => {
    expect(searchWords('Which winter tyres fit an E90 on 17-inch wheels?')).toEqual(['winter', 'wheels']);
    expect(searchWords('لاستیک زمستانی برای E90')).toEqual(['زمستانی', 'لاستیک']);
    expect(searchWords('a b 2024')).toEqual([]);
  });
});

describe('reactions', () => {
  it('follows the contract vocabulary (DI-49)', () => {
    expect(reactionsFor('answer').map((r) => r.type)).toEqual(['helpful']);
    expect(reactionsFor('portfolio_item').map((r) => r.label)).toEqual(['community.reaction.greatWork']);
    expect(reactionsFor('comment').map((r) => r.label)).toEqual(['community.reaction.thanks']);
    expect(reactionsFor('post').map((r) => r.type)).toEqual(['helpful', 'like']);
  });

  it('toggles optimistically without going below zero', () => {
    expect(toggled({ on: false, count: 2 })).toEqual({ on: true, count: 3 });
    expect(toggled({ on: true, count: 0 })).toEqual({ on: false, count: 0 });
  });
});

describe('Discover feed (DI-07)', () => {
  const provider = (n: number, kind: FeedItem['kind'] = 'nearby_provider'): FeedItem => ({
    kind,
    ref: { type: 'organization', id: ID(n) },
    card: { organization: org(n), distance_km: '2.4' },
  });
  const showcase = (n: number): FeedItem => ({
    kind: 'showcase',
    ref: { type: 'portfolio_item', id: ID(n) },
    card: {
      title: `Showcase ${n}`,
      organization: org(1),
      service_system: { text: 'Brakes', locale: 'en' },
      thumbnail_url: null,
      published_at: '2026-10-01T00:00:00Z',
    },
  });
  const question = (n: number): FeedItem => ({
    kind: 'qna',
    ref: { type: 'question', id: ID(n) },
    card: { title: `Q${n}`, status: 'open', answer_count: 1, created_at: '2026-10-01T00:00:00Z' },
  });

  it('reads cards defensively', () => {
    expect(readFeedItem(provider(1))).toMatchObject({ kind: 'provider', distanceKm: 2.4, forVehicle: false });
    expect(readFeedItem({ kind: 'nearby_provider', ref: { type: 'organization', id: ID(1) }, card: {} })).toBeNull();
    expect(readFeedItem({ kind: 'qna', ref: { type: 'question', id: ID(1) }, card: { title: 3 } })).toBeNull();
    expect(
      readFeedItem({
        kind: 'followed_update',
        ref: { type: 'post', id: ID(9) },
        card: {
          organization_id: ID(1),
          post_type: 'special_offer',
          title: null,
          excerpt: 'Winter offer',
          published_at: '2026-10-01T00:00:00Z',
        },
      }),
    ).toMatchObject({ kind: 'update', orgId: ID(1), postType: 'special_offer', title: null });
  });

  it('puts blocks after the first two cards, then every BLOCK_EVERY cards, and drops duplicates', () => {
    const items = [
      provider(1, 'recommended_for_vehicle'),
      question(50),
      ...Array.from({ length: 12 }, (_, i) => showcase(100 + i)),
      showcase(100),
    ];
    const blocks = feedBlocks(items);
    expect(blocks.map((b) => b.kind).slice(0, 4)).toEqual(['card', 'card', 'recommended', 'card']);
    expect(blocks.filter((b) => b.kind === 'card')).toHaveLength(12);
    expect(blocks.findIndex((b) => b.kind === 'questions')).toBe(2 + 1 + BLOCK_EVERY + 0);
  });

  it('appends blocks to a feed without stream cards', () => {
    expect(feedBlocks([question(1), provider(2, 'recommended_for_vehicle')]).map((b) => b.kind)).toEqual(['recommended', 'questions']);
  });
});

describe('Q&A hub filters (GD-14: ids only)', () => {
  it('round-trips through the URL and drops bad values', () => {
    const f = parseQaFilters(new URLSearchParams(`status=answered&cat=${ID(1)}&brand=${ID(2)}&model=${ID(3)}&q=hello`));
    expect(f).toEqual({ status: 'answered', categoryId: ID(1), brandId: ID(2), modelId: ID(3) });
    expect(qaFilterQuery(f)).toBe(`status=answered&cat=${ID(1)}&brand=${ID(2)}&model=${ID(3)}`);
    expect(parseQaFilters({ status: 'nope', cat: 'x', model: ID(3) })).toEqual({});
  });

  it('builds the search body, my car winning over the URL car', () => {
    expect(qaSearchBody({ status: 'open', brandId: ID(2) }, ' tyres ', null)).toEqual({
      text: 'tyres',
      brand_node_id: ID(2),
      status: 'open',
      limit: 20,
    });
    expect(qaSearchBody({ brandId: ID(2), modelId: ID(3) }, '', { brandId: ID(7), modelId: ID(8) })).toEqual({
      brand_node_id: ID(7),
      model_node_id: ID(8),
      limit: 20,
    });
  });
});

describe('ask body (QuestionWrite)', () => {
  it('sends the private vehicle link instead of the picked brand, and the context', () => {
    expect(
      questionBody({ title: ' Winter\ntyres? ', body: ' details here ', vehicleId: ID(1), brandId: ID(2), categoryId: ID(3) }, 'fa'),
    ).toEqual({
      vehicle_id: ID(1),
      category_node_id: ID(3),
      title: 'Winter tyres?',
      body: 'details here',
      content_locale: 'fa',
    });
    expect(
      questionBody({ title: 'Title', body: 'Body text!!', brandId: ID(2), modelId: ID(4), seriesId: ID(5), mediaIds: [ID(9)] }, 'en'),
    ).toMatchObject({
      brand_node_id: ID(2),
      model_node_id: ID(4),
      series_node_id: ID(5),
      media_ids: [ID(9)],
    });
  });

  it('needs a car, a symptom or a category', () => {
    expect(hasContext({ title: 't', body: 'b', brandId: ID(1) })).toBe(false);
    expect(hasContext({ title: 't', body: 'b', symptomId: ID(1) })).toBe(true);
    expect(hasContext({ title: 't', body: 'b', vehicleId: ID(1) })).toBe(true);
  });
});

describe('report reasons (S-SHARED-08)', () => {
  it('offers reasons per target from the ModerationReason enum', () => {
    expect(reportReasons('answer')).toContain('unsafe_advice');
    expect(reportReasons('organization')).toContain('wrong_location_or_closed');
    expect(reportReasons('inventory_item')).toContain('inaccurate_fitment');
    expect(reportReasons('portfolio_item')).toContain('non_consensual_media');
    for (const t of ['answer', 'organization', 'review', 'ai_output'] as const) expect(reportReasons(t).at(-1)).toBe('other');
  });

  it('accepts only known targets and uuids from the URL', () => {
    expect(parseReportTarget(new URLSearchParams(`rt=answer&rid=${ID(1)}`))).toEqual({ type: 'answer', id: ID(1) });
    expect(parseReportTarget(new URLSearchParams(`rt=everything&rid=${ID(1)}`))).toBeNull();
    expect(parseReportTarget(new URLSearchParams('rt=answer&rid=1'))).toBeNull();
  });
});

describe('Needs your attention dates', () => {
  const now = new Date(2026, 9, 30, 15, 0);
  const doc = (n: number, expires?: string, status: VehicleDocument['status'] = 'active') =>
    ({ id: ID(n), title: `D${n}`, status, ...(expires ? { expires_at: expires } : {}) }) as VehicleDocument;

  it('counts calendar days', () => {
    expect(daysUntil('2026-10-30', now)).toBe(0);
    expect(daysUntil('2026-11-29', now)).toBe(30);
    expect(daysUntil('2026-10-29', now)).toBe(-1);
  });

  it('lists documents expiring within 30 days, soonest first', () => {
    const list = expiringDocuments(
      [doc(1, '2026-12-31'), doc(2, '2026-11-20'), doc(3, '2026-10-01'), doc(4), doc(5, '2026-11-01', 'removed')],
      now,
    );
    expect(list.map((d) => d.title)).toEqual(['D3', 'D2']);
  });
});
