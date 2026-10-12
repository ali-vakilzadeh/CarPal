// Public interface of the organization module (41 §4.2 interface/): minimal
// organization cards for other modules (membership switchers, consent request
// views, review subjects), through the organization.org_cards() definer
// function, with the public logo when one may be shown.
import type { OrgStatus, OrgType, VerificationStatus } from '#libs/contract/generated/enums.js';
import type { TxScope } from '#libs/tenancy/index.js';

export interface OrgCard {
  id: string;
  name: string;
  organizationType: OrgType;
  slug: string | null;
  status: OrgStatus;
  verificationStatus: VerificationStatus;
  /** Signed URL of a publicly servable logo (52 §15), else null. */
  logoUrl: string | null;
}

export abstract class OrgCards {
  abstract cards(scope: TxScope, ids: readonly string[]): Promise<Map<string, OrgCard>>;
}

/** 40 §6.1 OrgSummary. */
export function toOrgSummary(c: OrgCard) {
  return {
    id: c.id,
    name: c.name,
    organization_type: c.organizationType,
    slug: c.slug,
    logo_url: c.logoUrl,
    status: c.status,
    verification_status: c.verificationStatus,
  };
}
