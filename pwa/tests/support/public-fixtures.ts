// Fixtures of the public reads (P5 tests): a provider, a vendor, reviews, a showcase and a part, shaped like the
// generated contract types (Docs/40 §14.1, §15, §19).
import type {
  MediaAttachmentView,
  PublicCapability,
  PublicInventoryItem,
  PublicOrgCard,
  PublicOrgProfile,
  PublicPortfolioItem,
  PublicReview,
} from '@carpal/api-contracts';

const en = (text: string) => ({ text, locale: 'en' as const });

export const card = (o: Partial<PublicOrgCard> = {}): PublicOrgCard => ({
  id: '01a17000-0000-7000-8000-00000000000a',
  slug: 'reza-auto-suspension',
  name: 'Reza Auto Suspension',
  organization_type: 'provider',
  roles: ['provider'],
  verified: true,
  overall_rating: '4.80',
  review_count: 126,
  top_badges: ['verified_business', 'make_specialist'],
  price_tier: 'mid_range',
  measured_response_time_minutes: 40,
  logo_url: null,
  portfolio_thumbnail_url: 'https://media.example/cover.jpg',
  ...o,
});

export const capability = (o: Partial<PublicCapability> = {}): PublicCapability => ({
  brand: en('BMW'),
  model: en('3 Series'),
  series: en('E90'),
  service_system: en('Suspension'),
  service_task: null,
  experience_level: 'specialist',
  confidence_level: 'strong_evidence',
  evidence_count: 19,
  ...o,
});

export const providerProfile = (o: Partial<PublicOrgProfile> = {}): PublicOrgProfile => ({
  ...card(),
  description: en('Suspension and steering for European cars.'),
  website: 'https://reza-auto.example',
  contact_channels: [{ type: 'phone', value: '+982166001122', preferred: true }],
  locations: [
    {
      id: '01a17000-0000-7000-8000-0000000000b1',
      name: 'Main workshop',
      point: { lat: 35.7, lng: 51.4 },
      visibility: 'exact',
      address: { address_line_1: '14 Sattarkhan St', city: 'Tehran', region: null, country: 'IR' },
      service_radius_km: null,
      hours: {
        weekly: [6, 0, 1, 2, 3]
          .map((d) => ({ day_of_week: d, open: '08:00:00', close: '18:00:00' }))
          .concat([{ day_of_week: 4, open: '08:00', close: '14:00' }]),
      },
      open_now: true,
      timezone: 'Asia/Tehran',
      access_instructions: null,
    },
  ],
  rating_summary: {
    overall: '4.70',
    count_visit_verified: 100,
    count_approved_without_visit: 26,
    distribution: { '1': 1, '2': 1, '3': 5, '4': 15, '5': 104 },
    sub_ratings: [{ dimension: 'work_quality', average: '4.90' }],
  },
  provider: {
    provider_type: 'garage',
    years_in_business: 12,
    languages_spoken: ['fa', 'en'],
    amenities: [],
    service_modes: ['in_shop'],
    price_tier: 'mid_range',
    warranty_offered: true,
    warranty_policy: en('6 months on parts and labour'),
    response_time_target: 'same_day',
    service_categories: [{ node_id: 'n-susp', label: en('Suspension'), experience_level: 'specialist' }],
    coverage: [{ brand: en('BMW'), model: null, series: null }],
    capabilities: [
      capability(),
      capability({ series: null, model: null, service_system: en('Brakes'), confidence_level: 'moderate_evidence', evidence_count: 4 }),
      capability({ brand: en('Toyota'), model: en('Corolla'), series: null, confidence_level: 'low_evidence', evidence_count: 2 }),
    ],
    certifications: [{ name: 'Bosch Car Service', issuer: 'Bosch', certification_type: 'manufacturer' } as never],
    badges: [{ badge_type: 'make_specialist', scope: [en('BMW')], awarded_at: '2026-09-01T00:00:00Z' }],
  },
  vendor: null,
  ...o,
});

export const vendorProfile = (o: Partial<PublicOrgProfile> = {}): PublicOrgProfile => ({
  ...providerProfile(),
  ...card({
    id: '01a17000-0000-7000-8000-00000000000c',
    slug: 'mina-parts',
    name: 'Mina Parts',
    organization_type: 'vendor',
    roles: ['vendor'],
  }),
  provider: null,
  vendor: {
    vendor_type: 'parts_retailer',
    delivery_options: ['pickup', 'local_delivery'],
    trade_customers_supported: true,
    default_price_visibility: 'public',
    return_policy: en('7 days, unused'),
    warranty_policy: null,
    catalog_quality_score: 80,
    coverage: [
      { node_id: 'pc-1', label: en('Control arms'), coverage_type: 'part_category' },
      { node_id: 'b-bmw', label: en('BMW'), coverage_type: 'brand' },
    ],
  },
  ...o,
});

export const review = (o: Partial<PublicReview> = {}): PublicReview => ({
  id: '01a17000-0000-7000-8000-0000000000d1',
  author: { display_name: 'Sara M.', avatar_url: null },
  subject_location_id: null,
  vehicle: { brand: en('BMW'), model: en('3 Series'), series: en('E90') },
  service_system: en('Suspension'),
  service_task: null,
  service_date: '2026-10-10',
  overall_rating: 5,
  would_return: true,
  title: null,
  body: 'The clunk was the front right control arm.',
  content_locale: 'en',
  sub_ratings: [],
  tags: [{ node_id: 't1', label: en('Fair price') }],
  media: [],
  label: 'verified_visit',
  disputed_by_business: false,
  helpful_count: 12,
  response: { response_text: 'Thank you Sara!', content_locale: 'en', published_at: '2026-10-12T00:00:00Z' },
  published_at: '2026-10-11T09:00:00Z',
  ...o,
});

export const media = (o: Partial<MediaAttachmentView> = {}): MediaAttachmentView => ({
  attachment_id: `a-${Math.random()}`,
  media_asset_id: 'm1',
  media_type: 'image',
  role: 'after',
  pair_group_key: 'p1',
  display_order: 0,
  caption: null,
  url: 'https://media.example/after.jpg',
  thumbnail_url: 'https://media.example/after-t.jpg',
  width: 1200,
  height: 900,
  ...o,
});

export const showcase = (o: Partial<PublicPortfolioItem> = {}): PublicPortfolioItem => ({
  id: '01a17000-0000-7000-8000-0000000000e1',
  organization: card(),
  title: 'Worn front control arm bushing replaced',
  description: 'The owner heard a clunk over speed bumps.',
  content_locale: 'en',
  vehicle: { brand: en('BMW'), model: en('3 Series'), series: en('E90') },
  service_system: en('Suspension'),
  service_task: null,
  tags: [],
  job_date: '2026-10-12',
  caption: null,
  media: [media({ role: 'before', url: 'https://media.example/before.jpg', display_order: 0 }), media({ display_order: 1 })],
  like_count: 0,
  published_at: '2026-10-13T08:00:00Z',
  ...o,
});

export const part = (o: Partial<PublicInventoryItem> = {}): PublicInventoryItem => ({
  id: '01a17000-0000-7000-8000-0000000000f1',
  name: en('Front control arm'),
  part_origin: 'aftermarket',
  condition: 'new',
  part_category: en('Control arms'),
  price: { amount: '45', currency: 'USD' },
  price_on_request: false,
  stock_status: 'in_stock',
  fitment_confidence_for_vehicle: null,
  image_url: null,
  vendor: card({
    id: '01a17000-0000-7000-8000-00000000000c',
    slug: 'mina-parts',
    name: 'Mina Parts',
    organization_type: 'vendor',
    roles: ['vendor'],
  }),
  description: null,
  brand: 'Lemförder',
  oem_numbers: ['31126769717'],
  aftermarket_numbers: [],
  position: ['front'],
  warranty_note: '6 months',
  location: { location_id: 'l1', point: { lat: 35.7, lng: 51.4 }, visibility: 'exact', service_radius_km: null, city: 'Tehran' },
  media: [],
  fitment: [
    { brand: en('BMW'), model: en('3 Series'), series: en('E90'), year_start: 2005, year_end: 2012, engine: null, confidence: 'confirmed' },
    { brand: en('BMW'), model: en('1 Series'), series: null, year_start: null, year_end: null, engine: null, confidence: 'likely' },
  ],
  is_trade_price: false,
  ...o,
});
