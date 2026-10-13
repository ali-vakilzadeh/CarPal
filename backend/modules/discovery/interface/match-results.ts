// Public interface of the discovery module (41 §4.2 interface/): appointments
// created from a search result record it on the match result (52 MatchResult
// .appointment_id, the match acceptance metric of 54 §5).
import type { TxScope } from '#libs/tenancy/index.js';

export abstract class MatchResults {
  /**
   * Links a result of the caller's own match session (RLS via_session) that
   * ranked `providerOrgId` to the appointment created from it; false when the
   * result is unknown, of another caller or of another target.
   */
  abstract linkAppointment(scope: TxScope, matchResultId: string, providerOrgId: string, appointmentId: string): Promise<boolean>;
}
