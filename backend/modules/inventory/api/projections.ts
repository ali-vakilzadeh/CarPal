// Response projections of the inventory module (40 §13.1), by allowlist.
// InventoryItem (with price_trade and internal notes) is the vendor members'
// view only; requesters see an inquiry's item as { id, name, sku } and the
// public projections live in infrastructure/inventory-read.ts (SEC-OUT-1).
// Optional members of the *Write types are omitted when null or empty.
import type { Selectable } from 'kysely';
import type { DB } from '#libs/db/index.js';
import { iso, isoOrNull, meta } from '#libs/http-pipeline/index.js';
import type { L10n } from '#libs/i18n/index.js';
import type { MediaAttachmentView } from '#modules/media/interface/media.js';

export type ItemRow = Selectable<DB['inventory.inventory_items']>;
export type FitmentRow = Selectable<DB['inventory.inventory_fitment']>;
export type BatchRow = Selectable<DB['inventory.inventory_import_batches']>;
export type TradeRow = Selectable<DB['inventory.vendor_trade_accounts']>;
export type InquiryRow = Selectable<DB['inventory.stock_inquiries']>;
export type MessageRow = Selectable<DB['inventory.inquiry_messages']>;

function optional<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Partial<Record<K, NonNullable<T[K]>>> {
  const out: Partial<Record<K, NonNullable<T[K]>>> = {};
  for (const k of keys) if (row[k] !== null && row[k] !== undefined) out[k] = row[k] as NonNullable<T[K]>;
  return out;
}

const nonEmpty = <K extends string>(key: K, list: string[] | null | undefined): Partial<Record<K, string[]>> =>
  list && list.length ? ({ [key]: list } as Record<K, string[]>) : {};

type Translations = Record<string, string>;

/** 40 InventoryItem (vendor members). */
export function toInventoryItem(i: ItemRow, d: { media: MediaAttachmentView[]; fitmentCount: number }) {
  return {
    ...meta(i),
    sku: i.sku,
    name_translations: i.name_translations as Translations,
    ...(i.description_translations ? { description_translations: i.description_translations as Translations } : {}),
    ...optional(i, [
      'brand',
      'price_public',
      'price_trade',
      'currency',
      'stock_quantity',
      'location_id',
      'warranty_note',
      'notes',
    ] as const),
    ...nonEmpty('oem_numbers', i.oem_numbers),
    ...nonEmpty('aftermarket_numbers', i.aftermarket_numbers),
    ...nonEmpty('position', i.position),
    part_origin: i.part_origin,
    condition: i.condition,
    part_category_node_id: i.part_category_node_id,
    price_on_request: i.price_on_request,
    stock_status: i.stock_status,
    visibility: i.visibility,
    vendor_organization_id: i.vendor_organization_id,
    normalized_name: i.normalized_name,
    data_quality_score: i.data_quality_score,
    duplicate_of_item_id: i.duplicate_of_item_id,
    import_batch_id: i.import_batch_id,
    status: i.status,
    fitment_count: d.fitmentCount,
    media: d.media.slice(0, 20),
  };
}

/** 40 Fitment. */
export function toFitment(f: FitmentRow) {
  return {
    ...meta(f),
    inventory_item_id: f.inventory_item_id,
    brand_node_id: f.brand_node_id,
    ...optional(f, [
      'model_node_id',
      'series_node_id',
      'year_start',
      'year_end',
      'engine_type_node_id',
      'fuel_type_node_id',
      'notes',
    ] as const),
    confidence: f.confidence,
    source: f.source,
    ai_insight_id: f.ai_insight_id,
    confirmed_by: f.confirmed_by,
    status: f.status,
  };
}

/** 40 InventoryImportBatch. */
export function toImportBatch(b: BatchRow) {
  return {
    ...meta(b),
    source_media_asset_id: b.source_media_asset_id,
    status: b.status,
    total_rows: b.total_rows,
    created_count: b.created_count,
    updated_count: b.updated_count,
    error_count: b.error_count,
    error_report_available: b.error_report_media_asset_id !== null,
    started_at: isoOrNull(b.started_at),
    finished_at: isoOrNull(b.finished_at),
  };
}

/** 40 TradeAccount (OrgSummary of both sides from organization OrgCards). */
export function toTradeAccount(t: TradeRow, vendor: unknown, customer: unknown) {
  return {
    ...meta(t),
    vendor,
    trade_customer: customer,
    status: t.status,
    approved_at: isoOrNull(t.approved_at),
    notes: t.notes,
  };
}

export interface VehicleSnapshot {
  brand: L10n;
  model: L10n;
  series: L10n | null;
  year: number;
  engine: L10n | null;
}

export interface InquiryDerived {
  item: { id: string; name: L10n; sku: string };
  vendor: unknown;
  requesterDisplay: string;
  /** Null unless the vendor_fitment_context consent is still granted (vendor side, SEC-AZ-8). */
  snapshot: VehicleSnapshot | null;
  lastMessageAt: Date | null;
  canReview: boolean;
}

/** 40 StockInquiry. */
export function toStockInquiry(q: InquiryRow, d: InquiryDerived) {
  return {
    ...meta(q),
    inventory_item: d.item,
    vendor: d.vendor,
    requester_type: q.requester_type,
    requester_display: d.requesterDisplay,
    vehicle_context_snapshot: d.snapshot,
    quantity: q.quantity,
    status: q.status,
    reserved_until: isoOrNull(q.reserved_until),
    first_response_at: isoOrNull(q.first_response_at),
    closed_at: isoOrNull(q.closed_at),
    closed_by_side: q.closed_by_side,
    last_message_at: isoOrNull(d.lastMessageAt),
    can_review: d.canReview,
  };
}

/** 40 InquiryMessage (authors shown by side: the vendor's name or the requester's display). */
export function toInquiryMessage(m: MessageRow, authorDisplay: string) {
  return {
    id: m.id,
    author_side: m.author_side,
    author_display: authorDisplay,
    body: m.body,
    content_locale: m.content_locale,
    created_at: iso(m.created_at),
  };
}
