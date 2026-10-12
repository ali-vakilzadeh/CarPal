// CSV import rows (40 inventory.import_create, ImportCreate.column_mapping):
// each mapped column fills one field of 40 InventoryItemWrite. Cells are
// data only (SEC-IN-11): text stays text, numbers and booleans must parse
// strictly, lists are separated by "|" or ";". Empty cells are absent
// fields. The built item is then validated like an API body.
import type { FieldErrorCode } from '#libs/contract/index.js';

/** 52 defaults for a new item when the file does not say (price_on_request false, visibility public). */
export const NEW_ITEM_DEFAULTS = { price_on_request: false, visibility: 'public' } as const;

/** Fields a column may be mapped to (InventoryItemWrite; translations per locale). */
export const IMPORT_FIELDS = [
  'sku',
  'name_translations.en',
  'name_translations.fa',
  'description_translations.en',
  'description_translations.fa',
  'brand',
  'oem_numbers',
  'aftermarket_numbers',
  'part_origin',
  'condition',
  'part_category_node_id',
  'position',
  'price_public',
  'price_trade',
  'price_on_request',
  'currency',
  'stock_quantity',
  'stock_status',
  'location_id',
  'warranty_note',
  'notes',
  'visibility',
  'status',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const isImportField = (f: string): f is ImportField => (IMPORT_FIELDS as readonly string[]).includes(f);

const LISTS: ImportField[] = ['oem_numbers', 'aftermarket_numbers', 'position'];
const BOOLEANS: ImportField[] = ['price_on_request'];
const INTEGERS: ImportField[] = ['stock_quantity'];
const LOWER: ImportField[] = ['part_origin', 'condition', 'stock_status', 'visibility', 'status'];

export interface RowProblem {
  /** JSON pointer in InventoryItemWrite terms ("/" for the row itself). */
  pointer: string;
  code: FieldErrorCode;
}

export interface MappedColumn {
  /** Index of the CSV column. */
  index: number;
  field: ImportField;
}

const TRUE = ['true', 'yes', 'y', '1'];
const FALSE = ['false', 'no', 'n', '0'];

/**
 * Builds an InventoryItemWrite candidate from one record. `normalize`
 * applies the API's text normalization (SEC-IN-4) and reports rejected
 * characters. Unmapped and empty cells stay absent, so an update row
 * changes only what it names.
 */
export function rowToItem(
  cells: readonly string[],
  columns: readonly MappedColumn[],
  headerLength: number,
  normalize: (v: string) => { value: string; ok: boolean },
): { item: Record<string, unknown>; problems: RowProblem[] } {
  const item: Record<string, unknown> = {};
  const problems: RowProblem[] = [];
  if (cells.length !== headerLength) return { item, problems: [{ pointer: '/', code: 'pattern' }] };
  for (const c of columns) {
    const n = normalize(cells[c.index] ?? '');
    const [field, locale] = c.field.split('.') as [string, string | undefined];
    const pointer = locale ? `/${field}/${locale}` : `/${field}`;
    if (!n.ok) {
      problems.push({ pointer, code: 'forbidden_character' });
      continue;
    }
    const raw = n.value;
    if (raw === '') continue;
    if (locale) {
      item[field] = { ...((item[field] as Record<string, string> | undefined) ?? {}), [locale]: raw };
    } else if (LISTS.includes(c.field)) {
      const parts = raw
        .split(/[|;]/)
        .map((x) => x.trim())
        .filter(Boolean);
      item[field] = c.field === 'position' ? parts.map((p) => p.toLowerCase()) : parts;
    } else if (BOOLEANS.includes(c.field)) {
      const v = raw.toLowerCase();
      if (TRUE.includes(v)) item[field] = true;
      else if (FALSE.includes(v)) item[field] = false;
      else problems.push({ pointer, code: 'type' });
    } else if (INTEGERS.includes(c.field)) {
      if (/^\d{1,9}$/.test(raw)) item[field] = Number(raw);
      else problems.push({ pointer, code: 'type' });
    } else if (c.field === 'currency') {
      item[field] = raw.toUpperCase();
    } else if (LOWER.includes(c.field)) {
      item[field] = raw.toLowerCase();
    } else {
      item[field] = raw;
    }
  }
  return { item, problems };
}
