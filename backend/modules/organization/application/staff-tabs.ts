// Organization tabs on the admin plane (backend S23, admin console BR-16, DI-06; 40 §23.2): admin.org_capabilities
// (A-ORG-02 Capabilities & badges), admin.org_portfolio (Portfolio) and admin.org_members (Members). Each is PURP: the
// purpose is bound to the organization in the path (S14). Portfolio and members carry personal data (customer display
// names, member names and emails) and write their pii.read entry; capabilities and badges are business data.
import { Injectable, Optional } from '@nestjs/common';
import { ApiError } from '#libs/contract/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { auditStaffRead, ModerationLog, staffOf } from '#modules/admin/interface/admin.js';
import { authorDisplayName, ConsentGrants, OrgMemberships, UserCards } from '#modules/identity/interface/identity.js';
import { TrustAdmin } from '#modules/trust/interface/trust.js';
import { toCapability, toOrgMember } from '../api/projections.js';
import { afterId } from './common.js';
import { PortfolioRules } from './provider-work-ops.js';

const MAX_CAPABILITIES = 500;
const MAX_BADGES = 100;

/** The organization named in the path must exist (404 otherwise). */
async function requireOrg(scope: TxScope, id: string): Promise<void> {
  const o = await scope.db
    .selectFrom('organization.organizations')
    .select('id')
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!o) throw new ApiError('NOT_FOUND');
}

/** 40 ShowcaseConsent (S18, BR-33): the customer's consent record of a showcase, by display name only. */
export async function showcaseConsentView(
  scope: TxScope,
  consents: ConsentGrants | undefined,
  users: UserCards | undefined,
  consentId: string | null,
  locale: string,
) {
  const c = consentId ? await consents?.record(scope, consentId) : null;
  if (!c) return null;
  const card = c.subjectType === 'user' ? (await users?.cards(scope, [c.subjectId]))?.get(c.subjectId) : undefined;
  return {
    customer_display_name: authorDisplayName(card, locale),
    consent_type: c.consentType,
    scope: c.scope,
    granted: c.granted,
    granted_at: c.grantedAt ? c.grantedAt.toISOString() : null,
    withdrawn_at: c.withdrawnAt ? c.withdrawnAt.toISOString() : null,
    expires_at: c.expiresAt ? c.expiresAt.toISOString() : null,
  };
}

/** 40 admin.org_capabilities: the capability matrix (strongest first) and the badges with their rule evaluation. */
@Injectable()
@Operation('admin.org_capabilities')
export class AdminOrgCapabilitiesHandler implements OperationHandler {
  constructor(private readonly trust: TrustAdmin) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    staffOf(ctx);
    const orgId = ctx.params.org_id!;
    const body = await ctx.tx(
      async (scope) => {
        await requireOrg(scope, orgId);
        const live = scope.db
          .selectFrom('organization.provider_capabilities')
          .where('provider_organization_id', '=', orgId)
          .where('deleted_at', 'is', null);
        const [rows, total, badges] = await Promise.all([
          live.selectAll().orderBy('confidence_score', 'desc').orderBy('id').limit(MAX_CAPABILITIES).execute(),
          live.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
          this.trust.badges(scope, orgId, MAX_BADGES),
        ]);
        return { capabilities: rows.map(toCapability), capabilities_total: Number(total.n), badges };
      },
      { readOnly: true },
    );
    return { body };
  }
}

/** 40 admin.org_portfolio: showcases newest first, with the customer's consent record and open cases. */
@Injectable()
@Operation('admin.org_portfolio')
export class AdminOrgPortfolioHandler implements OperationHandler {
  constructor(
    private readonly rules: PortfolioRules,
    private readonly moderation: ModerationLog,
    @Optional() private readonly consents?: ConsentGrants,
    @Optional() private readonly users?: UserCards,
  ) {}

  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const orgId = ctx.params.org_id!;
    const after = afterId(ctx);
    const body = await ctx.tx(async (scope) => {
      await requireOrg(scope, orgId);
      // The customers' consent records name them (display name only): a staff read of personal data (SEC-LOG-4).
      await auditStaffRead(scope, s, 'organization', orgId, 'portfolio with customer consents');
      let q = scope.db
        .selectFrom('organization.portfolio_items')
        .selectAll()
        .where('provider_organization_id', '=', orgId)
        .where('deleted_at', 'is', null);
      if (ctx.query.status) q = q.where('status', '=', ctx.query.status as never);
      if (after) q = q.where('id', '<', after);
      const rows = await q
        .orderBy('id', 'desc')
        .limit(ctx.query.limit + 1)
        .execute();
      const page = rows.slice(0, ctx.query.limit);
      const views = await this.rules.view(scope, page);
      const items = [];
      for (const [i, p] of page.entries()) {
        items.push({
          ...views[i]!,
          consent: await showcaseConsentView(scope, this.consents, this.users, p.consent_reference_id, ctx.locale),
          open_cases: await this.moderation.openCases(scope, 'portfolio_item', p.id),
        });
      }
      return ctx.page(items, rows.length > ctx.query.limit ? { id: page.at(-1)!.id } : null);
    });
    return { body };
  }
}

/** 40 admin.org_members: members and pending invitations as org.members_list shows them. */
@Injectable()
@Operation('admin.org_members')
export class AdminOrgMembersHandler implements OperationHandler {
  constructor(private readonly memberships: OrgMemberships) {}

  async handle(ctx: OperationContext<undefined, { role?: string; status?: string; limit: number }>): Promise<OperationResult> {
    const s = staffOf(ctx);
    const orgId = ctx.params.org_id!;
    const after = afterId(ctx);
    const rows = await ctx.tx(async (scope) => {
      await requireOrg(scope, orgId);
      await auditStaffRead(scope, s, 'organization', orgId, 'members and invitations');
      return this.memberships.list(scope, orgId, {
        ...(ctx.query.role ? { role: ctx.query.role } : {}),
        ...(ctx.query.status ? { status: ctx.query.status } : {}),
        ...(after ? { afterId: after } : {}),
        limit: ctx.query.limit + 1,
      });
    });
    const page = rows.slice(0, ctx.query.limit);
    return { body: ctx.page(page.map(toOrgMember), rows.length > ctx.query.limit ? { id: page.at(-1)!.membershipId } : null) };
  }
}
