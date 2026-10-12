// Helpers shared by the organization use cases (40 §7-§9).
import { ApiError, type FieldError } from '#libs/contract/index.js';
import type { OrgType } from '#libs/contract/generated/enums.js';
import type { OperationContext } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import type { TaxonomyResolver } from '#modules/taxonomy/interface/taxonomy-resolver.js';

export interface MemberAccess {
  userId: string;
  orgId: string;
  orgType: OrgType;
  role: string;
}

/** The signed-in member and the authorized path organization ({org}, {prv}, {vnd}). */
export function member(ctx: OperationContext): MemberAccess {
  const org = ctx.access.org;
  if (ctx.principal.kind !== 'user' || !org) throw new ApiError('NOT_FOUND');
  return { userId: ctx.principal.userId, orgId: org.id, orgType: org.type, role: org.role };
}

/** ETAG operations: compares the stored version with If-Match (SEC-IC-4). */
export function checkVersion(version: number, ifMatch: number | undefined): void {
  if (ifMatch === undefined) throw new ApiError('PRECONDITION_REQUIRED');
  if (version !== ifMatch) throw new ApiError('VERSION_MISMATCH');
}

type Position = { id?: string } | undefined;

/** Keyset position of the `cursor` query parameter (ids are UUIDv7, so id order is creation order). */
export const afterId = (ctx: OperationContext): string | undefined => (ctx.cursor as Position)?.id;

/** Page<T> from `limit + 1` rows ordered by id. */
export function pageOf<R extends { id: string }, T>(ctx: OperationContext<unknown, { limit: number }>, rows: R[], map: (r: R) => T) {
  const limit = ctx.query.limit;
  const page = rows.slice(0, limit);
  return ctx.page(page.map(map), rows.length > limit ? { id: page.at(-1)!.id } : null);
}

/** Throws 422 VALIDATION_FAILED with all collected field errors. */
export function failIf(errors: FieldError[]): void {
  if (errors.length) throw ApiError.validation(errors);
}

/** Vehicle and service chains of a write (40 CoverageWrite / CapabilityWrite / JobLogWrite / PortfolioWrite). */
export interface NodeChain {
  brand_node_id?: string | null;
  model_node_id?: string | null;
  series_node_id?: string | null;
  service_system_node_id?: string | null;
  service_task_node_id?: string | null;
}

/**
 * Parent chains (52: series needs a model and belongs to it; model under the
 * brand; task under the system). Node types are checked by the pipeline
 * (GD-17); this checks the chain: 422 TAXONOMY_MISMATCH, or
 * conditional_required for a series without a model.
 */
export async function checkChain(taxonomy: TaxonomyResolver, c: NodeChain, prefix = ''): Promise<void> {
  if (c.series_node_id && !c.model_node_id)
    throw ApiError.validation([{ pointer: `${prefix}/model_node_id`, code: 'conditional_required' }]);
  if (c.model_node_id && c.brand_node_id) await taxonomy.requireDescendant(c.model_node_id, c.brand_node_id, `${prefix}/model_node_id`);
  if (c.series_node_id && c.model_node_id) await taxonomy.requireDescendant(c.series_node_id, c.model_node_id, `${prefix}/series_node_id`);
  if (c.service_task_node_id && c.service_system_node_id)
    await taxonomy.requireDescendant(c.service_task_node_id, c.service_system_node_id, `${prefix}/service_task_node_id`);
}

/** Free taxonomy references (certification scopes, portfolio tags): active nodes of any of `types`. */
export async function checkNodes(
  taxonomy: TaxonomyResolver,
  ids: readonly string[] | undefined,
  types: Parameters<TaxonomyResolver['require']>[1],
  pointer: string,
): Promise<void> {
  for (const [i, id] of (ids ?? []).entries()) await taxonomy.require(id, types, `${pointer}/${i}`);
}

/** The organization row of the authorized organization (member_all policy). */
export async function loadOrg(scope: TxScope, orgId: string, lock = false) {
  const q = scope.db.selectFrom('organization.organizations').selectAll().where('id', '=', orgId).where('deleted_at', 'is', null);
  const row = await (lock ? q.forUpdate() : q).executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  return row;
}

/** jsonb columns: arrays must be serialized (pg would send a PostgreSQL array). */
export const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
