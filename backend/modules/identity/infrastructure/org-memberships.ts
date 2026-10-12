// Organization memberships and consent requests for the organization module
// (40 §7 members and invitations, §8 portfolio consent requests). identity
// owns identity.role_memberships and identity.consent_requests; callers run
// in their organization context (policies self_or_org and party_all), and
// accepting an invitation goes through the definer identity.accept_invitation
// (the invitee cannot see the invitation row before accepting).
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { AUDIT_MARK } from '#libs/audit/index.js';
import { ApiError } from '#libs/contract/index.js';
import { registerConstraintErrors } from '#libs/db/index.js';
import { LinkTokens } from '#libs/link-tokens/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { OrgCards } from '#modules/organization/interface/org-cards.js';
import { toMembership } from '../api/projections.js';
import { IdentityMessages } from './messages.js';
import {
  ConsentRequests,
  OrgMemberships,
  type ConsentRequestInput,
  type MemberListQuery,
  type OrgMemberRecord,
} from '../interface/identity.js';

registerConstraintErrors({
  role_memberships_invite_uq: { code: 'DUPLICATE', pointer: '/email', fieldCode: 'not_unique' },
  role_memberships_org_uq: 'DUPLICATE',
  consent_requests_pending_uq: 'DUPLICATE',
});

type MemberRow = {
  id: string;
  version: number;
  user_id: string | null;
  role: string;
  status: string;
  joined_at: Date | null;
  invited_email: string | null;
  full_name: string | null;
  display_name: string | null;
  email: string | null;
};

function toRecord(r: MemberRow): OrgMemberRecord {
  return {
    membershipId: r.id,
    version: r.version,
    userId: r.user_id,
    fullName: r.status === 'invited' ? null : r.full_name,
    displayName: r.status === 'invited' ? null : r.display_name,
    email: (r.status === 'invited' ? r.invited_email : (r.email ?? r.invited_email)) ?? '',
    role: r.role,
    status: r.status as OrgMemberRecord['status'],
    joinedAt: r.joined_at,
  };
}

@Injectable()
export class DbOrgMemberships extends OrgMemberships {
  // Optional: the auth host runs identity without the organization module (it never accepts invitations).
  constructor(@Optional() private readonly orgCards?: OrgCards) {
    super();
  }

  #select(scope: TxScope, orgId: string) {
    // Member names and emails are readable inside the organization (policy org_members_read); removed members are not listed.
    return scope.db
      .selectFrom('identity.role_memberships as m')
      .leftJoin('identity.user_accounts as u', 'u.id', 'm.user_id')
      .select([
        'm.id',
        'm.version',
        'm.user_id',
        'm.role',
        'm.status',
        'm.joined_at',
        'm.invited_email',
        'u.full_name',
        'u.display_name',
        'u.email',
      ])
      .where('m.organization_id', '=', orgId)
      .where('m.deleted_at', 'is', null)
      .where('m.status', '<>', 'removed');
  }

  async addOwner(scope: TxScope, orgId: string, userId: string, role: string): Promise<void> {
    await scope.db
      .insertInto('identity.role_memberships')
      .values({ user_id: userId, organization_id: orgId, role, status: 'active', joined_at: sql`now()` })
      .execute();
  }

  async list(scope: TxScope, orgId: string, q: MemberListQuery): Promise<OrgMemberRecord[]> {
    if (q.status === 'removed') return [];
    let query = this.#select(scope, orgId);
    if (q.role) query = query.where('m.role', '=', q.role);
    if (q.status) query = query.where('m.status', '=', q.status);
    if (q.afterId) query = query.where('m.id', '>', q.afterId);
    const rows = await query.orderBy('m.id').limit(q.limit).execute();
    return rows.map((r) => toRecord(r as MemberRow));
  }

  async get(scope: TxScope, orgId: string, membershipId: string, lock = false): Promise<OrgMemberRecord | null> {
    if (lock)
      await scope.db
        .selectFrom('identity.role_memberships')
        .select('id')
        .where('id', '=', membershipId)
        .where('organization_id', '=', orgId)
        .forUpdate()
        .execute();
    const row = await this.#select(scope, orgId).where('m.id', '=', membershipId).executeTakeFirst();
    return row ? toRecord(row as MemberRow) : null;
  }

  async findLive(scope: TxScope, orgId: string, by: { userId: string } | { email: string }): Promise<OrgMemberRecord | null> {
    let q = this.#select(scope, orgId);
    q =
      'userId' in by
        ? q.where('m.user_id', '=', by.userId)
        : q.where((eb) => eb.or([eb('m.invited_email', '=', by.email), eb('u.email', '=', by.email)]));
    const row = await q.orderBy('m.id').executeTakeFirst();
    return row ? toRecord(row as MemberRow) : null;
  }

  async invite(
    scope: TxScope,
    orgId: string,
    i: { email: string; role: string; invitedBy: string; tokenHash: Buffer; expiresAt: Date },
  ): Promise<string> {
    const row = await scope.db
      .insertInto('identity.role_memberships')
      .values({
        organization_id: orgId,
        role: i.role,
        status: 'invited',
        invited_by: i.invitedBy,
        invited_email: i.email,
        invitation_token_hash: i.tokenHash,
        invitation_expires_at: i.expiresAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async update(scope: TxScope, membershipId: string, patch: { role?: string; status?: string }): Promise<OrgMemberRecord> {
    const row = await scope.db
      .updateTable('identity.role_memberships')
      .set({
        ...(patch.role !== undefined ? { role: patch.role } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        // A revoked invitation can no longer be accepted.
        ...(patch.status === 'removed' ? { invitation_token_hash: null } : {}),
      })
      .where('id', '=', membershipId)
      .returning(['organization_id'])
      .executeTakeFirst();
    if (!row) throw new ApiError('NOT_FOUND');
    if (patch.status === 'removed') {
      // Removed rows are not listed; report the final state from the stored row.
      const r = await scope.db
        .selectFrom('identity.role_memberships')
        .select(['id', 'version', 'user_id', 'role', 'status', 'joined_at', 'invited_email'])
        .where('id', '=', membershipId)
        .executeTakeFirstOrThrow();
      return toRecord({ ...r, full_name: null, display_name: null, email: null });
    }
    return (await this.get(scope, row.organization_id!, membershipId))!;
  }

  async countActive(scope: TxScope, orgId: string, roles: readonly string[], excludingId?: string): Promise<number> {
    let q = scope.db
      .selectFrom('identity.role_memberships')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('organization_id', '=', orgId)
      .where('role', 'in', [...roles])
      .where('status', '=', 'active')
      .where('deleted_at', 'is', null);
    if (excludingId) q = q.where('id', '<>', excludingId);
    return Number((await q.executeTakeFirstOrThrow()).n);
  }

  async acceptInvitation(scope: TxScope, tokenHash: Buffer): Promise<{ membershipId: string; orgId: string; membership: unknown }> {
    // Maps P0410/P0411/P0403 to LINK_EXPIRED / LINK_USED / LINK_RECIPIENT_MISMATCH (libs/db).
    const { rows } = await sql<{ membership_id: string; organization_id: string; role: string }>`
      SELECT membership_id, organization_id, role FROM identity.accept_invitation(${tokenHash})`.execute(scope.db);
    const r = rows[0];
    if (!r) throw new ApiError('LINK_EXPIRED');
    // The definer function wrote the audit entry (membership.invitation_accepted).
    scope.marks.add(AUDIT_MARK);
    const row = await scope.db
      .selectFrom('identity.role_memberships')
      .selectAll()
      .where('id', '=', r.membership_id)
      .executeTakeFirstOrThrow();
    if (!this.orgCards) throw new ApiError('INTERNAL', { detail: 'OrgCards not bound on this host' });
    const cards = await this.orgCards.cards(scope, [r.organization_id]);
    return { membershipId: r.membership_id, orgId: r.organization_id, membership: toMembership(row, cards) };
  }
}

@Injectable()
export class DbConsentRequests extends ConsentRequests {
  constructor(
    private readonly links: LinkTokens,
    private readonly messages: IdentityMessages,
  ) {
    super();
  }

  async create(scope: TxScope, r: ConsentRequestInput): Promise<{ id: string; expiresAt: Date }> {
    const link = this.links.issue('cn');
    const row = await scope.db
      .insertInto('identity.consent_requests')
      .values({
        requested_by_organization_id: r.organizationId,
        requested_by_user_id: r.requestedByUserId,
        subject_user_id: r.subjectUserId,
        consent_type: r.consentType,
        scope_entity_type: r.scope.type,
        scope_entity_id: r.scope.id,
        source_visit_type: r.sourceVisit.type,
        source_visit_id: r.sourceVisit.id,
        purpose_i18n_key: r.purposeI18nKey,
        token_hash: link.hash,
        expires_at: link.expiresAt!,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // Contact of the subject for this request only (definer; the business never reads it, SEC-OUT-3).
    const { rows } = await sql<{ email: string; locale: string }>`
      SELECT email, locale FROM identity.consent_request_contact(${row.id}::uuid)`.execute(scope.db);
    const to = rows[0];
    if (!to) throw new ApiError('REFERENCE_NOT_FOUND', { detail: 'consent request subject has no active account' });
    scope.afterCommit(() =>
      this.messages.email(to.email, 'identity.consent_request', to.locale, {
        link: this.links.link('cn', link.token),
        organization_name: r.organizationName,
        consent_type: r.consentType,
      }),
    );
    return { id: row.id, expiresAt: link.expiresAt! };
  }

  async latest(scope: TxScope, organizationId: string, consentType: string, scopeRef: { type: string; id: string }) {
    const row = await scope.db
      .selectFrom('identity.consent_requests')
      .select(['id', 'status', 'resulting_consent_id', 'expires_at'])
      .where('requested_by_organization_id', '=', organizationId)
      .where('consent_type', '=', consentType)
      .where('scope_entity_type', '=', scopeRef.type)
      .where('scope_entity_id', '=', scopeRef.id)
      .where('deleted_at', 'is', null)
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (!row) return null;
    const expired = row.status === 'pending' && new Date(row.expires_at).getTime() <= Date.now();
    return {
      id: row.id,
      status: expired ? 'expired' : row.status,
      resultingConsentId: row.resulting_consent_id,
      expiresAt: new Date(row.expires_at),
    };
  }
}

/**
 * ConsentScopes verifier for scope types that are granted only in answer to a
 * business's cn request (portfolio_item): the user must be the subject of a
 * request for that entity (policy party_all: subject_user_id = core.me()).
 */
export async function requestedOfUser(scope: TxScope, type: string, userId: string, entityId: string): Promise<boolean> {
  const row = await scope.db
    .selectFrom('identity.consent_requests')
    .select('id')
    .where('subject_user_id', '=', userId)
    .where('scope_entity_type', '=', type)
    .where('scope_entity_id', '=', entityId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return !!row;
}
