// Organization merge (40 admin.org_merge, admin.org_merge_preview; backend S22,
// admin console BR-08, DI-67). A platform admin asks to merge a duplicate into
// the surviving organization (4EYES); a second admin approves it, which starts
// a background job (organization_merge, W7 worker, read by admin.job_get). The
// job applies every module's registered references (OrganizationReferences)
// in one transaction, then marks the duplicate merged, takes its profiles off
// publication and publishes organization.merged; a failure anywhere leaves
// nothing re-pointed. A reference with the refuse rule and live rows blocks the
// request, the approval and the job alike. The preview counts every reference
// and its conflicts without changing anything.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { Authorizer } from '#libs/authz/index.js';
import { ApiError } from '#libs/contract/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { JobService, type JobContext, type JobOutcome } from '#libs/jobs/index.js';
import type { Logger } from '#libs/observability/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { InjectLogger } from '#libs/runtime/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { FourEyes, staffOf, type ApprovedChange } from '#modules/admin/interface/admin.js';
import type { OrgRow } from '../api/projections.js';
import { OrgCards, toOrgSummary } from '../interface/org-cards.js';
import {
  countRefs,
  historyRef,
  keyedRef,
  moveRef,
  OrganizationReferences,
  previewReferences,
  refusals,
  singleRef,
  type OrgReference,
  type OrgReferenceResult,
} from '../interface/org-references.js';
import { failIf, profilesFollow } from './common.js';

export const ORG_MERGE_QUEUE = 'organization.merge';

/** The organizations of a merge: distinct, same kind of business (fleet or not), neither merged nor archived. */
export async function mergePair(scope: TxScope, fromId: string, intoId: string, lock: boolean): Promise<[OrgRow, OrgRow]> {
  const load = (id: string) => {
    const q = scope.db.selectFrom('organization.organizations').selectAll().where('id', '=', id).where('deleted_at', 'is', null);
    return (lock ? q.forUpdate() : q).executeTakeFirst();
  };
  const from = await load(fromId);
  if (!from) throw new ApiError('NOT_FOUND');
  if (fromId === intoId) failIf([{ pointer: '/into_organization_id', code: 'conditional_forbidden' }]);
  const into = await load(intoId);
  if (!into) throw ApiError.validation([{ pointer: '/into_organization_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
  for (const o of [from, into])
    if (['merged', 'archived'].includes(o.status)) throw new ApiError('INVALID_TRANSITION', { detail: `${o.id} ${o.status}` });
  const kind = (t: string) => (t === 'fleet' ? 'fleet' : 'business');
  if (kind(from.organization_type) !== kind(into.organization_type))
    throw new ApiError('INVALID_TRANSITION', { detail: 'different organization kinds' });
  return [from, into];
}

/**
 * The modules that keep organization references (Docs/43 columns naming an organization). A host composed without
 * one of them would merge partially, so the request, the approval and the job refuse to run until every one has
 * registered.
 */
export const ORG_REFERENCE_MODULES = [
  'admin',
  'ai_mcp',
  'appointment',
  'billing',
  'community',
  'discovery',
  'fleet',
  'identity',
  'inventory',
  'media',
  'organization',
  'trust',
  'vehicle',
] as const;

/** 409 when a refuse reference has live rows (e.g. an open assist session on the duplicate). */
async function requireNotRefused(scope: TxScope, refs: OrganizationReferences, fromId: string, intoId: string): Promise<void> {
  const registered = new Set(refs.entries().map((e) => e.module));
  const missing = ORG_REFERENCE_MODULES.filter((m) => !registered.has(m));
  if (missing.length) throw new Error(`organization references not registered: ${missing.join(', ')}`);
  const blocked = refusals(await previewReferences(scope, refs, fromId, intoId));
  if (blocked.length) throw new ApiError('INVALID_TRANSITION', { detail: `merge refused by ${blocked.join(', ')}` });
}

@Injectable()
@Operation('admin.org_merge')
export class AdminOrgMergeHandler implements OperationHandler {
  constructor(
    private readonly fourEyes: FourEyes,
    private readonly refs: OrganizationReferences,
  ) {}

  async handle(ctx: OperationContext<{ into_organization_id: string; reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const [from, into] = await mergePair(scope, ctx.params.org_id!, b.into_organization_id, true);
      await requireNotRefused(scope, this.refs, from.id, into.id);
      return this.fourEyes.request(
        scope,
        s.userId,
        {
          opId: 'admin.org_merge',
          targetType: 'organization',
          targetId: from.id,
          payload: { org_id: from.id, into_organization_id: into.id },
          summary: `Merge "${from.name}" (${from.id}) into "${into.name}" (${into.id})`,
          reason: b.reason,
          requiredRole: 'platform_admin',
        },
        ctx.locale,
      );
    });
    return { status: 202, body };
  }
}

/** admin.org_merge_preview: per module and reference, the rows a merge would change and their conflicts (counts only). */
@Injectable()
@Operation('admin.org_merge_preview')
export class AdminOrgMergePreviewHandler implements OperationHandler {
  constructor(
    private readonly refs: OrganizationReferences,
    private readonly cards: OrgCards,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    staffOf(ctx);
    const intoId = String(ctx.query.into_organization_id);
    const body = await ctx.tx(
      async (scope) => {
        const [from, into] = await mergePair(scope, ctx.params.org_id!, intoId, false);
        const references = await previewReferences(scope, this.refs, from.id, into.id);
        const cards = await this.cards.cards(scope, [from.id, into.id]);
        return {
          organization: toOrgSummary(cards.get(from.id)!),
          into: toOrgSummary(cards.get(into.id)!),
          references,
          blocked_by: refusals(references),
        };
      },
      { readOnly: true },
    );
    return { body };
  }
}

/**
 * Four-eyes executor of admin.org_merge (and of a merge_duplicate case action): checks the pair and the refusals again
 * in the approver's transaction and starts the merge job; its id becomes PendingChange.job_id.
 */
export async function startOrganizationMerge(
  scope: TxScope,
  jobs: JobService,
  refs: OrganizationReferences,
  change: ApprovedChange,
): Promise<{ jobId: string }> {
  const intoId = String(change.payload.into_organization_id);
  const [from, into] = await mergePair(scope, change.targetId, intoId, true);
  await requireNotRefused(scope, refs, from.id, into.id);
  const row = await jobs.create(scope, {
    kind: 'organization_merge',
    ownerUserId: change.approvedBy,
    owningModule: 'organization',
    inputSummary: { organization_id: from.id, into_organization_id: into.id, change_id: change.id },
    queue: ORG_MERGE_QUEUE,
  });
  return { jobId: row.id };
}

/** The merge job (W7): every reference in one transaction, then the duplicate becomes merged. */
@Injectable()
export class OrgMerger {
  constructor(
    private readonly tx: TxRunner,
    private readonly refs: OrganizationReferences,
    private readonly authorizer: Authorizer,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async run(ctx: JobContext): Promise<JobOutcome> {
    const input = ctx.job.input_summary as { organization_id?: string; into_organization_id?: string; change_id?: string } | null;
    if (!input?.organization_id || !input.into_organization_id) return { errorCode: 'INTERNAL' };
    const { organization_id: fromId, into_organization_id: intoId } = input;
    return this.tx.run({ actorType: 'system', requestId: ctx.job.id }, async (scope) => {
      let from: OrgRow;
      try {
        [from] = await mergePair(scope, fromId, intoId, true);
        await requireNotRefused(scope, this.refs, fromId, intoId);
      } catch (err) {
        // The pair changed since the approval (merged, archived, an assist session opened): nothing is changed.
        if (err instanceof ApiError) return { errorCode: err.code };
        throw err;
      }
      const results: Record<string, OrgReferenceResult> = {};
      for (const { ref } of this.refs.entries()) {
        if (ctx.signal.aborted) throw new Error('organization merge cancelled');
        if (ref.apply) results[ref.key] = await ref.apply(scope, fromId, intoId);
      }
      await scope.db
        .updateTable('organization.organizations')
        .set({ status: 'merged', merged_into_organization_id: intoId })
        .where('id', '=', fromId)
        .execute();
      await profilesFollow(scope, fromId, 'published', 'draft');
      const changed = Object.fromEntries(Object.entries(results).filter(([, r]) => r.moved || r.retired));
      await writeAudit(scope, {
        action: 'organization.merged',
        entityType: 'organization',
        entityId: fromId,
        reason: `approved four-eyes change ${input.change_id ?? '-'}`,
        previous: from.status,
        next: `merged into ${intoId}: ${JSON.stringify(changed)}`.slice(0, 2000),
      });
      await publishEvent(scope, {
        type: 'moderation.action.taken',
        aggregateType: 'organization',
        aggregateId: fromId,
        payload: {
          action_type: 'merge_duplicate',
          target_type: 'organization',
          target_id: fromId,
          organization_id: fromId,
          merged_into_organization_id: intoId,
        },
      });
      // The surviving organization's trust score, search entries and figures follow the records it received.
      await publishEvent(scope, {
        type: 'organization.merged',
        aggregateType: 'organization',
        aggregateId: intoId,
        payload: { organization_id: intoId, merged_organization_id: fromId },
      });
      scope.afterCommit(async () => {
        await this.authorizer.invalidateOrganization(fromId);
        await this.authorizer.invalidateOrganization(intoId);
      });
      this.logger.info({ organization: fromId, into: intoId, results: changed }, 'organization merged');
      return { result: { type: 'organization', id: intoId } };
    });
  }
}

// ------------------------------------------------------------------ the organization module's own references

const ORG = 'organization.organizations';

/** A provider (vendor) profile moved to a vendor-only (provider-only) organization makes it hybrid. */
const becomesHybrid = (only: 'vendor' | 'provider') => async (scope: TxScope, intoId: string) => {
  await sql`UPDATE organization.organizations SET organization_type = 'hybrid_provider_vendor'
             WHERE id = ${intoId}::uuid AND organization_type = ${only}`.execute(scope.db);
};

/** Locations (merge): all move; the target keeps its primary location, and the moved ones arrive inactive when it has an active one. */
const locations: OrgReference = {
  key: 'organization.locations',
  rule: 'merge',
  count: async (scope, from, into) => {
    const t = { table: 'organization.organization_locations', columns: ['organization_id'] };
    const rows = await countRefs(scope, t, from);
    const targetActive = await countRefs(scope, { ...t, where: "%.status = 'active'" }, into);
    return { rows, conflicts: targetActive > 0 ? await countRefs(scope, { ...t, where: "%.status = 'active'" }, from) : 0 };
  },
  apply: async (scope, from, into) => {
    const r = await sql`
      UPDATE organization.organization_locations r
         SET organization_id = ${into}::uuid,
             is_primary = r.is_primary AND NOT EXISTS (SELECT 1 FROM organization.organization_locations t
                            WHERE t.organization_id = ${into}::uuid AND t.status = 'active' AND t.deleted_at IS NULL),
             status = CASE WHEN EXISTS (SELECT 1 FROM organization.organization_locations t
                            WHERE t.organization_id = ${into}::uuid AND t.status = 'active' AND t.deleted_at IS NULL)
                           THEN 'inactive' ELSE r.status END
       WHERE r.organization_id = ${from}::uuid AND r.deleted_at IS NULL`.execute(scope.db);
    return { moved: Number(r.numAffectedRows ?? 0), retired: 0 };
  },
};

/** Verification checks stay with the merged organization (its own documents); checks still waiting expire and their requests for information close. */
const verifications: OrgReference = {
  ...historyRef('organization.verifications', { table: 'organization.organization_verifications', columns: ['organization_id'] }),
  apply: async (scope, from) => {
    const r = await sql`UPDATE organization.organization_verifications SET status = 'expired', sla_paused_at = NULL
                         WHERE organization_id = ${from}::uuid AND status = 'pending' AND deleted_at IS NULL`.execute(scope.db);
    await sql`UPDATE organization.verification_info_requests SET status = 'closed', closed_at = now()
               WHERE organization_id = ${from}::uuid AND status = 'open'`.execute(scope.db);
    return { moved: 0, retired: Number(r.numAffectedRows ?? 0) };
  },
};

/** The organization module's references to organizations. */
export function organizationReferences(): OrgReference[] {
  return [
    moveRef('organization.merged_organizations', { table: ORG, columns: ['merged_into_organization_id'] }),
    locations,
    verifications,
    historyRef('organization.profile_changes', {
      table: 'organization.organization_profile_changes',
      columns: ['organization_id'],
      softDeleted: false,
    }),
    singleRef(
      'organization.provider_profile',
      { table: 'organization.provider_profiles', columns: ['organization_id'], column: 'organization_id' },
      becomesHybrid('vendor'),
    ),
    singleRef(
      'organization.vendor_profile',
      { table: 'organization.vendor_profiles', columns: ['organization_id'], column: 'organization_id' },
      becomesHybrid('provider'),
    ),
    moveRef('organization.certifications', { table: 'organization.provider_certifications', columns: ['provider_organization_id'] }),
    keyedRef('organization.service_categories', {
      table: 'organization.provider_service_categories',
      columns: ['provider_organization_id'],
      key: ['taxonomy_node_id'],
    }),
    keyedRef('organization.vehicle_coverage', {
      table: 'organization.provider_vehicle_coverage',
      columns: ['provider_organization_id'],
      key: ['brand_node_id', 'model_node_id', 'series_node_id', 'engine_type_node_id', 'fuel_type_node_id'],
      nullsNotDistinct: true,
    }),
    // Capability evidence is immutable once counted, so a duplicate capability keeps its evidence and is retired.
    keyedRef('organization.capabilities', {
      table: 'organization.provider_capabilities',
      columns: ['provider_organization_id'],
      key: ['brand_node_id', 'model_node_id', 'series_node_id', 'service_system_node_id', 'service_task_node_id'],
      nullsNotDistinct: true,
    }),
    moveRef('organization.job_logs', { table: 'organization.provider_job_logs', columns: ['provider_organization_id'] }),
    moveRef('organization.customer_notes', { table: 'organization.provider_customer_notes', columns: ['provider_organization_id'] }),
    moveRef('organization.portfolio_items', { table: 'organization.portfolio_items', columns: ['provider_organization_id'] }),
    keyedRef('organization.vendor_coverage', {
      table: 'organization.vendor_coverage',
      columns: ['vendor_organization_id'],
      key: ['taxonomy_node_id', 'coverage_type'],
    }),
  ];
}
