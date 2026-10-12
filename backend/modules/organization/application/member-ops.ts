// Members and invitations (40 §7.2): org.members_list, org.member_invite,
// org.invitation_accept, org.member_update, org.member_remove. Memberships
// live in identity (OrgMemberships interface); after every role or status
// change the caller's or member's authorization cache is dropped (SEC-AU-3).
import { Injectable, Optional } from '@nestjs/common';
import { writeAudit } from '#libs/audit/index.js';
import { Authorizer } from '#libs/authz/index.js';
import { ApiError } from '#libs/contract/index.js';
import { EntitlementChecker, requireEntitlement } from '#libs/entitlements/index.js';
import { Operation, type OperationContext, type OperationHandler, type OperationResult } from '#libs/http-pipeline/index.js';
import type { Infra } from '#libs/infra/index.js';
import { LinkTokens } from '#libs/link-tokens/index.js';
import { InjectInfra } from '#libs/runtime/index.js';
import { OrgMemberships, type OrgMemberRecord } from '#modules/identity/interface/identity.js';
import { Messenger } from '#modules/notification/interface/messenger.js';
import { toOrgMember } from '../api/projections.js';
import { isOwnerRole, mayGrant, mayInvite, mayRemove, OWNER_ROLES } from '../domain/roles.js';
import { afterId, checkVersion, loadOrg, member } from './common.js';

@Injectable()
@Operation('org.members_list')
export class OrgMembersListHandler implements OperationHandler {
  constructor(private readonly memberships: OrgMemberships) {}

  async handle(ctx: OperationContext<undefined, { role?: string; status?: string; limit: number }>): Promise<OperationResult> {
    const m = member(ctx);
    const after = afterId(ctx);
    const rows = await ctx.tx(
      (scope) =>
        this.memberships.list(scope, m.orgId, {
          ...(ctx.query.role ? { role: ctx.query.role } : {}),
          ...(ctx.query.status ? { status: ctx.query.status } : {}),
          ...(after ? { afterId: after } : {}),
          limit: ctx.query.limit + 1,
        }),
      { readOnly: true },
    );
    const page = rows.slice(0, ctx.query.limit);
    return { body: ctx.page(page.map(toOrgMember), rows.length > ctx.query.limit ? { id: page.at(-1)!.membershipId } : null) };
  }
}

@Injectable()
@Operation('org.member_invite')
export class OrgMemberInviteHandler implements OperationHandler {
  constructor(
    private readonly memberships: OrgMemberships,
    private readonly links: LinkTokens,
    private readonly entitlements: EntitlementChecker,
    @InjectInfra() private readonly infra: Infra,
    @Optional() private readonly messenger?: Messenger,
  ) {}

  async handle(ctx: OperationContext<{ email: string; role: string }>): Promise<OperationResult> {
    const m = member(ctx);
    const email = ctx.body.email.toLowerCase();
    const role = ctx.body.role;
    // ORG(M+, FC: fleet_driver only): a maintenance coordinator invites drivers only.
    const driversOnly = !ctx.access.matchedGroups.includes('M+');
    if ((driversOnly && role !== 'fleet_driver') || !mayInvite(m.role, role, m.orgType))
      throw ApiError.validation([{ pointer: '/role', code: 'enum' }]);
    const link = this.links.issue('mi');
    const result = await ctx.tx(async (scope) => {
      const org = await loadOrg(scope, m.orgId);
      if (await this.memberships.findLive(scope, m.orgId, { email }))
        throw new ApiError('DUPLICATE', { errors: [{ pointer: '/email', code: 'not_unique' }] });
      // Fleet seats (40 ENT(max_fleet_users)): members plus open invitations, checked under the subscriber lock.
      if (m.orgType === 'fleet')
        await requireEntitlement(this.entitlements, scope, { type: 'organization', id: m.orgId }, 'max_fleet_users', 1);
      const id = await this.memberships.invite(scope, m.orgId, {
        email,
        role,
        invitedBy: m.userId,
        tokenHash: link.hash,
        expiresAt: link.expiresAt!,
      });
      await writeAudit(scope, { action: 'membership.invited', entityType: 'role_membership', entityId: id, next: role });
      // The mi link goes to the invited address only (SEC-LT-2: token in the fragment).
      const variables = { link: this.links.link('mi', link.token), organization_name: org.name, role };
      scope.afterCommit(() =>
        this.messenger
          ? this.messenger.email(email, 'organization.member_invitation', ctx.locale, variables)
          : this.infra.mailer.send({ to: email, template: 'organization.member_invitation', locale: ctx.locale, variables }),
      );
      return { invitation_id: id, expires_at: link.expiresAt!.toISOString() };
    });
    return { status: 201, body: result, headers: { location: `/v1/orgs/${m.orgId}/members/${result.invitation_id}` } };
  }
}

@Injectable()
@Operation('org.invitation_accept')
export class OrgInvitationAcceptHandler implements OperationHandler {
  constructor(
    private readonly memberships: OrgMemberships,
    private readonly links: LinkTokens,
    private readonly authorizer: Authorizer,
  ) {}

  async handle(ctx: OperationContext<{ token: string }>): Promise<OperationResult> {
    if (ctx.principal.kind !== 'user') throw new ApiError('NOT_FOUND');
    const userId = ctx.principal.userId;
    const { hash } = this.links.parse(ctx.body.token, 'mi');
    const membership = await ctx.tx(async (scope) => {
      // identity.accept_invitation: atomic single use, verified email must equal the invited email (SEC-LT-5).
      const r = await this.memberships.acceptInvitation(scope, hash);
      scope.afterCommit(() => this.authorizer.invalidateUser(userId));
      return r.membership;
    });
    return { body: membership };
  }
}

/** Last active owner guard (40 INVALID_TRANSITION(last_owner)). */
async function keepAnOwner(
  memberships: OrgMemberships,
  scope: Parameters<OrgMemberships['countActive']>[0],
  orgId: string,
  target: OrgMemberRecord,
) {
  if (target.status !== 'active' || !isOwnerRole(target.role)) return;
  if ((await memberships.countActive(scope, orgId, OWNER_ROLES, target.membershipId)) === 0)
    throw new ApiError('INVALID_TRANSITION', { detail: 'last_owner' });
}

@Injectable()
@Operation('org.member_update')
export class OrgMemberUpdateHandler implements OperationHandler {
  constructor(
    private readonly memberships: OrgMemberships,
    private readonly authorizer: Authorizer,
  ) {}

  async handle(ctx: OperationContext<{ role?: string; status?: 'active' | 'suspended' }>): Promise<OperationResult> {
    const m = member(ctx);
    const b = ctx.body;
    if (b.role !== undefined && !mayGrant(m.role, b.role, m.orgType)) throw ApiError.validation([{ pointer: '/role', code: 'enum' }]);
    const body = await ctx.tx(async (scope) => {
      const t = await this.memberships.get(scope, m.orgId, ctx.params.membership_id!, true);
      if (!t) throw new ApiError('NOT_FOUND');
      checkVersion(t.version, ctx.ifMatch);
      // An invitation is accepted by the invitee, never activated or suspended by the organization.
      if (t.status === 'invited' && b.status !== undefined) throw new ApiError('INVALID_TRANSITION', { detail: 'invitation' });
      const losesOwner = (b.role !== undefined && !isOwnerRole(b.role)) || b.status === 'suspended';
      if (losesOwner) await keepAnOwner(this.memberships, scope, m.orgId, t);
      const patch = {
        ...(b.role !== undefined && b.role !== t.role ? { role: b.role } : {}),
        ...(b.status !== undefined && b.status !== t.status ? { status: b.status } : {}),
      };
      const row = Object.keys(patch).length ? await this.memberships.update(scope, t.membershipId, patch) : t;
      await writeAudit(scope, {
        action: 'membership.updated',
        entityType: 'role_membership',
        entityId: t.membershipId,
        previous: `${t.role}/${t.status}`,
        next: `${row.role}/${row.status}`,
      });
      if (t.userId) scope.afterCommit(() => this.authorizer.invalidateUser(t.userId!));
      return toOrgMember(row);
    });
    return { body };
  }
}

@Injectable()
@Operation('org.member_remove')
export class OrgMemberRemoveHandler implements OperationHandler {
  constructor(
    private readonly memberships: OrgMemberships,
    private readonly authorizer: Authorizer,
  ) {}

  async handle(ctx: OperationContext): Promise<OperationResult> {
    const m = member(ctx);
    await ctx.tx(async (scope) => {
      const t = await this.memberships.get(scope, m.orgId, ctx.params.membership_id!, true);
      if (!t) throw new ApiError('NOT_FOUND');
      // ORG(O+, M+: lower roles only): a manager removes lower roles and revokes their invitations only.
      if (!ctx.access.matchedGroups.includes('O+') && !mayRemove(m.role, t.role)) throw new ApiError('NOT_FOUND');
      await keepAnOwner(this.memberships, scope, m.orgId, t);
      await this.memberships.update(scope, t.membershipId, { status: 'removed' });
      await writeAudit(scope, {
        action: t.status === 'invited' ? 'membership.invitation_revoked' : 'membership.removed',
        entityType: 'role_membership',
        entityId: t.membershipId,
        previous: t.role,
      });
      // SEC-AU-3: the removed member's sessions lose this organization at once.
      if (t.userId) scope.afterCommit(() => this.authorizer.invalidateUser(t.userId!));
    });
    return { body: { ok: true } };
  }
}
