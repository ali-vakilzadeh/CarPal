// Rules of the taxonomy screens (AC12, Docs/23 A-TAX-01/02, Docs/40 §11 and §23.3, Docs/44 taxonomy catalog). The
// parent and attribute rules mirror the database trigger taxonomy.tg_node_rules (Docs/43): the server decides, the
// console only offers what would pass and says why. A node's labels are required in every enabled locale (Docs/40
// Translations: platform-curated = all enabled locales); the enabled set is what the server reports for the node
// (name_translations keys + missing_locales) together with the console's own languages (EN and FA).
import type { Mapping, StaffTaxonomyNode, Synonym, TaxonomyNode } from '@carpal/api-contracts';
import { LOCALES } from '@/lib/i18n/locales';

export const TAXONOMY_TYPES = [
  'vehicle_brand',
  'vehicle_model',
  'vehicle_series',
  'engine_type',
  'fuel_type',
  'service_system',
  'service_task',
  'part_category',
  'symptom',
  'review_tag',
  'amenity',
] as const;
export type TaxonomyType = (typeof TAXONOMY_TYPES)[number];

export function isTaxonomyType(v: string | null | undefined): v is TaxonomyType {
  return !!v && (TAXONOMY_TYPES as readonly string[]).includes(v);
}

export const NODE_STATUSES = ['active', 'inactive', 'deprecated', 'merged'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];
/** Statuses staff can set (merged only comes from a merge). */
export const EDITABLE_STATUSES = ['active', 'inactive', 'deprecated'] as const;

/** Parent types each type may have (taxonomy.tg_node_rules). Empty: never a parent. */
export const PARENT_TYPES: Readonly<Record<TaxonomyType, readonly TaxonomyType[]>> = {
  vehicle_brand: [],
  vehicle_model: ['vehicle_brand'],
  vehicle_series: ['vehicle_model'],
  engine_type: ['vehicle_brand', 'vehicle_model', 'vehicle_series'],
  fuel_type: [],
  service_system: [],
  service_task: ['service_system'],
  part_category: ['part_category'],
  symptom: ['symptom'],
  review_tag: [],
  amenity: [],
};

/** Types that cannot exist without a parent. */
export const NEEDS_PARENT: ReadonlySet<TaxonomyType> = new Set(['vehicle_model', 'vehicle_series', 'service_task']);

/** The child types "Add child" offers under a node of this type. */
export function childTypes(type: TaxonomyType): TaxonomyType[] {
  return TAXONOMY_TYPES.filter((t) => PARENT_TYPES[t].includes(type));
}

/** Attribute keys each type may carry (taxonomy.tg_node_rules); anything else is refused by the server. */
export const ATTRIBUTE_KEYS: Readonly<Record<TaxonomyType, readonly AttributeKey[]>> = {
  vehicle_brand: [],
  vehicle_model: [],
  vehicle_series: ['production_start_year', 'production_end_year'],
  engine_type: ['engine_code', 'displacement_cc', 'performance_variant'],
  fuel_type: ['powertrain'],
  service_system: [],
  service_task: [],
  part_category: ['position_applicable'],
  symptom: ['safety_critical'],
  review_tag: ['sentiment', 'applies_to'],
  amenity: [],
};

export type AttributeKey =
  | 'production_start_year'
  | 'production_end_year'
  | 'engine_code'
  | 'displacement_cc'
  | 'performance_variant'
  | 'powertrain'
  | 'safety_critical'
  | 'sentiment'
  | 'applies_to'
  | 'position_applicable';

export type AttributeKind =
  | { kind: 'int'; min: number; max: number }
  | { kind: 'text'; max: number }
  | { kind: 'bool' }
  | { kind: 'enum'; values: readonly string[] };

/** Docs/40 NodeAttributes. */
export const ATTRIBUTE_KIND: Readonly<Record<AttributeKey, AttributeKind>> = {
  production_start_year: { kind: 'int', min: 1900, max: 2100 },
  production_end_year: { kind: 'int', min: 1900, max: 2100 },
  engine_code: { kind: 'text', max: 40 },
  displacement_cc: { kind: 'int', min: 50, max: 20000 },
  performance_variant: { kind: 'bool' },
  powertrain: { kind: 'enum', values: ['petrol', 'diesel', 'hybrid', 'plug_in_hybrid', 'electric'] },
  safety_critical: { kind: 'bool' },
  sentiment: { kind: 'enum', values: ['positive', 'neutral', 'negative'] },
  applies_to: { kind: 'enum', values: ['provider', 'vendor', 'both'] },
  position_applicable: { kind: 'bool' },
};

/** Mapping types and the node types at each end (Docs/44 mapping_types). */
export const MAPPING_TYPES = [
  { type: 'symptom_to_system', source: 'symptom', target: 'service_system' },
  { type: 'symptom_to_task', source: 'symptom', target: 'service_task' },
  { type: 'part_category_to_system', source: 'part_category', target: 'service_system' },
  { type: 'task_to_part_category', source: 'service_task', target: 'part_category' },
] as const satisfies readonly { type: Mapping['mapping_type']; source: TaxonomyType; target: TaxonomyType }[];
export type MappingType = (typeof MAPPING_TYPES)[number]['type'];

/** The mapping types a node takes part in, and on which end. */
export function mappingRoles(type: TaxonomyType): { type: MappingType; end: 'source' | 'target'; other: TaxonomyType }[] {
  const out: { type: MappingType; end: 'source' | 'target'; other: TaxonomyType }[] = [];
  for (const m of MAPPING_TYPES) {
    if (m.source === type) out.push({ type: m.type, end: 'source', other: m.target });
    if (m.target === type) out.push({ type: m.type, end: 'target', other: m.source });
  }
  return out;
}

export const SYNONYM_TYPES = ['synonym', 'alias', 'misspelling', 'local_term', 'abbreviation', 'transliteration'] as const;
export type SynonymType = Synonym['synonym_type'];
export const SYNONYM_STATUSES = ['pending_review', 'active', 'inactive'] as const;

export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
export const LABEL_MAX = 120;
export const DESCRIPTION_MAX = 500;
export const TERM_MAX = 120;

/** The locales a node's labels must cover: the server's view of the node plus the console's languages. */
export function enabledLocales(node?: Pick<StaffTaxonomyNode, 'name_translations' | 'missing_locales'> | null): string[] {
  const set = new Set<string>(LOCALES);
  if (node) {
    for (const l of Object.keys(node.name_translations ?? {})) set.add(l);
    for (const l of node.missing_locales ?? []) set.add(l);
  }
  // English first, then Persian, then any other enabled locale.
  const order = (l: string) => (l === 'en' ? 0 : l === 'fa' ? 1 : 2);
  return [...set].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
}

/** The label to show in a language, falling back to English, then any label, then the slug. */
export function labelOf(node: Pick<StaffTaxonomyNode, 'name_translations' | 'slug'>, locale: string): string {
  const t: Record<string, string | undefined> = node.name_translations ?? {};
  return t[locale] || t.en || Object.values(t).find(Boolean) || node.slug;
}

/** Letter forms and digits folded so Persian, Arabic-keyboard and Latin search terms meet. */
export function normalizeSearch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064a\u0649]/g, '\u06cc') // Arabic yeh and alef maksura to Persian yeh
    .replace(/\u0643/g, '\u06a9') // Arabic kaf to Persian keheh
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u200c\u200f]/g, '') // ZWNJ, RLM
    .replace(/\p{Mn}/gu, '') // harakat and other combining marks
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the query occurs in any label (any locale) or the slug. */
export function nodeMatches(node: Pick<StaffTaxonomyNode, 'name_translations' | 'slug'>, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  return [node.slug, ...Object.values(node.name_translations ?? {})].some((v) => normalizeSearch(String(v)).includes(q));
}

export interface TreeIndex {
  byId: Map<string, StaffTaxonomyNode>;
  /** Children within the loaded type, ordered by sort_order then label. */
  children: Map<string | null, StaffTaxonomyNode[]>;
}

/**
 * The tree of one type. A node whose parent is of another type (a model under a brand) or not loaded is a root here.
 */
export function buildTree(nodes: readonly StaffTaxonomyNode[], locale: string): TreeIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string | null, StaffTaxonomyNode[]>();
  for (const n of nodes) {
    const key = n.parent_id && byId.has(n.parent_id) ? n.parent_id : null;
    const list = children.get(key) ?? [];
    list.push(n);
    children.set(key, list);
  }
  for (const list of children.values())
    list.sort((a, b) => a.sort_order - b.sort_order || labelOf(a, locale).localeCompare(labelOf(b, locale), locale));
  return { byId, children };
}

/** Every node below `id` within the loaded type. */
export function descendants(index: TreeIndex, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    for (const c of index.children.get(stack.pop()!) ?? []) {
      if (out.has(c.id)) continue;
      out.add(c.id);
      stack.push(c.id);
    }
  }
  return out;
}

/** Nodes a node may be merged into: same type, not itself, not merged, not below it (the server checks again). */
export function mergeTargets(index: TreeIndex, source: StaffTaxonomyNode): StaffTaxonomyNode[] {
  const below = descendants(index, source.id);
  return [...index.byId.values()].filter((n) => n.id !== source.id && n.type === source.type && n.status !== 'merged' && !below.has(n.id));
}

/** Why a node cannot be merged at all (null = it can). */
export function mergeBlocked(node: Pick<TaxonomyNode, 'status'>): 'merged' | null {
  return node.status === 'merged' ? 'merged' : null;
}

export interface NodeDraft {
  type: TaxonomyType;
  parentId: string | null;
  names: Record<string, string>;
  descriptions: Record<string, string>;
  slug: string;
  regions: string;
  sortOrder: string;
  status: (typeof EDITABLE_STATUSES)[number];
  attributes: Partial<Record<AttributeKey, string>>;
}

export type DraftProblem =
  | { field: 'name'; locale: string; problem: 'missing' | 'too_long' }
  | { field: 'description'; locale: string; problem: 'too_long' }
  | { field: 'slug' | 'parent' | 'regions' | 'sortOrder'; problem: string }
  | { field: 'attribute'; key: AttributeKey; problem: 'invalid' };

export function emptyDraft(type: TaxonomyType, parentId: string | null): NodeDraft {
  return { type, parentId, names: {}, descriptions: {}, slug: '', regions: '', sortOrder: '', status: 'active', attributes: {} };
}

export function draftOf(n: StaffTaxonomyNode): NodeDraft {
  const attrs: Partial<Record<AttributeKey, string>> = {};
  for (const [k, v] of Object.entries(n.attributes ?? {})) if (v !== undefined && v !== null) attrs[k as AttributeKey] = String(v);
  return {
    type: n.type as TaxonomyType,
    parentId: n.parent_id,
    names: { ...(n.name_translations ?? {}) },
    descriptions: { ...(n.description_translations ?? {}) },
    slug: n.slug,
    regions: (n.regions ?? []).join(', '),
    sortOrder: String(n.sort_order),
    status: n.status === 'merged' ? 'active' : (n.status as NodeDraft['status']),
    attributes: attrs,
  };
}

const COUNTRY = /^[A-Z]{2}$/;

export function parseRegions(text: string): string[] | null {
  const list = text
    .split(/[\s,\u060c]+/) // spaces, commas, Persian commas
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return list.every((c) => COUNTRY.test(c)) ? [...new Set(list)] : null;
}

function attributeValue(key: AttributeKey, raw: string): unknown {
  const kind = ATTRIBUTE_KIND[key];
  const v = raw.trim();
  if (kind.kind === 'int') {
    const n = Number(v);
    return Number.isInteger(n) && n >= kind.min && n <= kind.max ? n : undefined;
  }
  if (kind.kind === 'bool') return v === 'true' ? true : v === 'false' ? false : undefined;
  if (kind.kind === 'enum') return kind.values.includes(v) ? v : undefined;
  return v.length >= 1 && v.length <= kind.max ? v : undefined;
}

/** What is missing or wrong (empty = ready to send). Labels are required in every enabled locale. */
export function checkDraft(d: NodeDraft, locales: readonly string[]): DraftProblem[] {
  const out: DraftProblem[] = [];
  for (const l of locales) {
    const v = (d.names[l] ?? '').trim();
    if (!v) out.push({ field: 'name', locale: l, problem: 'missing' });
    else if (v.length > LABEL_MAX) out.push({ field: 'name', locale: l, problem: 'too_long' });
    if ((d.descriptions[l] ?? '').trim().length > DESCRIPTION_MAX) out.push({ field: 'description', locale: l, problem: 'too_long' });
  }
  if (!SLUG.test(d.slug)) out.push({ field: 'slug', problem: 'pattern' });
  if (NEEDS_PARENT.has(d.type) && !d.parentId) out.push({ field: 'parent', problem: 'required' });
  if (d.regions.trim() && !parseRegions(d.regions)) out.push({ field: 'regions', problem: 'pattern' });
  if (d.sortOrder.trim()) {
    const n = Number(d.sortOrder);
    if (!Number.isInteger(n) || n < 0 || n > 100000) out.push({ field: 'sortOrder', problem: 'range' });
  }
  for (const key of ATTRIBUTE_KEYS[d.type]) {
    const raw = d.attributes[key];
    if (raw !== undefined && raw.trim() !== '' && attributeValue(key, raw) === undefined)
      out.push({ field: 'attribute', key, problem: 'invalid' });
  }
  return out;
}

/** A label in "Title Case" turned into a slug suggestion (Latin letters and digits only). */
export function suggestSlug(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

function translations(map: Record<string, string>, locales: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of locales) {
    const v = (map[l] ?? '').trim();
    if (v) out[l] = v;
  }
  return out;
}

function attributesOf(d: NodeDraft): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const key of ATTRIBUTE_KEYS[d.type]) {
    const raw = d.attributes[key];
    if (raw === undefined || raw.trim() === '') continue;
    out[key] = attributeValue(key, raw);
  }
  return Object.keys(out).length ? out : undefined;
}

/** The body of admin.taxonomy_node_create. */
export function createBody(d: NodeDraft, locales: readonly string[], reason: string) {
  const descriptions = translations(d.descriptions, locales);
  const regions = parseRegions(d.regions) ?? [];
  const attributes = attributesOf(d);
  return {
    type: d.type,
    ...(d.parentId ? { parent_id: d.parentId } : {}),
    name_translations: translations(d.names, locales),
    ...(Object.keys(descriptions).length ? { description_translations: descriptions } : {}),
    slug: d.slug,
    ...(regions.length ? { regions } : {}),
    ...(attributes ? { attributes } : {}),
    ...(d.sortOrder.trim() ? { sort_order: Number(d.sortOrder) } : {}),
    status: d.status,
    reason,
  };
}

/**
 * The body of admin.taxonomy_node_update: the full label map every time (the server checks every enabled locale),
 * and the other fields as they are in the form.
 */
export function updateBody(d: NodeDraft, locales: readonly string[], reason: string) {
  const { type: _type, ...rest } = createBody(d, locales, reason);
  return {
    ...rest,
    regions: parseRegions(d.regions) ?? [],
    attributes: attributesOf(d) ?? {},
    sort_order: d.sortOrder.trim() ? Number(d.sortOrder) : 0,
  };
}

/** Nodes whose labels miss an enabled locale. */
export function missingTranslations(nodes: readonly StaffTaxonomyNode[]): StaffTaxonomyNode[] {
  return nodes.filter((n) => (n.missing_locales ?? []).length > 0);
}

export interface SynonymDraft {
  term: string;
  locale: string;
  type: SynonymType | '';
  script: 'native' | 'latin' | '';
}

export function checkSynonym(d: SynonymDraft): { term?: 'missing' | 'too_long'; type?: 'missing'; script?: 'missing' } {
  const p: { term?: 'missing' | 'too_long'; type?: 'missing'; script?: 'missing' } = {};
  const term = d.term.trim();
  if (!term) p.term = 'missing';
  else if (term.length > TERM_MAX) p.term = 'too_long';
  if (!d.type) p.type = 'missing';
  if (d.type === 'transliteration' && !d.script) p.script = 'missing';
  return p;
}

export function synonymBody(d: SynonymDraft, reason: string) {
  return {
    term: d.term.trim(),
    locale: d.locale as 'en' | 'fa',
    synonym_type: d.type as SynonymType,
    ...(d.script ? { script: d.script } : {}),
    reason,
  };
}

/** Weight of a mapping: an integer 0-100. */
export function parseWeight(text: string): number | null {
  const n = Number(text.trim());
  return text.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
}

/** Zero-result rate of the search_and_map dashboard (null without searches). */
export function zeroResultRate(started: number, zero: number): number | null {
  return started > 0 ? Math.min(1, zero / started) : null;
}
