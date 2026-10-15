// Organization lifecycle steps owned by other modules' flows (GD-19): a fleet
// organization becomes active with its first fleet profile (fleet.profile_put,
// S8), the way a provider or vendor becomes active with its first
// publication (DI-18).
import type { TxScope } from '#libs/tenancy/index.js';

export abstract class OrgLifecycle {
  /**
   * Activates a draft or pending_verification organization in the caller's
   * transaction (organization context: RLS member_all). Returns true when the
   * status changed; the authorization cache is refreshed after commit.
   */
  abstract activate(scope: TxScope, orgId: string): Promise<boolean>;
}
