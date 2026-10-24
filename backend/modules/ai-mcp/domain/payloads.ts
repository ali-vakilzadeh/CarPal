// Server-defined structured payloads (40 Json<InsightPayload>,
// Json<SuggestionPayload>; SEC-AI-5): every tool output is checked against
// the schema of its insight type before storage, and malformed output is
// discarded and logged. Payloads hold ids, enums, numbers and short plain
// text only (SEC-IN-5); nothing here is ever rendered as markup.
import { z } from 'zod';
import type { InsightType } from '#libs/contract/generated/enums.js';
import { ID_PATTERN } from '#libs/crypto/index.js';

const id = z.string().regex(ID_PATTERN);
const text = (max: number) => z.string().min(1).max(max);
const urgency = z.enum(['low', 'medium', 'high', 'safety_critical']);
const year = z.number().int().min(1950).max(2100);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const reminderType = z.enum(['oil', 'brakes', 'tires', 'battery', 'inspection', 'seasonal', 'custom']);

/** Relative rectangle of an image (0..1, as 40 RedactionDecision.regions). */
const region = z.strictObject({
  kind: z.enum(['license_plate', 'face', 'personal_document', 'other']),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
});

const SCHEMAS: Partial<Record<InsightType, z.ZodType>> = {
  triage_summary: z.strictObject({
    symptom_node_ids: z.array(id).max(10),
    likely_system_node_ids: z.array(id).max(10),
    recommended_service_node_id: id.nullable(),
    urgency: urgency.nullable(),
    next_question: text(500).nullable(),
    do_not_drive: z.boolean(),
  }),
  vehicle_field_suggestion: z.strictObject({
    fields: z.array(z.strictObject({ field: z.enum(['series_node_id', 'engine_type_node_id', 'fuel_type_node_id']), node_id: id })).max(5),
  }),
  maintenance_suggestion: z.strictObject({
    checks: z
      .array(
        z.strictObject({ reminder_type: reminderType, title: text(120), reason: text(300), due_in_days: z.number().int().min(0).max(730) }),
      )
      .max(10),
  }),
  vehicle_summary: z.strictObject({ highlights: z.array(text(300)).max(10) }),
  service_history_summary: z.strictObject({
    record_count: z.number().int().min(0),
    last_service_date: date.nullable(),
    recurring_system_node_ids: z.array(id).max(10),
    duplicate_record_ids: z.array(id).max(50),
    next_maintenance: text(300).nullable(),
  }),
  capability_suggestion: z.strictObject({
    capabilities: z
      .array(
        z.strictObject({
          service_system_node_id: id,
          service_task_node_id: id.nullable(),
          brand_node_id: id.nullable(),
          experience_level: z.enum(['beginner', 'intermediate', 'advanced', 'specialist']),
          evidence_count: z.number().int().min(1),
        }),
      )
      .max(20),
    coverage: z.array(z.strictObject({ brand_node_id: id, model_node_id: id.nullable(), evidence_count: z.number().int().min(1) })).max(20),
    profile_gaps: z.array(z.enum(['description', 'logo', 'cover', 'opening_hours', 'service_categories', 'portfolio', 'coverage'])).max(7),
  }),
  review_response_draft: z.strictObject({ draft_text: text(2000), tone: z.enum(['formal', 'friendly', 'brief']) }),
  review_theme: z.strictObject({
    review_count: z.number().int().min(0),
    average_rating: z
      .string()
      .regex(/^\d(\.\d{1,2})?$/)
      .nullable(),
    themes: z
      .array(z.strictObject({ tag_key: text(60), count: z.number().int().min(1), sentiment: z.enum(['positive', 'neutral', 'negative']) }))
      .max(20),
    improvement_suggestions: z.array(text(300)).max(5),
  }),
  showcase_caption: z.strictObject({ caption: text(500), tags: z.array(text(40)).max(10), draft_post: text(2000) }),
  redaction_suggestion: z.strictObject({
    media: z.array(z.strictObject({ media_asset_id: id, regions: z.array(region).max(20) })).max(20),
  }),
  appointment_slot_suggestion: z.strictObject({
    suggested_duration_minutes: z.number().int().min(5).max(1440),
    longer_than_requested: z.boolean(),
    conflict_count: z.number().int().min(0),
    customer_need: text(1000),
  }),
  pre_visit_summary: z.strictObject({ summary: text(2000), focus_node_ids: z.array(id).max(10) }),
  inventory_normalization: z.strictObject({
    items: z
      .array(
        z.strictObject({
          item_id: id,
          normalized_name: text(200),
          part_category_node_id: id.nullable(),
          issues: z.array(z.enum(['missing_image', 'missing_warranty', 'possible_duplicate', 'name_changed', 'category_missing'])).max(5),
          duplicate_of_item_id: id.nullable(),
        }),
      )
      .max(500),
  }),
  fitment_suggestion: z.strictObject({
    rows: z
      .array(
        z.strictObject({
          brand_node_id: id,
          model_node_id: id.nullable(),
          year_start: year.nullable(),
          year_end: year.nullable(),
          confidence: z.enum(['likely', 'uncertain']),
        }),
      )
      .max(20),
  }),
  inventory_gap: z.strictObject({
    categories: z.array(z.strictObject({ part_category_node_id: id, demand_score: z.number().min(0).max(100) })).max(20),
  }),
  fleet_suggestion: z.strictObject({
    priorities: z.array(z.strictObject({ vehicle_id: id, reason: text(300), urgency })).max(100),
    preferred_provider_ids: z.array(id).max(10),
  }),
  skill_heatmap: z.strictObject({ entry_count: z.number().int().min(0), rule_version: text(20) }),
  fraud_flag: z.strictObject({
    review_ids: z.array(id).max(50),
    signals: z.array(z.enum(['burst_from_new_accounts', 'repeated_text', 'self_review_link', 'rating_spike'])).max(4),
  }),
};

/** Suggestion payloads (proposed_payload / edited_payload) per target type. */
const SUGGESTION_SCHEMAS: Record<string, z.ZodType> = {
  vehicle: z.strictObject({
    series_node_id: id.optional(),
    engine_type_node_id: id.optional(),
    fuel_type_node_id: id.optional(),
  }),
  maintenance_reminder: z.strictObject({
    reminder_type: reminderType,
    title: z.string().min(3).max(120),
    due_by_date: date,
    reason: text(500).nullable(),
  }),
  inventory_item: z.strictObject({ normalized_name: text(200).optional(), part_category_node_id: id.optional() }),
  organization: z.strictObject({
    profile_gap: z.enum(['description', 'logo', 'cover', 'opening_hours', 'service_categories', 'portfolio', 'coverage']),
  }),
};

/** The payload schemas by insight type and by suggestion target (40 Json<InsightPayload> / Json<SuggestionPayload>; OpenAPI components). */
export const INSIGHT_PAYLOAD_SCHEMAS: Readonly<Partial<Record<InsightType, z.ZodType>>> = SCHEMAS;
export const SUGGESTION_PAYLOAD_SCHEMAS: Readonly<Record<string, z.ZodType>> = SUGGESTION_SCHEMAS;

export function payloadSchema(type: InsightType): z.ZodType | undefined {
  return SCHEMAS[type];
}

/** SEC-AI-5: true when the payload matches its insight type (types without a schema accept null only). */
export function validInsightPayload(type: InsightType, payload: unknown): boolean {
  const schema = SCHEMAS[type];
  if (!schema) return payload === null;
  return schema.safeParse(payload).success;
}

/** Field errors of a suggestion payload (pointers under `base`), or [] when valid; unknown targets accept null only. */
export function suggestionPayloadErrors(targetType: string, payload: unknown, base: string): { pointer: string; code: string }[] {
  const schema = SUGGESTION_SCHEMAS[targetType];
  if (!schema) return payload === null || payload === undefined ? [] : [{ pointer: base, code: 'unexpected' }];
  const r = schema.safeParse(payload);
  if (r.success) return [];
  return r.error.issues.slice(0, 20).map((i) => ({
    pointer: `${base}${i.path.map((p) => `/${String(p)}`).join('')}`,
    code: i.code === 'unrecognized_keys' ? 'unexpected' : 'invalid',
  }));
}
