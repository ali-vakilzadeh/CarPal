// OrganizationDirectory (L4): organization type and status through the
// organization.org_cards() definer function (42 §5.3), readable before the
// caller's membership is authorized. The Authorizer caches the answer for at
// most 30 s; status changes call Authorizer.invalidateOrganization (S4:
// profile publication activates a draft organization; S8: suspensions).
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { OrganizationDirectory, type OrganizationInfo } from '#libs/authz/index.js';
import type { OrgStatus, OrgType } from '#libs/contract/generated/enums.js';
import { TxRunner } from '#libs/tenancy/index.js';

@Injectable()
export class DbOrganizationDirectory extends OrganizationDirectory {
  constructor(private readonly tx: TxRunner) {
    super();
  }

  async get(orgId: string): Promise<OrganizationInfo | null> {
    const row = await this.tx.run({ actorType: 'anonymous' }, async ({ db }) => {
      const { rows } = await sql<{ id: string; organization_type: string; status: string }>`
        SELECT id, organization_type, status FROM organization.org_cards(ARRAY[${orgId}::uuid])`.execute(db);
      return rows[0];
    });
    return row ? { id: row.id, type: row.organization_type as OrgType, status: row.status as OrgStatus } : null;
  }
}
