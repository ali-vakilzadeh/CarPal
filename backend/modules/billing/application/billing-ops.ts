// Billing operations (40 §10.2): plans.list, subscription.me_get,
// subscription.org_get, subscription.change_request.
import { Injectable } from '@nestjs/common';
import { ApiError } from '#libs/contract/index.js';
import type { OrgType } from '#libs/contract/generated/enums.js';
import { registerConstraintErrors } from '#libs/db/index.js';
import { ACK, Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import { toPlan, toSubscription } from '../api/projections.js';
import type { PlanKey, Subscriber } from '../interface/billing.js';
import { currentSubscription, loadPlans } from '../infrastructure/subscription-store.js';
import { SubscriptionService } from './subscriptions.js';

registerConstraintErrors({ subscription_change_requests_open_uq: 'DUPLICATE' });

/** Plan audiences an organization type may subscribe to. */
const AUDIENCES: Record<OrgType, string[]> = {
  provider: ['provider'],
  vendor: ['vendor'],
  fleet: ['fleet'],
  hybrid_provider_vendor: ['provider', 'vendor'],
};

@Injectable()
@Operation('plans.list')
export class PlansListHandler implements OperationHandler {
  async handle(ctx: OperationContext<undefined, { audience?: string }>): Promise<OperationResult> {
    const plans = await ctx.tx((scope) => loadPlans(scope, ctx.query.audience ? { audience: ctx.query.audience } : {}), { readOnly: true });
    // Nine plans at most: one page.
    return { body: ctx.page(plans.map(toPlan), null), cache: { public: 600 } };
  }
}

async function subscriptionBody(ctx: OperationContext, service: SubscriptionService, s: Subscriber) {
  return ctx.tx(async (scope) => {
    const v = await service.view(scope, s);
    if (!v) throw new ApiError('NOT_FOUND', { detail: 'no current subscription' });
    return toSubscription(v.sub, v.plan, v.effective, await service.usage(scope, s));
  });
}

@Injectable()
@Operation('subscription.me_get')
export class SubscriptionMeGetHandler implements OperationHandler {
  constructor(private readonly service: SubscriptionService) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    if (ctx.principal.kind !== 'user') throw new ApiError('NOT_FOUND');
    return { body: await subscriptionBody(ctx, this.service, { type: 'user', id: ctx.principal.userId }) };
  }
}

@Injectable()
@Operation('subscription.org_get')
export class SubscriptionOrgGetHandler implements OperationHandler {
  constructor(private readonly service: SubscriptionService) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    return { body: await subscriptionBody(ctx, this.service, { type: 'organization', id: ctx.access.org!.id }) };
  }
}

@Injectable()
@Operation('subscription.change_request')
export class SubscriptionChangeRequestHandler implements OperationHandler {
  async handle(ctx: OperationContext<{ plan_key: PlanKey; note?: string }>): Promise<OperationResult> {
    if (ctx.principal.kind !== 'user') throw new ApiError('NOT_FOUND');
    const userId = ctx.principal.userId;
    const org = ctx.access.org!;
    await ctx.tx(async (scope) => {
      const plan = await scope.db
        .selectFrom('billing.plans')
        .select(['id', 'audience'])
        .where('plan_key', '=', ctx.body.plan_key)
        .where('status', '=', 'active')
        .executeTakeFirst();
      // The plan's audience must match the organization (52 SubscriptionChangeRequest).
      if (!plan || !AUDIENCES[org.type].includes(plan.audience)) throw ApiError.validation([{ pointer: '/plan_key', code: 'enum' }]);
      const current = await currentSubscription(scope, { type: 'organization', id: org.id });
      await scope.db
        .insertInto('billing.subscription_change_requests')
        .values({
          organization_id: org.id,
          requested_by_user_id: userId,
          current_subscription_id: current?.id ?? null,
          requested_plan_id: plan.id,
          note: ctx.body.note ?? null,
        })
        .execute();
    });
    // MVP: an admin assigns plans manually (admin.subscription_assign, S8); open requests form the staff queue.
    return { body: ACK };
  }
}
