// Contract sweep resolvers: billing (40 §10) and its administration (40 §23.2).
import { sql } from 'kysely';
import { REASON } from '../../s8-support.js';
import type { Resolvers } from '../harness.js';

export const resolvers: Resolvers = {
  'plans.list': async (h) => ({ as: await h.anonymous(), query: { audience: 'fleet' } }),
  'subscription.me_get': async (h) => ({ as: await h.user() }),
  'subscription.org_get': async (h) => {
    const as = await h.member('fleet', 'fleet_viewer');
    await h.fx.subscription(as.org!, 'fleet_20');
    return { as };
  },
  'subscription.change_request': async (h) => {
    const as = await h.member('provider');
    await h.fx.subscription(as.org!, 'provider_basic');
    return { as, body: { plan_key: 'provider_pro', note: 'more capacity please' } };
  },
  'admin.subscription_assign': async (h) => {
    const org = await h.fx.org('fleet');
    return {
      as: await h.staff('platform_admin'),
      body: {
        subscriber: { type: 'organization', id: org.id },
        plan_key: 'fleet_50',
        status: 'active',
        vehicle_limit_override: 60,
        reason: REASON,
      },
    };
  },
  'admin.plans_list': async (h) => ({ as: await h.staff('platform_admin') }),
  'admin.plan_update': async (h) => {
    const [plan] = await h.q<{ id: string }>(sql`SELECT id FROM billing.plans WHERE plan_key = 'vendor_pro'`);
    await h.expirePending(plan!.id);
    return {
      as: await h.staff('platform_admin'),
      params: { plan_id: plan!.id },
      body: { entitlements: [{ key: 'max_inventory_items', value: 6000 }], reason: REASON },
      check: (res) => h.rejectChange(res.body.change_id as string),
    };
  },
};
