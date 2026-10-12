// Consent (40 §6.4, 52 ConsentRecord / ConsentRequest, SEC-AZ-8): records
// are immutable except a single withdrawal (DB trigger); withdrawal takes
// effect on the next read of shared data (the consent gate is never cached)
// and emits consent.withdrawn for modules holding consent-gated copies.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { OrganizationDirectory } from '#libs/authz/index.js';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError } from '#libs/contract/index.js';
import type { ConsentType } from '#libs/contract/generated/enums.js';
import { Operation, created, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { consumeFailure, LinkTokens } from '#libs/link-tokens/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { OrgCards, toOrgSummary } from '#modules/organization/interface/org-cards.js';
import { toConsentRecord } from '../api/projections.js';
import { ConsentScopes } from '../interface/identity.js';
import { caller } from './common.js';

/** Consent types an organization grants (52 ConsentRecord, DB check). */
const ORG_CONSENTS: ConsentType[] = ['fleet_data_ai_use', 'provider_analytics_ai_use', 'vendor_inventory_ai_use'];

type ConsentGrant = {
  consent_type: ConsentType;
  policy_version: string;
  scope?: { type: string; id: string };
  granted_to?: { type: 'organization' | 'platform' | 'mcp_client'; id?: string };
  expires_at?: string;
};

type Position = { id?: string } | undefined;

async function listConsents(
  ctx: OperationContext<undefined, { consent_type?: string; active?: boolean; limit: number }>,
  subject: { type: 'user' | 'organization'; id: string },
) {
  const after = (ctx.cursor as Position)?.id;
  const rows = await ctx.tx(
    async (scope) => {
      let q = scope.db
        .selectFrom('identity.consent_records')
        .selectAll()
        .where('subject_type', '=', subject.type)
        .where('subject_id', '=', subject.id)
        .where('deleted_at', 'is', null);
      if (ctx.query.consent_type) q = q.where('consent_type', '=', ctx.query.consent_type);
      if (ctx.query.active === true)
        q = q
          .where('granted', '=', true)
          .where('withdrawn_at', 'is', null)
          .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]));
      if (ctx.query.active === false)
        q = q.where((eb) =>
          eb.or([eb('granted', '=', false), eb('withdrawn_at', 'is not', null), eb('expires_at', '<=', sql<Date>`now()`)]),
        );
      if (after) q = q.where('id', '<', after);
      return q
        .orderBy('id', 'desc')
        .limit(ctx.query.limit + 1)
        .execute();
    },
    { readOnly: true },
  );
  const page = rows.slice(0, ctx.query.limit);
  return ctx.page(page.map(toConsentRecord), rows.length > ctx.query.limit ? { id: page.at(-1)!.id } : null);
}

@Injectable()
export class ConsentWriter {
  constructor(
    private readonly scopes: ConsentScopes,
    private readonly orgs: OrganizationDirectory,
  ) {}

  /** Validates a ConsentGrant (C: id unless platform; SEC-AZ-4 references) and inserts the record. */
  async grant(scope: TxScope, subject: { type: 'user' | 'organization'; id: string }, g: ConsentGrant, actingUserId: string) {
    if (g.granted_to && g.granted_to.type !== 'platform' && !g.granted_to.id)
      throw ApiError.validation([{ pointer: '/granted_to/id', code: 'conditional_required' }]);
    if (g.granted_to?.type === 'platform' && g.granted_to.id)
      throw ApiError.validation([{ pointer: '/granted_to/id', code: 'conditional_forbidden' }]);
    if (g.expires_at && new Date(g.expires_at).getTime() <= Date.now())
      throw ApiError.validation([{ pointer: '/expires_at', code: 'in_past' }]);
    if (g.granted_to?.type === 'organization') {
      const org = await this.orgs.get(g.granted_to.id!);
      if (!org || org.status === 'merged' || org.status === 'archived')
        throw ApiError.validation([{ pointer: '/granted_to/id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
    }
    // MCP clients are registered on the admin plane (S8/S9); until then none can be named.
    if (g.granted_to?.type === 'mcp_client')
      throw ApiError.validation([{ pointer: '/granted_to/id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
    if (g.scope) {
      const verify = this.scopes.get(g.scope.type);
      if (!verify || !(await verify(scope, actingUserId, g.scope.id)))
        throw ApiError.validation([{ pointer: '/scope/id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
    }
    return scope.db
      .insertInto('identity.consent_records')
      .values({
        subject_type: subject.type,
        subject_id: subject.id,
        consent_type: g.consent_type,
        scope_entity_type: g.scope?.type ?? null,
        scope_entity_id: g.scope?.id ?? null,
        granted_to_type: g.granted_to?.type ?? null,
        granted_to_id: g.granted_to?.id ?? null,
        policy_version: g.policy_version,
        granted: true,
        granted_at: sql`now()`,
        expires_at: g.expires_at ? new Date(g.expires_at) : null,
        source: 'ui',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** One-time withdrawal; preferences that depend on the consent are switched off; consent.withdrawn. */
  async withdraw(scope: TxScope, subject: { type: 'user' | 'organization'; id: string }, consentId: string) {
    const c = await scope.db
      .selectFrom('identity.consent_records')
      .selectAll()
      .where('id', '=', consentId)
      .where('subject_type', '=', subject.type)
      .where('subject_id', '=', subject.id)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!c) throw new ApiError('NOT_FOUND');
    if (!c.granted || c.withdrawn_at) throw new ApiError('INVALID_TRANSITION', { detail: 'consent not active' });
    const row = await scope.db
      .updateTable('identity.consent_records')
      .set({ withdrawn_at: sql`now()` })
      .where('id', '=', c.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (subject.type === 'user') {
      const pref =
        c.consent_type === 'ai_personalization' ? 'ai_personalization_enabled' : c.consent_type === 'marketing' ? 'marketing_opt_in' : null;
      if (pref)
        await scope.db
          .updateTable('identity.user_preferences')
          .set({ [pref]: false })
          .where('user_id', '=', subject.id)
          .execute();
    }
    await publishEvent(scope, {
      type: 'consent.withdrawn',
      aggregateType: 'consent_record',
      aggregateId: c.id,
      payload: {
        consent_type: c.consent_type,
        subject_type: c.subject_type,
        subject_id: c.subject_id,
        scope_entity_type: c.scope_entity_type,
        scope_entity_id: c.scope_entity_id,
        granted_to_type: c.granted_to_type,
        granted_to_id: c.granted_to_id,
      },
    });
    await writeAudit(scope, { action: 'consent.withdrawn', entityType: 'consent_record', entityId: c.id, previous: c.consent_type });
    return row;
  }
}

@Injectable()
@Operation('consents.list')
export class ConsentsListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { consent_type?: string; active?: boolean; limit: number }>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    return { body: await listConsents(ctx, { type: 'user', id: userId }) };
  }
}

@Injectable()
@Operation('consents.grant')
export class ConsentsGrantHandler implements OperationHandler {
  constructor(private readonly writer: ConsentWriter) {}

  async handle(ctx: OperationContext<ConsentGrant>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    if (ORG_CONSENTS.includes(ctx.body.consent_type)) throw ApiError.validation([{ pointer: '/consent_type', code: 'enum' }]);
    const row = await ctx.tx(async (scope) => {
      const r = await this.writer.grant(scope, { type: 'user', id: userId }, ctx.body, userId);
      await writeAudit(scope, { action: 'consent.granted', entityType: 'consent_record', entityId: r.id, next: r.consent_type });
      return r;
    });
    return created(toConsentRecord(row), `/v1/me/consents/${row.id}`);
  }
}

@Injectable()
@Operation('consents.withdraw')
export class ConsentsWithdrawHandler implements OperationHandler {
  constructor(private readonly writer: ConsentWriter) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const row = await ctx.tx((scope) => this.writer.withdraw(scope, { type: 'user', id: userId }, ctx.params.consent_id!));
    return { body: toConsentRecord(row) };
  }
}

/**
 * A cn link (SEC-LT): unknown or expired → 410 LINK_EXPIRED; another
 * person's → 403 LINK_RECIPIENT_MISMATCH (SEC-LT-5, via the definer lookup,
 * since RLS hides other people's requests).
 */
async function consentRequestFor(scope: TxScope, links: LinkTokens, token: unknown, userId: string) {
  const { hash } = links.parse(token, 'cn');
  const { rows } = await sql<{ id: string; subject_user_id: string; status: string; expires_at: Date; used_at: Date | null }>`
    SELECT id, subject_user_id, status, expires_at, used_at FROM identity.consent_request_by_token(${hash})`.execute(scope.db);
  const r = rows[0];
  if (!r) throw new ApiError('LINK_EXPIRED');
  if (r.subject_user_id !== userId) throw new ApiError('LINK_RECIPIENT_MISMATCH');
  return r;
}

@Injectable()
@Operation('consents.request_view')
export class ConsentRequestViewHandler implements OperationHandler {
  constructor(
    private readonly links: LinkTokens,
    private readonly orgCards: OrgCards,
  ) {}

  async handle(ctx: OperationContext<{ token: string }>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const body = await ctx.tx(
      async (scope) => {
        const r = await consentRequestFor(scope, this.links, ctx.body.token, userId);
        // Viewing does not consume the link; a used, declined or expired request is no longer viewable.
        if (r.status !== 'pending' || r.used_at || new Date(r.expires_at).getTime() <= Date.now()) throw new ApiError('LINK_EXPIRED');
        const req = await scope.db.selectFrom('identity.consent_requests').selectAll().where('id', '=', r.id).executeTakeFirstOrThrow();
        const org = (await this.orgCards.cards(scope, [req.requested_by_organization_id])).get(req.requested_by_organization_id);
        if (!org) throw new ApiError('LINK_EXPIRED');
        return {
          consent_type: req.consent_type,
          requested_by: toOrgSummary(org),
          scope: { type: req.scope_entity_type, id: req.scope_entity_id },
          purpose_i18n_key: req.purpose_i18n_key,
          // Preview media come from the media module (S4); none until then.
          preview_media_urls: [],
          expires_at: new Date(req.expires_at).toISOString(),
        };
      },
      { readOnly: true },
    );
    return { body };
  }
}

@Injectable()
@Operation('consents.request_respond')
export class ConsentRequestRespondHandler implements OperationHandler {
  constructor(private readonly links: LinkTokens) {}

  async handle(ctx: OperationContext<{ token: string; decision: 'grant' | 'decline'; policy_version: string }>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const consent = await ctx.tx(async (scope) => {
      const r = await consentRequestFor(scope, this.links, ctx.body.token, userId);
      // Atomic single use (SEC-IC-5): only a pending, unused, unexpired request changes.
      const req = await scope.db
        .selectFrom('identity.consent_requests')
        .selectAll()
        .where('id', '=', r.id)
        .where('status', '=', 'pending')
        .where('used_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .forUpdate()
        .executeTakeFirst();
      // Used (granted or declined) → LINK_USED; expired or cancelled → LINK_EXPIRED.
      if (!req) throw consumeFailure({ used_at: r.used_at });
      let record = null;
      if (ctx.body.decision === 'grant') {
        record = await scope.db
          .insertInto('identity.consent_records')
          .values({
            subject_type: 'user',
            subject_id: userId,
            consent_type: req.consent_type,
            scope_entity_type: req.scope_entity_type,
            scope_entity_id: req.scope_entity_id,
            granted_to_type: 'organization',
            granted_to_id: req.requested_by_organization_id,
            policy_version: ctx.body.policy_version,
            granted: true,
            granted_at: sql`now()`,
            source: 'ui',
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      await scope.db
        .updateTable('identity.consent_requests')
        .set({ status: record ? 'granted' : 'declined', used_at: sql`now()`, resulting_consent_id: record?.id ?? null })
        .where('id', '=', req.id)
        .execute();
      await writeAudit(scope, {
        action: record ? 'consent.request_granted' : 'consent.request_declined',
        entityType: 'consent_request',
        entityId: req.id,
        next: req.consent_type,
      });
      return record;
    });
    return { body: { consent: consent ? toConsentRecord(consent) : null } };
  }
}

@Injectable()
@Operation('org.consents_list')
export class OrgConsentsListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { consent_type?: string; limit: number }>): Promise<OperationResult> {
    return { body: await listConsents(ctx, { type: 'organization', id: ctx.access.org!.id }) };
  }
}

@Injectable()
@Operation('org.consents_grant')
export class OrgConsentsGrantHandler implements OperationHandler {
  constructor(private readonly writer: ConsentWriter) {}

  async handle(ctx: OperationContext<ConsentGrant>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const orgId = ctx.access.org!.id;
    if (!ORG_CONSENTS.includes(ctx.body.consent_type)) throw ApiError.validation([{ pointer: '/consent_type', code: 'enum' }]);
    const row = await ctx.tx(async (scope) => {
      const r = await this.writer.grant(scope, { type: 'organization', id: orgId }, ctx.body, userId);
      await writeAudit(scope, { action: 'consent.granted', entityType: 'consent_record', entityId: r.id, next: r.consent_type });
      return r;
    });
    return created(toConsentRecord(row), `/v1/orgs/${orgId}/consents/${row.id}`);
  }
}

@Injectable()
@Operation('org.consents_withdraw')
export class OrgConsentsWithdrawHandler implements OperationHandler {
  constructor(private readonly writer: ConsentWriter) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const row = await ctx.tx((scope) =>
      this.writer.withdraw(scope, { type: 'organization', id: ctx.access.org!.id }, ctx.params.consent_id!),
    );
    return { body: toConsentRecord(row) };
  }
}
