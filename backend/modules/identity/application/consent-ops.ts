// Consent (40 §6.4, 52 ConsentRecord / ConsentRequest, SEC-AZ-8): records
// are immutable except a single withdrawal (DB trigger); withdrawal takes
// effect on the next read of shared data (the consent gate is never cached)
// and emits consent.withdrawn for modules holding consent-gated copies.
// Backend S15b (DQ-18/DQ-19): a grant names the consent text in force of its
// type and records it; consents under an older text that a re-consent version
// replaced are flagged (and paused when the version says so) until confirmed.
import { Injectable, Optional } from '@nestjs/common';
import { sql, type Selectable } from 'kysely';
import { OrganizationDirectory } from '#libs/authz/index.js';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError } from '#libs/contract/index.js';
import type { ConsentType } from '#libs/contract/generated/enums.js';
import type { DB } from '#libs/db/index.js';
import { Operation, created, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { consumeFailure, LinkTokens } from '#libs/link-tokens/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import { RegionConfigService } from '#libs/region-config/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { AiReferences } from '#modules/ai-mcp/interface/ai.js';
import { MediaService } from '#modules/media/interface/media.js';
import { OrgCards, toOrgSummary, type OrgCard } from '#modules/organization/interface/org-cards.js';
import { toConsentRecord } from '../api/projections.js';
import { ConsentScopes } from '../interface/identity.js';
import { caller } from './common.js';
import { confirmConsents, consentStates, consentTextFor } from './policy-texts.js';

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
type ConsentRow = Selectable<DB['identity.consent_records']>;

async function listConsents(
  ctx: OperationContext<undefined, { consent_type?: string; active?: boolean; limit: number }>,
  subject: { type: 'user' | 'organization'; id: string },
  views: ConsentViews,
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
  return ctx.page(await views.many(ctx, page), rows.length > ctx.query.limit ? { id: page.at(-1)!.id } : null);
}

/** 40 ConsentRecord with the grantee's business (active shares show its name, PWA DI-55) and the re-consent state (S15b). */
@Injectable()
export class ConsentViews {
  constructor(
    private readonly orgCards: OrgCards,
    private readonly region: RegionConfigService,
  ) {}

  async many(ctx: OperationContext, rows: ConsentRow[]) {
    const ids = rows.filter((r) => r.granted_to_type === 'organization' && r.granted_to_id).map((r) => r.granted_to_id!);
    const [cards, states] = await ctx.tx(
      async (scope) =>
        [
          ids.length ? await this.orgCards.cards(scope, ids) : new Map<string, OrgCard>(),
          await consentStates(
            scope,
            this.region.regionKey,
            rows.map((r) => r.id),
          ),
        ] as const,
      { readOnly: true },
    );
    return rows.map((r) => toConsentRecord(r, cards, states.get(r.id)));
  }

  async one(ctx: OperationContext, row: ConsentRow) {
    return (await this.many(ctx, [row]))[0]!;
  }
}

/** What a withdrawn consent turns off (52 UserPreference: these need the active consent). */
const PREFERENCES_OF_CONSENT: Partial<Record<string, Record<string, boolean | string>>> = {
  ai_personalization: { ai_personalization_enabled: false, ai_help_me_personalised: false, ai_personalised_matching: false },
  marketing: { marketing_opt_in: false },
  review_invitations: { review_invitation_channel: 'in_app' },
};

@Injectable()
export class ConsentWriter {
  constructor(
    private readonly scopes: ConsentScopes,
    private readonly orgs: OrganizationDirectory,
    private readonly region: RegionConfigService,
    // Absent on the auth server (no ai-mcp module there): MCP clients cannot be named.
    @Optional() private readonly ai?: AiReferences,
  ) {}

  /**
   * Validates a ConsentGrant (C: id unless platform; SEC-AZ-4 references; S15b: policy_version is the consent text in
   * force of the type, 409 POLICY_VERSION_OUTDATED) and inserts the record with the text it refers to.
   */
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
    // An internal MCP client of the registry (ai-mcp, S9), active in this environment.
    if (g.granted_to?.type === 'mcp_client' && !(await this.ai?.activeMcpClient(g.granted_to.id!)))
      throw ApiError.validation([{ pointer: '/granted_to/id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
    if (g.scope) {
      const verify = this.scopes.get(g.scope.type);
      if (!verify || !(await verify(scope, actingUserId, g.scope.id)))
        throw ApiError.validation([{ pointer: '/scope/id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
    }
    const textId = await consentTextFor(scope, this.region.regionKey, g.consent_type, g.policy_version);
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
        policy_version_id: textId,
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
      const off = PREFERENCES_OF_CONSENT[c.consent_type];
      if (off) await scope.db.updateTable('identity.user_preferences').set(off).where('user_id', '=', subject.id).execute();
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
  constructor(private readonly views: ConsentViews) {}

  async handle(ctx: OperationContext<undefined, { consent_type?: string; active?: boolean; limit: number }>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    return { body: await listConsents(ctx, { type: 'user', id: userId }, this.views) };
  }
}

@Injectable()
@Operation('consents.grant')
export class ConsentsGrantHandler implements OperationHandler {
  constructor(
    private readonly writer: ConsentWriter,
    private readonly views: ConsentViews,
  ) {}

  async handle(ctx: OperationContext<ConsentGrant>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    if (ORG_CONSENTS.includes(ctx.body.consent_type)) throw ApiError.validation([{ pointer: '/consent_type', code: 'enum' }]);
    const row = await ctx.tx(async (scope) => {
      const r = await this.writer.grant(scope, { type: 'user', id: userId }, ctx.body, userId);
      await writeAudit(scope, { action: 'consent.granted', entityType: 'consent_record', entityId: r.id, next: r.consent_type });
      return r;
    });
    return created(await this.views.one(ctx, row), `/v1/me/consents/${row.id}`);
  }
}

@Injectable()
@Operation('consents.withdraw')
export class ConsentsWithdrawHandler implements OperationHandler {
  constructor(
    private readonly writer: ConsentWriter,
    private readonly views: ConsentViews,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const row = await ctx.tx((scope) => this.writer.withdraw(scope, { type: 'user', id: userId }, ctx.params.consent_id!));
    return { body: await this.views.one(ctx, row) };
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
    private readonly media: MediaService,
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
          preview_media_urls: await this.#previewUrls(scope, req.scope_entity_type, req.scope_entity_id),
          expires_at: new Date(req.expires_at).toISOString(),
        };
      },
      { readOnly: true },
    );
    return { body };
  }

  /**
   * The exact photos the subject is asked about (W-REV-02, C-REV-03): the clean, active images attached to the
   * portfolio item, as private 5-minute URLs. The caller was checked as the request's subject above, which is the
   * relationship sharedAttachmentViews needs (the item itself stays private until it is published).
   */
  async #previewUrls(scope: TxScope, type: string | null, id: string | null): Promise<string[]> {
    if (type !== 'portfolio_item' || !id) return [];
    const views = (await this.media.sharedAttachmentViews(scope, 'portfolio_item', [id])).get(id) ?? [];
    return views
      .filter((v) => v.media_type === 'image')
      .map((v) => v.url ?? v.thumbnail_url)
      .filter((u): u is string => !!u)
      .slice(0, 10);
  }
}

@Injectable()
@Operation('consents.request_respond')
export class ConsentRequestRespondHandler implements OperationHandler {
  constructor(
    private readonly links: LinkTokens,
    private readonly views: ConsentViews,
    private readonly region: RegionConfigService,
  ) {}

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
        const textId = await consentTextFor(scope, this.region.regionKey, req.consent_type as ConsentType, ctx.body.policy_version);
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
            policy_version_id: textId,
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
    return { body: { consent: consent ? await this.views.one(ctx, consent) : null } };
  }
}

@Injectable()
@Operation('org.consents_list')
export class OrgConsentsListHandler implements OperationHandler {
  constructor(private readonly views: ConsentViews) {}

  async handle(ctx: OperationContext<undefined, { consent_type?: string; limit: number }>): Promise<OperationResult> {
    return { body: await listConsents(ctx, { type: 'organization', id: ctx.access.org!.id }, this.views) };
  }
}

@Injectable()
@Operation('org.consents_grant')
export class OrgConsentsGrantHandler implements OperationHandler {
  constructor(
    private readonly writer: ConsentWriter,
    private readonly views: ConsentViews,
  ) {}

  async handle(ctx: OperationContext<ConsentGrant>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const orgId = ctx.access.org!.id;
    if (!ORG_CONSENTS.includes(ctx.body.consent_type)) throw ApiError.validation([{ pointer: '/consent_type', code: 'enum' }]);
    const row = await ctx.tx(async (scope) => {
      const r = await this.writer.grant(scope, { type: 'organization', id: orgId }, ctx.body, userId);
      await writeAudit(scope, { action: 'consent.granted', entityType: 'consent_record', entityId: r.id, next: r.consent_type });
      return r;
    });
    return created(await this.views.one(ctx, row), `/v1/orgs/${orgId}/consents/${row.id}`);
  }
}

@Injectable()
@Operation('org.consents_withdraw')
export class OrgConsentsWithdrawHandler implements OperationHandler {
  constructor(
    private readonly writer: ConsentWriter,
    private readonly views: ConsentViews,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const row = await ctx.tx((scope) =>
      this.writer.withdraw(scope, { type: 'organization', id: ctx.access.org!.id }, ctx.params.consent_id!),
    );
    return { body: await this.views.one(ctx, row) };
  }
}

/**
 * S15b.T3: the organization owner confirms one organization consent under the consent text in force after a
 * re-consent version (ConsentRecord.reconsent_required); a consent already on that text is returned unchanged.
 */
@Injectable()
@Operation('org.consents_confirm')
export class OrgConsentsConfirmHandler implements OperationHandler {
  constructor(
    private readonly views: ConsentViews,
    private readonly region: RegionConfigService,
  ) {}

  async handle(ctx: OperationContext<{ policy_version: string }>): Promise<OperationResult> {
    const { userId } = caller(ctx);
    const orgId = ctx.access.org!.id;
    const row = await ctx.tx(async (scope) => {
      const c = await scope.db
        .selectFrom('identity.consent_records')
        .selectAll()
        .where('id', '=', ctx.params.consent_id!)
        .where('subject_type', '=', 'organization')
        .where('subject_id', '=', orgId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!c) throw new ApiError('NOT_FOUND');
      if (!c.granted || c.withdrawn_at || (c.expires_at && c.expires_at.getTime() <= Date.now()))
        throw new ApiError('INVALID_TRANSITION', { detail: 'consent not active' });
      const done = await confirmConsents(scope, this.region.regionKey, {
        subject: { type: 'organization', id: orgId },
        consentType: c.consent_type as ConsentType,
        policyVersion: ctx.body.policy_version,
        consentId: c.id,
        by: userId,
      });
      // Already on the text in force: nothing changes, and the request is audited like policy.accept.
      if (done.confirmed.length === 0)
        await writeAudit(scope, {
          action: 'consent.confirmed',
          entityType: 'consent_record',
          entityId: c.id,
          next: `${c.consent_type} ${done.version.policy_version} (${this.region.regionKey}); already on this text`,
        });
      return c;
    });
    return { body: await this.views.one(ctx, row) };
  }
}
