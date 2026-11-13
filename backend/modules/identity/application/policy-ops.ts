// Policy and consent text operations (backend S15; admin console BR-12, A-POL-01; 40 §6.7, §23.5). Administrators
// write drafts (titles and texts in every enabled locale) and publish them with an effective date and a re-consent
// flag; publishing waits for a second administrator (4EYES), and a published version is read-only (also enforced by
// the trigger policy_versions_immutable). The api host serves the text in force (policy.current, public) and records
// acceptances (policy.accept); the worker moves stored statuses on when a scheduled version comes into force.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError } from '#libs/contract/index.js';
import { iso, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { ScheduledRule } from '#libs/jobs/index.js';
import { RegionConfigService } from '#libs/region-config/index.js';
import { TxRunner, type TxScope } from '#libs/tenancy/index.js';
import { FourEyes, StaffNames, staffOf, type ApprovedChange } from '#modules/admin/interface/admin.js';
import { caller } from './common.js';
import {
  ensureDocument,
  findDocument,
  isPolicyKey,
  missingLocales,
  POLICY_KEYS,
  RECONSENT_MODE,
  reconsentFor,
  recordAcceptances,
  settleStatuses,
  staffIdsOf,
  toPolicyText,
  toStaffSummary,
  toStaffVersion,
  upcomingVersion,
  versionInForce,
  type PolicyKey,
  type PolicyVersionRow,
} from './policy-texts.js';

type Translations = Record<string, string>;

/** A version with its document's key (staff reads and writes). */
async function versionWithKey(scope: TxScope, id: string, lock = false): Promise<{ v: PolicyVersionRow; key: PolicyKey }> {
  let q = scope.db
    .selectFrom('identity.policy_versions as v')
    .innerJoin('identity.policy_documents as d', 'd.id', 'v.document_id')
    .selectAll('v')
    .select('d.policy_key')
    .where('v.id', '=', id)
    .where('v.deleted_at', 'is', null);
  if (lock) q = q.forUpdate('v');
  const row = await q.executeTakeFirst();
  if (!row) throw new ApiError('NOT_FOUND');
  const { policy_key, ...v } = row;
  return { v, key: policy_key as PolicyKey };
}

async function labelTaken(scope: TxScope, documentId: string, label: string, exceptId?: string): Promise<boolean> {
  let q = scope.db
    .selectFrom('identity.policy_versions')
    .select('id')
    .where('document_id', '=', documentId)
    .where('policy_version', '=', label);
  if (exceptId) q = q.where('id', '<>', exceptId);
  return !!(await q.executeTakeFirst());
}

function checkTexts(b: { title_translations?: unknown; body_translations?: unknown; change_summary_translations?: unknown }): void {
  const errors = [
    ...missingLocales(b.title_translations, '/title_translations'),
    ...missingLocales(b.body_translations, '/body_translations'),
    ...missingLocales(b.change_summary_translations, '/change_summary_translations'),
  ];
  if (errors.length) throw ApiError.validation(errors);
}

const auditText = (v: { policy_version: string; status: string; effective_at?: Date | string | null; requires_reconsent?: boolean }) =>
  JSON.stringify({
    policy_version: v.policy_version,
    status: v.status,
    effective_at: v.effective_at ? iso(v.effective_at) : null,
    requires_reconsent: v.requires_reconsent ?? false,
  });

// ------------------------------------------------------------------ admin plane

@Injectable()
export class PolicyStaffViews {
  constructor(
    private readonly names: StaffNames,
    private readonly region: RegionConfigService,
  ) {}

  get regionKey(): string {
    return this.region.regionKey;
  }

  async version(scope: TxScope, id: string, locale: string) {
    const { v, key } = await versionWithKey(scope, id);
    const inForce = await versionInForce(scope, v.document_id);
    const names = await this.names.names(scope, staffIdsOf([v]), locale);
    return toStaffVersion(key, v, inForce?.id, names, locale as 'en' | 'fa');
  }

  async documents(scope: TxScope, locale: string) {
    const docs = await scope.db
      .selectFrom('identity.policy_documents')
      .selectAll()
      .where('region_key', '=', this.regionKey)
      .where('deleted_at', 'is', null)
      .execute();
    const versions = docs.length
      ? await scope.db
          .selectFrom('identity.policy_versions')
          .selectAll()
          .where(
            'document_id',
            'in',
            docs.map((d) => d.id),
          )
          .where('deleted_at', 'is', null)
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .execute()
      : [];
    const names = await this.names.names(scope, staffIdsOf(versions), locale);
    // Every key is listed, also before its document exists in this region (created with the first draft).
    const items = [];
    for (const key of POLICY_KEYS) {
      const doc = docs.find((d) => d.policy_key === key);
      const mine = doc ? versions.filter((v) => v.document_id === doc.id).slice(0, 100) : [];
      const inForce = doc ? await versionInForce(scope, doc.id) : undefined;
      items.push({
        policy_key: key,
        region_key: this.regionKey,
        reconsent_mode: doc?.reconsent_mode ?? RECONSENT_MODE[key],
        versions: mine.map((v) => toStaffSummary(key, v, inForce?.id, names, locale as 'en' | 'fa')),
      });
    }
    return items;
  }
}

@Injectable()
@Operation('admin.policies_list')
export class AdminPoliciesListHandler implements OperationHandler {
  constructor(private readonly views: PolicyStaffViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    staffOf(ctx);
    const items = await ctx.tx((scope) => this.views.documents(scope, ctx.locale), { readOnly: true });
    return { body: { items } };
  }
}

@Injectable()
@Operation('admin.policy_version_get')
export class AdminPolicyVersionGetHandler implements OperationHandler {
  constructor(private readonly views: PolicyStaffViews) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    staffOf(ctx);
    const body = await ctx.tx((scope) => this.views.version(scope, ctx.params.version_id!, ctx.locale), { readOnly: true });
    return { body };
  }
}

type VersionWrite = {
  policy_version: string;
  title_translations: Translations;
  body_translations: Translations;
  change_summary_translations?: Translations;
  reason: string;
};

@Injectable()
@Operation('admin.policy_version_create')
export class AdminPolicyVersionCreateHandler implements OperationHandler {
  constructor(private readonly views: PolicyStaffViews) {}

  async handle(ctx: OperationContext<VersionWrite>): Promise<OperationResult> {
    staffOf(ctx);
    const key = ctx.params.policy_key!;
    if (!isPolicyKey(key)) throw new ApiError('NOT_FOUND');
    const b = ctx.body;
    checkTexts(b);
    const body = await ctx.tx(async (scope) => {
      const doc = await ensureDocument(scope, this.views.regionKey, key);
      if (await labelTaken(scope, doc.id, b.policy_version)) throw new ApiError('DUPLICATE', { detail: 'policy_version' });
      const v = await scope.db
        .insertInto('identity.policy_versions')
        .values({
          document_id: doc.id,
          policy_version: b.policy_version,
          title_translations: JSON.stringify(b.title_translations),
          body_translations: JSON.stringify(b.body_translations),
          change_summary_translations: b.change_summary_translations ? JSON.stringify(b.change_summary_translations) : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'policy.version_created',
        entityType: 'policy_version',
        entityId: v.id,
        reason: b.reason,
        next: JSON.stringify({ policy_key: key, region_key: doc.region_key, policy_version: b.policy_version, status: 'draft' }),
      });
      return this.views.version(scope, v.id, ctx.locale);
    });
    return { status: 201, body, headers: { location: `/v1/admin/policy-versions/${body.id}` } };
  }
}

type VersionPatch = Partial<Omit<VersionWrite, 'change_summary_translations'>> & {
  change_summary_translations?: Translations | null;
  reason: string;
};

@Injectable()
@Operation('admin.policy_version_update')
export class AdminPolicyVersionUpdateHandler implements OperationHandler {
  constructor(private readonly views: PolicyStaffViews) {}

  async handle(ctx: OperationContext<VersionPatch>): Promise<OperationResult> {
    staffOf(ctx);
    const b = ctx.body;
    checkTexts(b);
    const body = await ctx.tx(async (scope) => {
      const { v } = await versionWithKey(scope, ctx.params.version_id!, true);
      if (ctx.ifMatch !== v.version) throw new ApiError('VERSION_MISMATCH');
      if (v.status !== 'draft') throw new ApiError('INVALID_TRANSITION', { detail: 'not_draft' });
      if (b.policy_version !== undefined && (await labelTaken(scope, v.document_id, b.policy_version, v.id)))
        throw new ApiError('DUPLICATE', { detail: 'policy_version' });
      await scope.db
        .updateTable('identity.policy_versions')
        .set({
          ...(b.policy_version !== undefined ? { policy_version: b.policy_version } : {}),
          ...(b.title_translations !== undefined ? { title_translations: JSON.stringify(b.title_translations) } : {}),
          ...(b.body_translations !== undefined ? { body_translations: JSON.stringify(b.body_translations) } : {}),
          ...(b.change_summary_translations !== undefined
            ? { change_summary_translations: b.change_summary_translations === null ? null : JSON.stringify(b.change_summary_translations) }
            : {}),
        })
        .where('id', '=', v.id)
        .execute();
      const changed = Object.keys(b).filter((k) => k !== 'reason');
      await writeAudit(scope, {
        action: 'policy.version_updated',
        entityType: 'policy_version',
        entityId: v.id,
        reason: b.reason,
        previous: v.policy_version,
        next: `${b.policy_version ?? v.policy_version}; changed ${changed.join(', ') || 'nothing'}`.slice(0, 2000),
      });
      return this.views.version(scope, v.id, ctx.locale);
    });
    return { body };
  }
}

const POLICY_TITLES: Record<PolicyKey, string> = {
  terms: 'Terms of Use',
  privacy: 'Privacy Policy',
  community_guidelines: 'Community Guidelines',
};

/** A document's version scheduled to come into force later (409 scheduled_exists when publishing another one). */
async function scheduledOther(scope: TxScope, documentId: string, exceptId: string): Promise<boolean> {
  const next = await upcomingVersion(scope, documentId);
  return !!next && next.id !== exceptId;
}

@Injectable()
@Operation('admin.policy_version_publish')
export class AdminPolicyVersionPublishHandler implements OperationHandler {
  constructor(
    private readonly fourEyes: FourEyes,
    private readonly views: PolicyStaffViews,
  ) {}

  async handle(ctx: OperationContext<{ effective_at: string; requires_reconsent: boolean; reason: string }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const b = ctx.body;
    // Not in the past (a minute of clock skew between the console and the server is tolerated).
    if (new Date(b.effective_at).getTime() < Date.now() - 60_000) throw ApiError.validation([{ pointer: '/effective_at', code: 'in_past' }]);
    const body = await ctx.tx(async (scope) => {
      const { v, key } = await versionWithKey(scope, ctx.params.version_id!);
      if (v.status !== 'draft') throw new ApiError('INVALID_TRANSITION', { detail: 'not_draft' });
      checkTexts({ title_translations: v.title_translations, body_translations: v.body_translations });
      if (await scheduledOther(scope, v.document_id, v.id)) throw new ApiError('INVALID_TRANSITION', { detail: 'scheduled_exists' });
      return this.fourEyes.request(
        scope,
        s.userId,
        {
          opId: 'admin.policy_version_publish',
          targetType: 'policy_version',
          targetId: v.id,
          payload: { version_id: v.id, effective_at: b.effective_at, requires_reconsent: b.requires_reconsent },
          summary:
            `Publish ${POLICY_TITLES[key]} ${v.policy_version} (${this.views.regionKey}) from ${b.effective_at}` +
            (b.requires_reconsent ? '; every user accepts it again' : '; no re-consent'),
          reason: b.reason,
          requiredRole: 'platform_admin',
        },
        ctx.locale,
      );
    });
    return { status: 202, body };
  }
}

/**
 * Four-eyes executor of admin.policy_version_publish: the draft becomes scheduled, or published at once when its
 * effective_at has passed by approval time (then it comes into force at approval); the previous version in force
 * becomes superseded when the new one comes into force.
 */
export async function publishPolicyVersion(scope: TxScope, change: ApprovedChange): Promise<void> {
  const p = change.payload as { version_id: string; effective_at: string; requires_reconsent: boolean };
  const { v, key } = await versionWithKey(scope, change.targetId, true);
  if (v.status !== 'draft') throw new ApiError('INVALID_TRANSITION', { detail: 'not_draft' });
  checkTexts({ title_translations: v.title_translations, body_translations: v.body_translations });
  await settleStatuses(scope, v.document_id);
  if (await scheduledOther(scope, v.document_id, v.id)) throw new ApiError('INVALID_TRANSITION', { detail: 'scheduled_exists' });
  const done = await scope.db
    .updateTable('identity.policy_versions')
    .set({
      effective_at: sql<Date>`greatest(${p.effective_at}::timestamptz, now())`,
      status: sql<string>`CASE WHEN ${p.effective_at}::timestamptz <= now() THEN 'published' ELSE 'scheduled' END`,
      requires_reconsent: p.requires_reconsent,
      published_by: change.requestedBy,
      approved_by: change.approvedBy,
      published_at: sql<Date>`now()`,
    })
    .where('id', '=', v.id)
    .returning(['policy_version', 'status', 'effective_at', 'requires_reconsent'])
    .executeTakeFirstOrThrow();
  await settleStatuses(scope, v.document_id);
  await writeAudit(scope, {
    action: 'policy.version_published',
    entityType: 'policy_version',
    entityId: v.id,
    reason: change.reason,
    previous: auditText({ policy_version: v.policy_version, status: 'draft' }),
    next: JSON.stringify({ policy_key: key, ...JSON.parse(auditText(done)) }),
  });
}

// ------------------------------------------------------------------ api host

@Injectable()
@Operation('policy.current')
export class PolicyCurrentHandler implements OperationHandler {
  constructor(private readonly region: RegionConfigService) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const key = ctx.params.policy_key!;
    if (!isPolicyKey(key)) throw new ApiError('NOT_FOUND');
    const body = await ctx.tx(
      async (scope) => {
        const doc = await findDocument(scope, this.region.regionKey, key);
        const current = doc ? await versionInForce(scope, doc.id) : undefined;
        if (!doc || !current) throw new ApiError('NOT_FOUND');
        return toPolicyText(doc, current, await upcomingVersion(scope, doc.id), ctx.locale);
      },
      { readOnly: true },
    );
    // Cacheable for 5 min for anonymous callers (the pipeline keeps signed-in responses private).
    return { body, cache: { public: 300 }, contentLanguage: body.body.locale };
  }
}

@Injectable()
@Operation('policy.accept')
export class PolicyAcceptHandler implements OperationHandler {
  constructor(private readonly region: RegionConfigService) {}

  async handle(ctx: OperationContext<{ policy_key: PolicyKey; policy_version: string }>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const b = ctx.body;
    const region = this.region.regionKey;
    const body = await ctx.tx(async (scope) => {
      const doc = await findDocument(scope, region, b.policy_key);
      const current = doc ? await versionInForce(scope, doc.id) : undefined;
      if (!doc || !current) throw new ApiError('NOT_FOUND');
      if (current.policy_version !== b.policy_version) throw new ApiError('POLICY_VERSION_OUTDATED', { detail: b.policy_key });
      await recordAcceptances(scope, userId, [current.id], 'prompt');
      const accepted = await scope.db
        .selectFrom('identity.policy_acceptances')
        .select('accepted_at')
        .where('user_id', '=', userId)
        .where('policy_version_id', '=', current.id)
        .executeTakeFirstOrThrow();
      // The account keeps the versions of terms and privacy it accepted last (52 UserAccount).
      if (b.policy_key === 'terms')
        await scope.db
          .updateTable('identity.user_accounts')
          .set({ terms_version: current.policy_version, terms_accepted_at: accepted.accepted_at })
          .where('id', '=', userId)
          .where('terms_version', '<>', current.policy_version)
          .execute();
      if (b.policy_key === 'privacy')
        await scope.db
          .updateTable('identity.user_accounts')
          .set({ privacy_policy_version: current.policy_version })
          .where('id', '=', userId)
          .where('privacy_policy_version', '<>', current.policy_version)
          .execute();
      await writeAudit(scope, {
        action: 'policy.accepted',
        entityType: 'policy_version',
        entityId: current.id,
        next: `${b.policy_key} ${current.policy_version} (${region})`,
      });
      return {
        acceptance: { policy_key: b.policy_key, policy_version: current.policy_version, accepted_at: iso(accepted.accepted_at) },
        policy_reconsent: await reconsentFor(scope, userId, region),
      };
    });
    return { body };
  }
}

// ------------------------------------------------------------------ worker

/**
 * W15 "policy versions in force" (backend S15): every 5 minutes, scheduled versions whose effective_at has passed
 * become published and the versions they replace superseded. Reads already decide by the clock; this keeps the
 * stored status (and the console's filters) in step and writes one audit entry per version that came into force.
 */
@Injectable()
export class PolicyVersionRule extends ScheduledRule {
  readonly name = 'identity.policy_in_force';
  readonly everyMs = 300_000;

  constructor(private readonly tx: TxRunner) {
    super();
  }

  /** Returns the number of versions whose stored status changed. */
  async run(): Promise<number> {
    return this.tx.run({ actorType: 'system' }, async (scope) => {
      const changed = await settleStatuses(scope);
      for (const c of changed.filter((x) => x.status === 'published'))
        await writeAudit(scope, {
          action: 'policy.version_in_force',
          entityType: 'policy_version',
          entityId: c.id,
          previous: 'scheduled',
          next: c.policy_version,
        });
      return changed.length;
    });
  }
}
