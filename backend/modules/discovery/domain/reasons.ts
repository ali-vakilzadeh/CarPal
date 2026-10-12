// Reason summaries and template explanations (52 MatchResult: the template
// explanation is used when AI is unavailable). Rendered per reader locale
// from the stored structured reasons; taxonomy names come in as labels.
import type { L10n, Locale } from '#libs/i18n/index.js';
import type { Reason } from './ranking.js';

type Labels = ReadonlyMap<string, L10n>;

const T = {
  en: {
    level: ['Offers', 'Has verified work in', 'Experienced in', 'Specialist in', 'Expert in'],
    for: 'for',
    jobs: (n: number) => `${n} verified ${n === 1 ? 'job' : 'jobs'}`,
    covered: (b: string) => `Works on ${b}`,
    items: (n: number) => `${n} matching ${n === 1 ? 'part' : 'parts'}`,
    fits: (c: string) => `Fitment ${c} for your car`,
    rating: (r: string, n: number) => `Rated ${r} from ${n} ${n === 1 ? 'review' : 'reviews'}`,
    verified: 'Verified business',
    badge: (b: string) => `Badge: ${b.replace(/_/g, ' ')}`,
    distance: (d: string) => `${d} km away`,
    nearby: 'Near you',
    response: (m: number) => (m < 60 ? `Usually responds within ${m} min` : `Usually responds within ${Math.round(m / 60)} h`),
    target: (t: string) => `Response target: ${t.replace(/_/g, ' ')}`,
    inStock: (n: number) => `${n} in stock`,
    stock: (s: string) => s.replace(/_/g, ' '),
    urgent: 'Suited to urgent requests',
    favorite: 'In your favourites',
    services: 'services',
  },
  fa: {
    level: ['ارائه‌دهنده', 'دارای کار تأییدشده در', 'باتجربه در', 'متخصص', 'کارشناس برجسته'],
    for: 'برای',
    jobs: (n: number) => `${n} کار تأییدشده`,
    covered: (b: string) => `روی ${b} کار می‌کند`,
    items: (n: number) => `${n} قطعه منطبق`,
    fits: (c: string) => `تطابق ${c} با خودروی شما`,
    rating: (r: string, n: number) => `امتیاز ${r} از ${n} نظر`,
    verified: 'کسب‌وکار تأییدشده',
    badge: (b: string) => `نشان: ${b.replace(/_/g, ' ')}`,
    distance: (d: string) => `${d} کیلومتر فاصله`,
    nearby: 'نزدیک شما',
    response: (m: number) => (m < 60 ? `معمولاً ظرف ${m} دقیقه پاسخ می‌دهد` : `معمولاً ظرف ${Math.round(m / 60)} ساعت پاسخ می‌دهد`),
    target: (t: string) => `هدف پاسخ‌گویی: ${t.replace(/_/g, ' ')}`,
    inStock: (n: number) => `${n} عدد موجود`,
    stock: (s: string) => s.replace(/_/g, ' '),
    urgent: 'مناسب درخواست‌های فوری',
    favorite: 'در علاقه‌مندی‌های شما',
    services: 'خدمات',
  },
};

const label = (labels: Labels, id: unknown): string | null => (typeof id === 'string' ? (labels.get(id)?.text ?? null) : null);

/** One reason's summary in the reader's locale. */
export function reasonSummary(r: Reason, locale: Locale, labels: Labels): L10n {
  const t = T[locale];
  const v = r.values;
  let text: string;
  switch (r.reason_type) {
    case 'capability_evidence': {
      if (typeof v.matching_items === 'number') {
        text = t.items(v.matching_items);
        if (v.fitment_confidence) text += ` · ${t.fits(String(v.fitment_confidence))}`;
      } else if (v.fitment_confidence) text = t.fits(String(v.fitment_confidence));
      else if (v.covered) text = t.covered(label(labels, v.brand_node_id) ?? '');
      else {
        const what = label(labels, v.task_node_id) ?? label(labels, v.system_node_id) ?? t.services;
        const brand = label(labels, v.brand_node_id);
        text = `${t.level[Number(v.level) || 0]} ${what}${brand ? ` ${t.for} ${brand}` : ''}`;
        if (typeof v.jobs === 'number' && v.jobs > 0) text += ` · ${t.jobs(v.jobs)}`;
      }
      break;
    }
    case 'rating_evidence':
      text = t.rating(String(v.avg_rating), Number(v.reviews) || 0);
      break;
    case 'trust_signal':
      text = v.verified ? t.verified : t.badge(String(v.badge ?? ''));
      break;
    case 'location':
      text = v.distance_km === null || v.distance_km === undefined ? t.nearby : t.distance(String(v.distance_km));
      break;
    case 'availability':
      text =
        typeof v.in_stock_items === 'number'
          ? t.inStock(v.in_stock_items)
          : typeof v.stock_status === 'string'
            ? t.stock(v.stock_status)
            : typeof v.response_minutes === 'number'
              ? t.response(v.response_minutes)
              : t.target(String(v.response_target ?? ''));
      break;
    case 'urgency_fit':
      text = t.urgent;
      break;
    case 'user_preference':
      text = t.favorite;
      break;
    default:
      text = t.nearby;
  }
  return { text: text.trim().slice(0, 300), locale };
}

/** Template explanation (52 MatchResult.explanation_text, source template): the leading reasons joined. */
export function templateExplanation(reasons: readonly Reason[], locale: Locale, labels: Labels): string {
  return reasons
    .slice(0, 3)
    .map((r) => reasonSummary(r, locale, labels).text)
    .join(locale === 'fa' ? '؛ ' : '; ')
    .slice(0, 1000);
}

/** Node ids referenced by reasons (for one label lookup). */
export const reasonNodeIds = (reasons: readonly Reason[]): string[] =>
  reasons
    .flatMap((r) => [r.values.system_node_id, r.values.task_node_id, r.values.brand_node_id])
    .filter((x): x is string => typeof x === 'string');

const TARGET_LABELS: Record<string, { en: string; fa: string }> = {
  provider: { en: 'Repair shops', fa: 'تعمیرگاه‌ها' },
  vendor: { en: 'Parts sellers', fa: 'فروشندگان قطعه' },
  inventory_item: { en: 'Parts', fa: 'قطعات' },
  place: { en: 'Shops and parts sellers', fa: 'تعمیرگاه‌ها و فروشندگان' },
};

export const targetLabel = (target: string, locale: Locale): L10n => ({ text: TARGET_LABELS[target]?.[locale] ?? target, locale });
