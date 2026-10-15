// Public interface of the discovery module (41 §4.2 interface/): appointments
// created from a search result record it on the match result (52 MatchResult
// .appointment_id, the match acceptance metric of 54 §5), and Help Me
// sessions rank providers for the user's need (TriageMatching).
import type { OperationContext } from '#libs/http-pipeline/index.js';
import type { Urgency } from '#libs/safety-check/index.js';
import type { TxScope } from '#libs/tenancy/index.js';

export abstract class MatchResults {
  /**
   * Links a result of the caller's own match session (RLS via_session) that
   * ranked `providerOrgId` to the appointment created from it; false when the
   * result is unknown, of another caller or of another target.
   */
  abstract linkAppointment(scope: TxScope, matchResultId: string, providerOrgId: string, appointmentId: string): Promise<boolean>;
}

export interface TriageMatchInput {
  triageSessionId: string;
  vehicleId: string;
  /** The fleet of a fleet vehicle (search in its context), else null. */
  fleetId: string | null;
  issueId: string | null;
  /** 40 LocationInput as sent to triage.complete (validated by the contract). */
  location: Record<string, unknown>;
  urgency: Urgency | null;
  symptomNodeId: string | null;
  serviceSystemNodeIds: readonly string[];
  serviceTaskNodeId: string | null;
}

export abstract class TriageMatching {
  /**
   * Ranks providers for a completed Help Me session (40 triage.complete
   * find_providers; 52 MatchSession source ai_triage, entry point help_me)
   * with the rule-based ranking of search.run, in the caller's transaction.
   * Returns the session and its result ids by provider organization.
   */
  abstract match(
    ctx: OperationContext,
    scope: TxScope,
    i: TriageMatchInput,
  ): Promise<{ matchSessionId: string; resultIds: Map<string, string> }>;
}
