// Identity's references to organizations for an organization merge (backend
// S22, BR-08; organization interface OrganizationReferences). Who may act for
// the merged organization never carries over: its memberships and invitations
// end (the surviving organization's owner invites people again), so a merge
// can never hand a duplicate's members access to the surviving business.
// Its onboarding is retired and its pending consent requests are cancelled.
// Consent records are immutable (52 §4): consents granted to the merged
// organization, and its own consents, stay with it.
import { sql } from 'kysely';
import type { Authorizer } from '#libs/authz/index.js';
import { countRefs, historyRef, retireRef, type OrgReference } from '#modules/organization/interface/org-references.js';

const MEMBERSHIPS = { table: 'identity.role_memberships', columns: ['organization_id'], where: "%.status <> 'removed'" };

export function identityOrgReferences(authorizer: Authorizer): OrgReference[] {
  const memberships: OrgReference = {
    key: 'identity.memberships',
    rule: 'retire',
    count: async (scope, from) => ({ rows: await countRefs(scope, MEMBERSHIPS, from), conflicts: 0 }),
    apply: async (scope, from, into) => {
      // An invitation nobody accepted has no user and keeps its status (52: a removed membership names its user).
      const { rows } = await sql<{ user_id: string | null }>`
        UPDATE identity.role_memberships
           SET status = CASE WHEN user_id IS NULL THEN status ELSE 'removed' END,
               deleted_at = now(), deletion_reason = 'organization merged into ' || ${into}::text
         WHERE organization_id = ${from}::uuid AND status <> 'removed' AND deleted_at IS NULL
        RETURNING user_id`.execute(scope.db);
      const users = [...new Set(rows.map((r) => r.user_id).filter((u): u is string => !!u))];
      scope.afterCommit(async () => {
        for (const u of users) await authorizer.invalidateUser(u);
      });
      return { moved: 0, retired: rows.length };
    },
  };
  return [
    memberships,
    retireRef('identity.onboarding', { table: 'identity.onboarding_progress', columns: ['organization_id'] }),
    retireRef(
      'identity.consent_requests',
      { table: 'identity.consent_requests', columns: ['requested_by_organization_id'], where: "%.status = 'pending'" },
      "status = 'cancelled'",
    ),
    historyRef('identity.consents_granted', {
      table: 'identity.consent_records',
      columns: ['granted_to_id'],
      where: "%.granted_to_type = 'organization'",
    }),
    historyRef('identity.consents_own', {
      table: 'identity.consent_records',
      columns: ['subject_id'],
      where: "%.subject_type = 'organization'",
    }),
  ];
}
