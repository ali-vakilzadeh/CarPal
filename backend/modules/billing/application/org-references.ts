// Billing's references to organizations for an organization merge (backend S22, BR-08). The surviving organization
// keeps its own plan: the merged organization's current subscription is cancelled and its open plan request withdrawn;
// past subscription rows stay with it as its billing history.
import { historyRef, retireRef, type OrgReference } from '#modules/organization/interface/org-references.js';

export function billingOrgReferences(): OrgReference[] {
  return [
    retireRef(
      'billing.subscription',
      {
        table: 'billing.subscriptions',
        columns: ['subscriber_id'],
        where: "%.subscriber_type = 'organization' AND %.status IN ('trial','active')",
      },
      "status = 'cancelled'",
    ),
    historyRef('billing.subscription_history', {
      table: 'billing.subscriptions',
      columns: ['subscriber_id'],
      where: "%.subscriber_type = 'organization' AND %.status NOT IN ('trial','active')",
    }),
    retireRef(
      'billing.plan_requests',
      { table: 'billing.subscription_change_requests', columns: ['organization_id'], where: "%.status = 'open'" },
      "status = 'withdrawn'",
    ),
  ];
}
