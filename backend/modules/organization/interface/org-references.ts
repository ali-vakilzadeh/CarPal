// Organization merge re-pointing (backend S22, admin console BR-08, DI-67;
// 40 admin.org_merge, admin.org_merge_preview). Every module that keeps
// references to an organization registers them here at startup with the rule
// a merge applies to them. The merge job (organization module, W7 worker)
// applies every registered reference in one transaction, so a failure leaves
// nothing re-pointed; the preview counts them in the caller's read-only staff
// transaction.
//
// Rules (40 OrgMergeRule):
//   move         every live row is re-pointed to the surviving organization
//   keep_target  rows are re-pointed, except those colliding with the target's
//                own (a unique key, or a row linking the two organizations):
//                the target's row stays, the merged organization's is retired
//   merge        rows are re-pointed and reconciled with the target's
//                (locations: the target keeps its primary and active ones)
//   retire       the merged organization's rows end where they are, nothing
//                moves (memberships, badges, the current subscription)
//   refuse       a live row blocks the merge until staff resolve it
//   history      records of what happened to the merged organization; they
//                stay with it and resolve through merged_into_organization_id
// A retired row is soft-deleted (deleted_at, deletion_reason) unless the
// reference names another way to end it (a status). Append-only logs (audit,
// outbox, analytics events, MCP access logs, jobs) are never registered.
import { sql, type RawBuilder } from 'kysely';
import type { TxScope } from '#libs/tenancy/index.js';

export type OrgMergeRule = 'move' | 'keep_target' | 'merge' | 'retire' | 'refuse' | 'history';

/** Live rows that reference the merged organization, and those that collide with the target's (or block, for refuse). */
export interface OrgReferenceCount {
  rows: number;
  conflicts: number;
}

/** What a merge did to one reference: rows re-pointed and rows retired. */
export interface OrgReferenceResult {
  moved: number;
  retired: number;
}

export interface OrgReference {
  /** Stable name, "<module>.<what>" (40 OrgMergeReference.reference). */
  key: string;
  rule: OrgMergeRule;
  count(scope: TxScope, fromId: string, intoId: string): Promise<OrgReferenceCount>;
  /** Applies the rule in the merge job's transaction (system context); absent for history and refuse. */
  apply?(scope: TxScope, fromId: string, intoId: string): Promise<OrgReferenceResult>;
}

export interface RegisteredReference {
  module: string;
  ref: OrgReference;
}

export class OrganizationReferences {
  readonly #refs = new Map<string, RegisteredReference>();

  register(module: string, refs: readonly OrgReference[]): void {
    for (const ref of refs) {
      if (!ref.key.startsWith(`${module}.`)) throw new Error(`organization reference ${ref.key} must start with ${module}.`);
      if (this.#refs.has(ref.key)) throw new Error(`organization reference ${ref.key} registered twice`);
      if (ref.rule !== 'history' && ref.rule !== 'refuse' && !ref.apply) throw new Error(`organization reference ${ref.key} cannot apply`);
      this.#refs.set(ref.key, { module, ref });
    }
  }

  /** Every reference, in module then key order (the preview's order and the job's). */
  entries(): RegisteredReference[] {
    return [...this.#refs.values()].sort((a, b) => a.module.localeCompare(b.module) || a.ref.key.localeCompare(b.ref.key));
  }
}

/** 40 OrgMergeReference: one registered reference with its rows and conflicts for a merge pair. */
export interface OrgMergeReferenceView {
  module: string;
  reference: string;
  rule: OrgMergeRule;
  count: number;
  conflicts: number;
}

/** Counts every registered reference for merging `fromId` into `intoId` (preview, approval and the job's own check). */
export async function previewReferences(
  scope: TxScope,
  refs: OrganizationReferences,
  fromId: string,
  intoId: string,
): Promise<OrgMergeReferenceView[]> {
  const out: OrgMergeReferenceView[] = [];
  for (const { module, ref } of refs.entries()) {
    const c = await ref.count(scope, fromId, intoId);
    out.push({ module, reference: ref.key, rule: ref.rule, count: c.rows, conflicts: c.conflicts });
  }
  return out;
}

/** The references that block a merge (refuse rule with live rows). */
export const refusals = (views: readonly OrgMergeReferenceView[]): string[] =>
  views.filter((v) => v.rule === 'refuse' && v.conflicts > 0).map((v) => v.reference);

// ------------------------------------------------------------------ helpers
// Table, column and predicate names below are constants of the registering module, never request input.

const num = (r: { numAffectedRows?: bigint; numUpdatedRows?: bigint }): number => Number(r.numAffectedRows ?? r.numUpdatedRows ?? 0);
const raw = (s: string): RawBuilder<unknown> => sql.raw(s);
/** A predicate written with `%` for the row's alias, e.g. "%.status = 'active'". */
const pred = (p: string | undefined, alias: string): string => (p ? ` AND (${p.replaceAll('%', alias)})` : '');

export interface RefTable {
  table: string;
  /** The organization column(s); a row is counted once per column that names the merged organization. */
  columns: readonly string[];
  /** Extra condition on live rows, with `%` for the row (e.g. "%.owner_type = 'organization'"). */
  where?: string;
  /** False for append-only tables without deleted_at. */
  softDeleted?: boolean;
}

function liveWhere(t: RefTable, column: string, alias: string): string {
  return `${alias}.${column} = $FROM${t.softDeleted === false ? '' : ` AND ${alias}.deleted_at IS NULL`}${pred(t.where, alias)}`;
}

async function exec(scope: TxScope, text: string, fromId: string, intoId: string): Promise<number> {
  // $FROM / $INTO are bound as parameters (the only values in these statements).
  const parts = text.split(/(\$FROM|\$INTO)/u);
  const chunks: RawBuilder<unknown>[] = parts.map((p) =>
    p === '$FROM' ? sql`${fromId}::uuid` : p === '$INTO' ? sql`${intoId}::uuid` : raw(p),
  );
  const r = await sql.join(chunks, sql``).execute(scope.db);
  if (/^\s*SELECT/iu.test(text)) return Number((r.rows[0] as { n?: string | number } | undefined)?.n ?? 0);
  return num(r);
}

/** Live rows of `t` naming the merged organization (summed over its columns). */
export async function countRefs(scope: TxScope, t: RefTable, fromId: string, intoId = fromId): Promise<number> {
  let n = 0;
  for (const c of t.columns) n += await exec(scope, `SELECT count(*) AS n FROM ${t.table} r WHERE ${liveWhere(t, c, 'r')}`, fromId, intoId);
  return n;
}

/** Re-points every live row of `t` (rule move). */
export async function moveRefs(scope: TxScope, t: RefTable, fromId: string, intoId: string): Promise<number> {
  let n = 0;
  for (const c of t.columns) n += await exec(scope, `UPDATE ${t.table} r SET ${c} = $INTO WHERE ${liveWhere(t, c, 'r')}`, fromId, intoId);
  return n;
}

/** A move reference over one table. */
export function moveRef(key: string, t: RefTable): OrgReference {
  return {
    key,
    rule: 'move',
    count: async (scope, from) => ({ rows: await countRefs(scope, t, from), conflicts: 0 }),
    apply: async (scope, from, into) => ({ moved: await moveRefs(scope, t, from, into), retired: 0 }),
  };
}

/** A history reference: counted for the preview, never changed. */
export function historyRef(key: string, t: RefTable): OrgReference {
  return { key, rule: 'history', count: async (scope, from) => ({ rows: await countRefs(scope, t, from), conflicts: 0 }) };
}

/** A refuse reference: its live rows block the merge. */
export function refuseRef(key: string, t: RefTable): OrgReference {
  return {
    key,
    rule: 'refuse',
    count: async (scope, from) => {
      const rows = await countRefs(scope, t, from);
      return { rows, conflicts: rows };
    },
  };
}

/** How a retired row ends: soft deletion by default, or a SET list (with `$INTO` for the target). */
const retireSet = (set: string | undefined): string =>
  set ?? `deleted_at = now(), deletion_reason = 'organization merged into ' || $INTO::text`;

/** A retire reference: the live rows (as `t.where` narrows them) end with `set` (or soft deletion); nothing moves. */
export function retireRef(key: string, t: RefTable, set?: string): OrgReference {
  return {
    key,
    rule: 'retire',
    count: async (scope, from) => ({ rows: await countRefs(scope, t, from), conflicts: 0 }),
    apply: async (scope, from, into) => {
      let n = 0;
      for (const c of t.columns)
        n += await exec(scope, `UPDATE ${t.table} r SET ${retireSet(set)} WHERE ${liveWhere(t, c, 'r')}`, from, into);
      return { moved: 0, retired: n };
    },
  };
}

export interface KeyedTable extends RefTable {
  /**
   * The other columns of the unique key the organization column belongs to; `'pair'`: the table's other organization
   * column (a unique key over the two organizations, e.g. vendor and trade customer).
   */
  key?: readonly string[] | 'pair';
  /** NULLS NOT DISTINCT keys compare with IS NOT DISTINCT FROM. */
  nullsNotDistinct?: boolean;
  /** The partial unique index predicate (rows outside it never collide), with `%` for the row. */
  unique?: string;
  /** The row's organization columns link two organizations: a row linking the merged and the surviving one collides. */
  pair?: boolean;
  /** How a colliding row of the merged organization ends (default: soft deletion). */
  retire?: string;
}

function collision(t: KeyedTable, column: string): string {
  const parts: string[] = [];
  const others = t.columns.filter((c) => c !== column);
  if (t.pair) for (const o of others) parts.push(`s.${o} = $INTO`);
  const key = t.key === 'pair' ? others : t.key;
  if (key?.length) {
    const eq = key.map((k) => (t.nullsNotDistinct ? `o.${k} IS NOT DISTINCT FROM s.${k}` : `o.${k} = s.${k}`)).join(' AND ');
    // A unique key is enforced on every row the index covers, soft-deleted ones too unless its predicate leaves them out.
    parts.push(
      `(TRUE${pred(t.unique, 's')} AND EXISTS (SELECT 1 FROM ${t.table} o WHERE o.${column} = $INTO${pred(t.unique, 'o')} AND ${eq}))`,
    );
  }
  return parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
}

/** Live rows colliding with the surviving organization's (keep_target conflicts). */
export async function keyedConflicts(scope: TxScope, t: KeyedTable, fromId: string, intoId: string): Promise<number> {
  let n = 0;
  for (const c of t.columns)
    n += await exec(scope, `SELECT count(*) AS n FROM ${t.table} s WHERE ${liveWhere(t, c, 's')} AND ${collision(t, c)}`, fromId, intoId);
  return n;
}

/** keep_target: colliding rows of the merged organization are retired, the others re-pointed. */
export function keyedRef(key: string, t: KeyedTable): OrgReference {
  return {
    key,
    rule: 'keep_target',
    count: async (scope, from, into) => ({ rows: await countRefs(scope, t, from), conflicts: await keyedConflicts(scope, t, from, into) }),
    apply: async (scope, from, into) => {
      let retired = 0;
      let moved = 0;
      for (const c of t.columns) {
        retired += await exec(
          scope,
          `UPDATE ${t.table} s SET ${retireSet(t.retire)} WHERE ${liveWhere(t, c, 's')} AND ${collision(t, c)}`,
          from,
          into,
        );
        moved += await exec(scope, `UPDATE ${t.table} r SET ${c} = $INTO WHERE ${liveWhere(t, c, 'r')}`, from, into);
      }
      return { moved, retired };
    },
  };
}

/**
 * keep_target for a one-row-per-organization extension (provider, vendor, fleet profile): moved when the target has
 * none, otherwise the merged organization's row is retired (soft-deleted).
 */
export function singleRef(key: string, t: RefTable & { column: string }, onMoved?: (scope: TxScope, intoId: string) => Promise<void>) {
  const target = (scope: TxScope, into: string) => countRefs(scope, { ...t, columns: [t.column] }, into);
  const ref: OrgReference = {
    key,
    rule: 'keep_target',
    count: async (scope, from, into) => {
      const rows = await countRefs(scope, { ...t, columns: [t.column] }, from);
      return { rows, conflicts: rows > 0 && (await target(scope, into)) > 0 ? rows : 0 };
    },
    apply: async (scope, from, into) => {
      const one = { ...t, columns: [t.column] };
      if ((await target(scope, into)) > 0) return retireRef(key, one).apply!(scope, from, into);
      const moved = await moveRefs(scope, one, from, into);
      if (moved > 0) await onMoved?.(scope, into);
      return { moved, retired: 0 };
    },
  };
  return ref;
}
