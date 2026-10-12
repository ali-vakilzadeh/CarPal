// The safety keyword list of Docs/44 `safety_check.keywords` (52 §7, MVP
// §7.2A): words that flag a text as safety-relevant in addition to the names
// and synonyms of safety-critical symptom nodes. Runtime code cannot read
// Docs/, so the list is mirrored here; safety-keywords.test.ts fails when it
// drifts from the catalog. Symptom references are catalog keys (type:slug).

export interface SafetyKeyword {
  term: string;
  locale: 'en' | 'fa';
  script: 'native' | 'latin' | null;
  /** Catalog key of the symptom node, e.g. "symptom:brake-problem". */
  symptom: string;
}

export const SAFETY_KEYWORDS: readonly SafetyKeyword[] = [
  { term: 'brakes', locale: 'en', script: null, symptom: 'symptom:brake-problem' },
  { term: 'brake failure', locale: 'en', script: null, symptom: 'symptom:brake-problem' },
  { term: 'steering', locale: 'en', script: null, symptom: 'symptom:steering-problem' },
  { term: 'smoke', locale: 'en', script: null, symptom: 'symptom:smoke' },
  { term: 'burning smell', locale: 'en', script: null, symptom: 'symptom:burning-smell' },
  { term: 'airbag', locale: 'en', script: null, symptom: 'symptom:airbag-warning' },
  { term: 'overheating', locale: 'en', script: null, symptom: 'symptom:overheating' },
  { term: 'loss of power', locale: 'en', script: null, symptom: 'symptom:loss-of-power' },
  { term: 'ترمز', locale: 'fa', script: 'native', symptom: 'symptom:brake-problem' },
  { term: 'فرمان', locale: 'fa', script: 'native', symptom: 'symptom:steering-problem' },
  { term: 'دود', locale: 'fa', script: 'native', symptom: 'symptom:smoke' },
  { term: 'بوی سوختگی', locale: 'fa', script: 'native', symptom: 'symptom:burning-smell' },
  { term: 'کیسه هوا', locale: 'fa', script: 'native', symptom: 'symptom:airbag-warning' },
  { term: 'ایربگ', locale: 'fa', script: 'native', symptom: 'symptom:airbag-warning' },
  { term: 'جوش آورده', locale: 'fa', script: 'native', symptom: 'symptom:overheating' },
  { term: 'جوش آوردن', locale: 'fa', script: 'native', symptom: 'symptom:overheating' },
  { term: 'افت قدرت', locale: 'fa', script: 'native', symptom: 'symptom:loss-of-power' },
  { term: 'tormoz', locale: 'fa', script: 'latin', symptom: 'symptom:brake-problem' },
  { term: 'farman', locale: 'fa', script: 'latin', symptom: 'symptom:steering-problem' },
  { term: 'dood', locale: 'fa', script: 'latin', symptom: 'symptom:smoke' },
  { term: 'sookhtegi', locale: 'fa', script: 'latin', symptom: 'symptom:burning-smell' },
  { term: 'joosh', locale: 'fa', script: 'latin', symptom: 'symptom:overheating' },
];
