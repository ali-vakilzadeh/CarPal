// Provisional MembershipDirectory (S2): reads the caller's own active role
// memberships under the user RLS context (policy self_or_org: user_id =
// core.me()). The identity module owns identity.role_memberships; S3 extends
// this with cache invalidation on membership, role and status changes.
import { Injectable } from '@nestjs/common';
import { MembershipDirectory, type Membership } from '#libs/authz/index.js';
import { TxRunner } from '#libs/tenancy/index.js';

@Injectable()
export class DbMembershipDirectory extends MembershipDirectory {
  constructor(private readonly tx: TxRunner) {
    super();
  }

  async memberships(userId: string): Promise<Membership[]> {
    const rows = await this.tx.run({ actorType: 'user', userId }, ({ db }) =>
      db
        .selectFrom('identity.role_memberships')
        .select(['organization_id', 'role'])
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .where('organization_id', 'is not', null)
        .where('deleted_at', 'is', null)
        .execute(),
    );
    return rows.map((r) => ({ orgId: r.organization_id!, role: r.role }));
  }

  async platformRoles(userId: string): Promise<string[]> {
    const rows = await this.tx.run({ actorType: 'user', userId }, ({ db }) =>
      db
        .selectFrom('identity.role_memberships')
        .select('role')
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .where('organization_id', 'is', null)
        .where('role', 'like', 'platform\\_%')
        .where('deleted_at', 'is', null)
        .execute(),
    );
    return rows.map((r) => r.role);
  }
}
