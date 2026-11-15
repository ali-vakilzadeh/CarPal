// Contract sweep resolvers: billing (40 §10) and its administration (40 §23.2).
import { sql } from 'kysely';
import { expect } from 'vitest';
import { REASON } from '../../s8-support.js';
import { ok, type Json, type Resolvers } from '../harness.js';

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
  // Backend S21 (BR-24): the subscriptions of one organization, and its open plan request.
  'admin.subscriptions_list': async (h) => {
    const org = await h.fx.org('fleet');
    await h.fx.subscription(org, 'fleet_20');
    return {
      as: await h.staff('platform_admin'),
      query: { subscriber_type: 'organization', subscriber_id: org.id, limit: 10 },
      check: (res) => expect((res.body.items as Json[]).length).toBeGreaterThan(0),
    };
  },
  'admin.subscription_change_requests_list': async (h) => {
    const member = await h.member('vendor');
    await h.fx.subscription(member.org!, 'vendor_basic');
    ok(await member.c.post(`/v1/orgs/${member.org!.id}/subscription/change-requests`, { plan_key: 'vendor_pro' }), 'plan request');
    return {
      as: await h.staff('platform_admin'),
      query: { organization_id: member.org!.id },
      check: (res) => expect((res.body.items as Json[]).map((r) => r.requested_plan_key)).toEqual(['vendor_pro']),
    };
  },
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
