// Rule-based query interpretation (54 §5.5; 52 MatchSession.interpreted_intent):
// the analyzed query tokens are matched against taxonomy names and synonyms
// (longest n-gram first, so "brake pads" beats "brake"), target-type
// keywords, stop words and region cities. What is left is free text (a shop
// name or words to match in names and descriptions). Works without AI.

export interface TermNode {
  nodeId: string;
  type: string;
}

export interface Interpretation {
  /** Matched nodes in query order, one per matched phrase. */
  nodes: { nodeId: string; type: string; phrase: string }[];
  targetHint: 'provider' | 'vendor' | null;
  cityKey: string | null;
  cityPhrase: string | null;
  /** Unmatched words (normalized), joined by spaces. */
  residual: string;
}

/** Node types used in search intent, most specific first when one phrase names several. */
const TYPE_PRIORITY = ['vehicle_series', 'vehicle_model', 'vehicle_brand', 'service_task', 'service_system', 'symptom', 'part_category'];

const PROVIDER_WORDS = new Set([
  'shop',
  'shops',
  'garage',
  'garages',
  'mechanic',
  'mechanics',
  'repair',
  'repairs',
  'service',
  'workshop',
  'workshops',
  'تعمیرگاه',
  'تعمیرگاه‌ها',
  'مکانیک',
  'مکانیکی',
  'تعمیر',
  'تعمیرات',
  'تعمیرکار',
  'سرویس',
]);
const VENDOR_WORDS = new Set([
  'part',
  'parts',
  'spare',
  'spares',
  'store',
  'seller',
  'sellers',
  'supplier',
  'suppliers',
  'buy',
  'قطعه',
  'قطعات',
  'لوازم',
  'یدکی',
  'فروشگاه',
  'فروشنده',
  'خرید',
]);
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'for',
  'my',
  'me',
  'near',
  'nearby',
  'in',
  'of',
  'and',
  'with',
  'to',
  'at',
  'on',
  'car',
  'cars',
  'vehicle',
  'need',
  'best',
  'good',
  'cheap',
  'fix',
  'is',
  'it',
  'i',
  'برای',
  'من',
  'نزدیک',
  'در',
  'و',
  'با',
  'به',
  'ماشین',
  'خودرو',
  'بهترین',
  'خوب',
  'ارزان',
  'از',
  'یک',
  'را',
  'ها',
  'های',
]);

/** Every n-gram (1-4 words) of the tokens: the terms looked up in the taxonomy projection. */
export function ngrams(tokens: readonly string[], max = 4): string[] {
  const out = new Set<string>();
  for (let n = 1; n <= max; n++) for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(' '));
  return [...out];
}

export function interpret(
  tokens: readonly string[],
  terms: ReadonlyMap<string, readonly TermNode[]>,
  cities: ReadonlyMap<string, string>,
): Interpretation {
  const used = tokens.map(() => false);
  const nodes: Interpretation['nodes'] = [];
  let cityKey: string | null = null;
  let cityPhrase: string | null = null;
  for (let n = Math.min(4, tokens.length); n >= 1; n--)
    for (let i = 0; i + n <= tokens.length; i++) {
      if (used.slice(i, i + n).some(Boolean)) continue;
      const phrase = tokens.slice(i, i + n).join(' ');
      const city = cities.get(phrase);
      if (city && !cityKey) {
        cityKey = city;
        cityPhrase = phrase;
        used.fill(true, i, i + n);
        continue;
      }
      const candidates = (terms.get(phrase) ?? []).filter((c) => TYPE_PRIORITY.includes(c.type));
      if (candidates.length === 0) continue;
      const best = [...candidates].sort((a, b) => TYPE_PRIORITY.indexOf(a.type) - TYPE_PRIORITY.indexOf(b.type))[0]!;
      // Single short words only match exactly-typed nodes once (stop words never do).
      if (n === 1 && STOP_WORDS.has(phrase)) continue;
      nodes.push({ nodeId: best.nodeId, type: best.type, phrase });
      used.fill(true, i, i + n);
    }
  let targetHint: Interpretation['targetHint'] = null;
  const residual: string[] = [];
  tokens.forEach((t, i) => {
    if (used[i]) return;
    if (PROVIDER_WORDS.has(t)) targetHint ??= 'provider';
    else if (VENDOR_WORDS.has(t)) targetHint = 'vendor';
    else if (!STOP_WORDS.has(t)) residual.push(t);
  });
  nodes.sort((a, b) => tokens.join(' ').indexOf(a.phrase) - tokens.join(' ').indexOf(b.phrase));
  return { nodes, targetHint, cityKey, cityPhrase, residual: residual.join(' ') };
}
