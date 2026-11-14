// Organizations (40 §7.2): org.create, org.get, org.update (with its profile
// history, S19), org.verifications_list, org.verification_submit,
// org.verification_resubmit (S19).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { writeAudit } from '#libs/audit/index.js';
import { Authorizer } from '#libs/authz/index.js';
import { ApiError } from '#libs/contract/index.js';
import type { OrgType } from '#libs/contract/generated/enums.js';
import { uuidv7 } from '#libs/crypto/index.js';
import { registerConstraintErrors, textArray } from '#libs/db/index.js';
import { created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { Infra } from '#libs/infra/index.js';
import { InjectInfra } from '#libs/runtime/index.js';
import { SubscriptionWriter } from '#modules/billing/interface/billing.js';
import { AccountFacts, OrgMemberships } from '#modules/identity/interface/identity.js';
import { MediaService } from '#modules/media/interface/media.js';
import { toOrganization, toVerification } from '../api/projections.js';
import { ownerRoleFor } from '../domain/roles.js';
import {
  afterId,
  checkVersion,
  failIf,
  json,
  loadOrg,
  member,
  profileDiff,
  profileUpdated,
  recordProfileChange,
  toVerifications,
} from './common.js';

registerConstraintErrors({
  organizations_slug_uq: { code: 'DUPLICATE', pointer: '/slug', fieldCode: 'not_unique' },
  organization_verifications_pending_uq: 'DUPLICATE',
});

type OrgCreate = {
  name: string;
  legal_name?: string;
  organization_type: OrgType;
  contact_email: string;
  contact_phone?: string;
  website?: string;
  description_translations?: Record<string, string>;
};

@Injectable()
@Operation('org.create')
export class OrgCreateHandler implements OperationHandler {
  constructor(
    private readonly facts: AccountFacts,
    private readonly memberships: OrgMemberships,
    private readonly subscriptions: SubscriptionWriter,
    private readonly authorizer: Authorizer,
  ) {}

  async handle(ctx: OperationContext<OrgCreate>): Promise<OperationResult> {
    if (ctx.principal.kind !== 'user') throw new ApiError('NOT_FOUND');
    const userId = ctx.principal.userId;
    const b = ctx.body;
    // The application generates the id and switches the context to it before inserting (policy create_draft).
    const id = uuidv7();
    const role = ownerRoleFor(b.organization_type);
    const body = await ctx.tx(async (scope) => {
      if (!(await this.facts.hasVerifiedContact(scope, userId))) throw new ApiError('VERIFIED_CONTACT_REQUIRED');
      await scope.setOrganization(id, role);
      const org = await scope.db
        .insertInto('organization.organizations')
        .values({
          id,
          name: b.name,
          legal_name: b.legal_name ?? null,
          organization_type: b.organization_type,
          contact_email: b.contact_email.toLowerCase(),
          contact_phone: b.contact_phone ?? null,
          website: b.website ?? null,
          description_translations: json(b.description_translations),
          status: 'draft',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.memberships.addOwner(scope, id, userId, role);
      // 40 org.create: the default plan of the organization's audience, in the same transaction.
      const plan = await this.subscriptions.createDefaultForOrganization(scope, id, b.organization_type);
      await writeAudit(scope, { action: 'organization.created', entityType: 'organization', entityId: id, next: plan });
      scope.afterCommit(() => this.authorizer.invalidateUser(userId));
      return toOrganization(org, role);
    });
    return created(body, `/v1/orgs/${id}`);
  }
}

@Injectable()
@Operation('org.get')
export class OrgGetHandler implements OperationHandler {
  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    const org = await ctx.tx((scope) => loadOrg(scope, m.orgId), { readOnly: true });
    return { body: toOrganization(org, m.role) };
  }
}

type OrgUpdate = {
  name?: string;
  legal_name?: string | null;
  contact_email?: string;
  contact_phone?: string | null;
  website?: string | null;
  description_translations?: Record<string, string> | null;
  slug?: string;
};

/** The stored values of the fields a patch named (the row as written, e.g. a lowercased email). */
function pick(row: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(patch).map((k) => [k, row[k]]));
}

const SLUG_WINDOW_MS = 30 * 86_400_000;
const SLUG_CHANGES = 2;

@Injectable()
@Operation('org.update')
export class OrgUpdateHandler implements OperationHandler {
  constructor(@InjectInfra() private readonly infra: Infra) {}

  async handle(ctx: OperationContext<OrgUpdate>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    const slugKey = `org:slug-changes:${m.orgId}`;
    const body = await ctx.tx(async (scope) => {
      const org = await loadOrg(scope, m.orgId, true);
      checkVersion(org.version, ctx.ifMatch);
      const slugChanges = b.slug !== undefined && b.slug !== org.slug;
      if (slugChanges && Number((await this.infra.kv.get(slugKey)) ?? 0) >= SLUG_CHANGES) {
        // 40 OrgUpdate: at most 2 slug changes per 30 days.
        const ttl = (await this.infra.kv.ttl(slugKey)) ?? SLUG_WINDOW_MS;
        throw new ApiError('RATE_LIMITED', { detail: 'slug changes per 30 days', retryAfterMs: Math.min(ttl, 3_600_000) });
      }
      const patch = {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.legal_name !== undefined ? { legal_name: b.legal_name } : {}),
        ...(b.contact_email !== undefined ? { contact_email: b.contact_email.toLowerCase() } : {}),
        ...(b.contact_phone !== undefined ? { contact_phone: b.contact_phone } : {}),
        ...(b.website !== undefined ? { website: b.website } : {}),
        ...(b.description_translations !== undefined ? { description_translations: json(b.description_translations) } : {}),
        ...(slugChanges ? { slug: b.slug } : {}),
      };
      const row = Object.keys(patch).length
        ? await scope.db
            .updateTable('organization.organizations')
            .set(patch)
            .where('id', '=', m.orgId)
            .returningAll()
            .executeTakeFirstOrThrow()
        : org;
      // S19 (BR-35 part 3): the profile history staff read with admin.org_history.
      await recordProfileChange(scope, { orgId: m.orgId, actor: 'member', userId: m.userId, changes: profileDiff(org, pick(row, patch)) });
      await writeAudit(scope, {
        action: 'organization.updated',
        entityType: 'organization',
        entityId: m.orgId,
        next: Object.keys(patch).join(',') || null,
      });
      if (slugChanges) scope.afterCommit(() => this.infra.kv.incr(slugKey, 1, SLUG_WINDOW_MS).then(() => undefined));
      await profileUpdated(scope, m.orgId, 'organization');
      return toOrganization(row, m.role);
    });
    return { body };
  }
}

@Injectable()
@Operation('org.verifications_list')
export class OrgVerificationsListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { limit: number }>): Promise<OperationResult> {
    const m = member(ctx);
    const after = afterId(ctx);
    const result = await ctx.tx(
      async (scope) => {
        let q = scope.db
          .selectFrom('organization.organization_verifications')
          .selectAll()
          .where('organization_id', '=', m.orgId)
          .where('deleted_at', 'is', null);
        if (after) q = q.where('id', '<', after);
        const rows = await q
          .orderBy('id', 'desc')
          .limit(ctx.query.limit + 1)
          .execute();
        const page = rows.slice(0, ctx.query.limit);
        return { items: await toVerifications(scope, page), next: rows.length > ctx.query.limit ? page.at(-1)!.id : null };
      },
      { readOnly: true },
    );
    return { body: ctx.page(result.items, result.next ? { id: result.next } : null) };
  }
}

type VerificationSubmit = {
  verification_type: 'business_identity' | 'address' | 'phone' | 'email' | 'location';
  submitted_document_ids?: string[];
  registration_number?: string;
};

@Injectable()
@Operation('org.verification_submit')
export class OrgVerificationSubmitHandler implements OperationHandler {
  constructor(private readonly media: MediaService) {}

  async handle(ctx: OperationContext<VerificationSubmit>): Promise<OperationResult> {
    const m = member(ctx);
    const docs = ctx.body.submitted_document_ids ?? [];
    // 40 VerificationSubmit (S19): the registration number belongs to the business identity check only.
    if (ctx.body.registration_number !== undefined && ctx.body.verification_type !== 'business_identity')
      failIf([{ pointer: '/registration_number', code: 'conditional_forbidden' }]);
    const row = await ctx.tx(async (scope) => {
      // Private, scanned-clean documents owned by the organization (40 VerificationSubmit).
      await this.media.requireReady(scope, docs, {
        owner: { type: 'organization', id: m.orgId },
        purposes: ['verification_document'],
        pointer: '/submitted_document_ids',
      });
      const v = await scope.db
        .insertInto('organization.organization_verifications')
        .values({
          organization_id: m.orgId,
          verification_type: ctx.body.verification_type,
          submitted_document_ids: docs,
          registration_number: ctx.body.registration_number ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      // 52 Organization.verification_status is derived from the checks: a new submission is pending review.
      await scope.db
        .updateTable('organization.organizations')
        .set({ verification_status: 'pending' })
        .where('id', '=', m.orgId)
        .where('verification_status', 'in', ['unverified', 'rejected', 'expired'])
        .execute();
      await writeAudit(scope, {
        action: 'organization.verification_submitted',
        entityType: 'organization_verification',
        entityId: v.id,
        next: v.verification_type,
      });
      return v;
    });
    return created(toVerification(row, null), `/v1/orgs/${m.orgId}/verifications/${row.id}`);
  }
}

type VerificationResubmit = { submitted_document_ids?: string[]; registration_number?: string; note?: string };

/**
 * 40 org.verification_resubmit (backend S19, BR-35 part 2, R-25): the business answers CarPal's open request for more
 * information. The documents join the check's own (at most 10 in all), the request is answered and the check's
 * review clock runs again from where it paused: sla_started_at moves forward by the time CarPal waited.
 */
@Injectable()
@Operation('org.verification_resubmit')
export class OrgVerificationResubmitHandler implements OperationHandler {
  constructor(private readonly media: MediaService) {}

  async handle(ctx: OperationContext<VerificationResubmit>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    if (b.submitted_document_ids === undefined && b.registration_number === undefined && b.note === undefined)
      failIf([{ pointer: '/submitted_document_ids', code: 'conditional_required' }]);
    const added = b.submitted_document_ids ?? [];
    const body = await ctx.tx(async (scope) => {
      const v = await scope.db
        .selectFrom('organization.organization_verifications')
        .selectAll()
        .where('id', '=', ctx.params.verification_id!)
        .where('organization_id', '=', m.orgId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!v) throw new ApiError('NOT_FOUND');
      const open = await scope.db
        .selectFrom('organization.verification_info_requests')
        .selectAll()
        .where('verification_id', '=', v.id)
        .where('status', '=', 'open')
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (v.status !== 'pending' || !open) throw new ApiError('INVALID_TRANSITION', { detail: 'no_open_request' });
      if (b.registration_number !== undefined && v.verification_type !== 'business_identity')
        failIf([{ pointer: '/registration_number', code: 'conditional_forbidden' }]);
      const current = textArray(v.submitted_document_ids);
      const fresh = added.filter((id) => !current.includes(id));
      if (current.length + fresh.length > 10) failIf([{ pointer: '/submitted_document_ids', code: 'too_long', limit: '10' }]);
      await this.media.requireReady(scope, fresh, {
        owner: { type: 'organization', id: m.orgId },
        purposes: ['verification_document'],
        pointer: '/submitted_document_ids',
      });
      const answered = await scope.db
        .updateTable('organization.verification_info_requests')
        .set({
          status: 'answered',
          answered_at: sql<Date>`now()`,
          answered_by: m.userId,
          response_note: b.note ?? null,
          added_document_ids: fresh,
        })
        .where('id', '=', open.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const row = await scope.db
        .updateTable('organization.organization_verifications')
        .set({
          submitted_document_ids: [...current, ...fresh],
          ...(b.registration_number !== undefined ? { registration_number: b.registration_number } : {}),
          // The clock resumes: the paused time is added to its start (the 2-working-day target is counted by the console).
          sla_started_at: sql<Date>`sla_started_at + (now() - coalesce(sla_paused_at, now()))`,
          sla_paused_at: null,
        })
        .where('id', '=', v.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: 'organization.verification_resubmitted',
        entityType: 'organization_verification',
        entityId: v.id,
        previous: `info requested (${textArray(open.missing_items).join(',')})`,
        next: `answered: ${fresh.length} document(s)${b.registration_number !== undefined ? ', registration number' : ''}${b.note ? ', note' : ''}`,
      });
      return toVerification(row, answered);
    });
    return { body };
  }
}
