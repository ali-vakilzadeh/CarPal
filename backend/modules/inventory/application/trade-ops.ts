// Trade accounts (40 §13.2-13.3, 52 VendorTradeAccount): a provider or fleet
// organization asks a published vendor that supports trade customers; the
// vendor's owner approves, rejects or revokes (AUD). Only approved trade
// customers see trade-only items and trade prices (RLS trade_read,
// SEC-OUT-1). One account per vendor and customer.
import { Injectable } from '@nestjs/common';
import { writeAudit } from '#libs/audit/index.js';
import { ApiError } from '#libs/contract/index.js';
import { created, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { OrgCards, toOrgSummary } from '#modules/organization/interface/org-cards.js';
import { PublicProfiles } from '#modules/organization/interface/public-profiles.js';
import { toTradeAccount, type TradeRow } from '../api/projections.js';
import { tradeDecision, type TradeDecision } from '../domain/rules.js';
import { afterId, vendorMember } from './common.js';

@Injectable()
export class TradeViews {
  constructor(private readonly orgs: OrgCards) {}

  async many(scope: TxScope, rows: readonly TradeRow[]) {
    const cards = await this.orgs.cards(
      scope,
      rows.flatMap((r) => [r.vendor_organization_id, r.trade_customer_organization_id]),
    );
    const summary = (id: string) => {
      const c = cards.get(id);
      if (!c) throw new ApiError('INTERNAL', { detail: `organization card ${id} missing` });
      return toOrgSummary(c);
    };
    return rows.map((r) => toTradeAccount(r, summary(r.vendor_organization_id), summary(r.trade_customer_organization_id)));
  }
}

async function listTrades(
  ctx: OperationContext<undefined, { status?: string; limit: number }>,
  views: TradeViews,
  side: 'vendor_organization_id' | 'trade_customer_organization_id',
) {
  const m = vendorMember(ctx);
  const after = afterId(ctx);
  return ctx.tx(
    async (scope) => {
      let q = scope.db.selectFrom('inventory.vendor_trade_accounts').selectAll().where(side, '=', m.orgId).where('deleted_at', 'is', null);
      if (ctx.query.status) q = q.where('status', '=', ctx.query.status);
      if (after) q = q.where('id', '<', after);
      const rows = await q
        .orderBy('id', 'desc')
        .limit(ctx.query.limit + 1)
        .execute();
      const page = rows.slice(0, ctx.query.limit);
      return ctx.page(await views.many(scope, page), rows.length > ctx.query.limit ? { id: page.at(-1)!.id } : null);
    },
    { readOnly: true },
  );
}

@Injectable()
@Operation('trade_accounts.vendor_list')
export class TradeAccountsVendorListHandler implements OperationHandler {
  constructor(private readonly views: TradeViews) {}

  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    return { body: await listTrades(ctx, this.views, 'vendor_organization_id') };
  }
}

@Injectable()
@Operation('trade_accounts.customer_list')
export class TradeAccountsCustomerListHandler implements OperationHandler {
  constructor(private readonly views: TradeViews) {}

  async handle(ctx: OperationContext<undefined, { status?: string; limit: number }>): Promise<OperationResult> {
    return { body: await listTrades(ctx, this.views, 'trade_customer_organization_id') };
  }
}

@Injectable()
@Operation('trade_accounts.vendor_decide')
export class TradeAccountsVendorDecideHandler implements OperationHandler {
  constructor(private readonly views: TradeViews) {}

  async handle(ctx: OperationContext<{ decision: TradeDecision; notes?: string }>): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      const t = await scope.db
        .selectFrom('inventory.vendor_trade_accounts')
        .selectAll()
        .where('id', '=', ctx.params.trade_account_id!)
        .where('vendor_organization_id', '=', m.orgId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!t) throw new ApiError('NOT_FOUND');
      const next = tradeDecision(t.status, b.decision);
      if (!next) throw new ApiError('INVALID_TRANSITION', { detail: `${t.status} -> ${b.decision}` });
      const row = await scope.db
        .updateTable('inventory.vendor_trade_accounts')
        .set({
          status: next,
          ...(next === 'approved' ? { approved_by: m.userId, approved_at: new Date() } : {}),
          ...(b.notes !== undefined ? { notes: b.notes } : {}),
        })
        .where('id', '=', t.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(scope, {
        action: `inventory.trade_account_${next}`,
        entityType: 'vendor_trade_account',
        entityId: t.id,
        previous: t.status,
        next,
      });
      return (await this.views.many(scope, [row]))[0]!;
    });
    return { body };
  }
}

@Injectable()
@Operation('trade_accounts.request')
export class TradeAccountsRequestHandler implements OperationHandler {
  constructor(
    private readonly profiles: PublicProfiles,
    private readonly views: TradeViews,
  ) {}

  async handle(ctx: OperationContext<{ vendor_organization_id: string; notes?: string }>): Promise<OperationResult> {
    const m = vendorMember(ctx);
    const b = ctx.body;
    const body = await ctx.tx(async (scope) => {
      // A published vendor that accepts trade customers, and not the requester itself (hybrid organizations).
      const vendor = (await this.profiles.vendors(scope, [b.vendor_organization_id])).get(b.vendor_organization_id);
      if (!vendor?.tradeCustomersSupported || b.vendor_organization_id === m.orgId)
        throw ApiError.validation([{ pointer: '/vendor_organization_id', code: 'reference_not_found' }], 'REFERENCE_NOT_FOUND');
      const existing = await scope.db
        .selectFrom('inventory.vendor_trade_accounts')
        .select('id')
        .where('vendor_organization_id', '=', b.vendor_organization_id)
        .where('trade_customer_organization_id', '=', m.orgId)
        .executeTakeFirst();
      // UNIQUE (vendor, customer): a parallel request ends in the same 409 through the unique violation.
      if (existing) throw new ApiError('DUPLICATE', { detail: 'trade account exists' });
      const row = await scope.db
        .insertInto('inventory.vendor_trade_accounts')
        .values({
          vendor_organization_id: b.vendor_organization_id,
          trade_customer_organization_id: m.orgId,
          status: 'requested',
          notes: b.notes ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return (await this.views.many(scope, [row]))[0]!;
    });
    return created(body, `/v1/orgs/${m.orgId}/trade-accounts`);
  }
}
