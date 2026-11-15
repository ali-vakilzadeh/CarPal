// Trust's references to organizations for an organization merge (backend S22, BR-08): reviews, review requests,
// answers and disputes move to the surviving organization, whose score is recomputed on organization.merged. Badges
// are earned by the record they were evaluated on, so the merged organization's badges are revoked and the
// surviving one's are evaluated again. Dispute messages (append-only) and trust signals stay with the merged one.
import { historyRef, moveRef, retireRef, type OrgReference } from '#modules/organization/interface/org-references.js';

export function trustOrgReferences(): OrgReference[] {
  return [
    moveRef('trust.reviews', { table: 'trust.reviews', columns: ['subject_organization_id'] }),
    moveRef('trust.review_requests', { table: 'trust.review_requests', columns: ['subject_organization_id'] }),
    moveRef('trust.review_responses', { table: 'trust.review_responses', columns: ['organization_id'] }),
    moveRef('trust.disputes', { table: 'trust.disputes', columns: ['raised_by_organization_id', 'respondent_organization_id'] }),
    historyRef('trust.dispute_messages', { table: 'trust.dispute_messages', columns: ['author_organization_id'], softDeleted: false }),
    retireRef(
      'trust.badges',
      { table: 'trust.provider_badges', columns: ['provider_organization_id'], where: "%.status IN ('pending_approval','active')" },
      "status = 'revoked', revoked_reason = 'organization merged'",
    ),
    historyRef('trust.signals', { table: 'trust.trust_signals', columns: ['subject_id'], where: "%.subject_type = 'organization'" }),
  ];
}
