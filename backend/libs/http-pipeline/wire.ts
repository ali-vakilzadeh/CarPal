// Wire mapping helpers (40 §3.2, §3.4) for response projections: DateTime is
// RFC 3339 UTC with `Z`, `Meta` is { id, created_at, updated_at, version }.
// Projections are allowlists: modules build every response field by name.

export const iso = (d: Date | string): string => new Date(d).toISOString();

export const isoOrNull = (d: Date | string | null | undefined): string | null => (d == null ? null : iso(d));

export interface MetaRow {
  id: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

/** 40 §3.2 Meta of a stored row. */
export const meta = (row: MetaRow): { id: string; created_at: string; updated_at: string; version: number } => ({
  id: row.id,
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
  version: row.version,
});

export const ACK = { ok: true } as const;
