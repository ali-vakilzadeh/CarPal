// OrgLifecycle (organization interface): activation of draft organizations by
// other modules' first-use flows (GD-19).
import { Injectable } from '@nestjs/common';
import { Authorizer } from '#libs/authz/index.js';
import { publishEvent } from '#libs/outbox/index.js';
import type { TxScope } from '#libs/tenancy/index.js';
import { OrgLifecycle } from '../interface/lifecycle.js';

@Injectable()
export class DbOrgLifecycle extends OrgLifecycle {
  constructor(private readonly authorizer: Authorizer) {
    super();
  }

  async activate(scope: TxScope, orgId: string): Promise<boolean> {
    const r = await scope.db
      .updateTable('organization.organizations')
      .set({ status: 'active' })
      .where('id', '=', orgId)
      .where('status', 'in', ['draft', 'pending_verification'])
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) return false;
    await publishEvent(scope, {
      type: 'organization.profile.updated',
      aggregateType: 'organization',
      aggregateId: orgId,
      payload: { organization_id: orgId, change: 'organization' },
    });
    scope.afterCommit(() => this.authorizer.invalidateOrganization(orgId));
    return true;
  }
}
