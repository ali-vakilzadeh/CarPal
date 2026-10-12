// Response projections of the taxonomy module (40 §11.1). Public vocabulary:
// one audience. Labels are resolved per Accept-Language (L10n, 52 §2.4).
import { l10n, type Locale } from '#libs/i18n/index.js';
import type { TaxonomyNodeRecord } from '../interface/taxonomy-resolver.js';

const NODE_ATTRIBUTES = [
  'production_start_year',
  'production_end_year',
  'engine_code',
  'displacement_cc',
  'performance_variant',
  'powertrain',
  'safety_critical',
  'sentiment',
  'applies_to',
  'position_applicable',
] as const;

/** 40 TaxonomyNode. */
export function toTaxonomyNode(n: TaxonomyNodeRecord, locale: Locale) {
  let attributes: Record<string, unknown> | null = null;
  if (n.attributes) {
    attributes = {};
    for (const k of NODE_ATTRIBUTES) if (n.attributes[k] !== undefined && n.attributes[k] !== null) attributes[k] = n.attributes[k];
    if (Object.keys(attributes).length === 0) attributes = null;
  }
  return {
    id: n.id,
    type: n.type,
    parent_id: n.parentId,
    name: l10n(n.nameTranslations, locale) ?? { text: n.slug, locale },
    description: l10n(n.descriptionTranslations, locale),
    slug: n.slug,
    regions: n.regions,
    attributes,
    sort_order: n.sortOrder,
    status: n.status,
    merged_into_id: n.mergedIntoId,
  };
}
