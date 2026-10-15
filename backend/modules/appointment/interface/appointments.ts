// Public interface of the appointment module (41 §4.2 interface/). The trust
// module reads appointments as review visits (52 §21 appointment_verified),
// review invitation sources and trust-scoring inputs (54 §1, §3.1, §4) here,
// never from the appointment tables. The ai-mcp facade drafts the request of
// a completed Help Me session through AppointmentDrafts (api host only).
import type { OperationContext } from '#libs/http-pipeline/index.js';
import type { Locale } from '#libs/i18n/index.js';
import type { Urgency } from '#libs/safety-check/index.js';
import type { TxScope } from '#libs/tenancy/index.js';

/** An appointment as a visit (appointment.visit_cards): parties, taxonomy, dates and status, no text. */
export interface AppointmentVisit {
  id: string;
  providerOrgId: string;
  providerLocationId: string | null;
  requesterType: 'user' | 'fleet';
  requesterUserId: string;
  requesterOrgId: string | null;
  vehicleId: string;
  serviceSystemNodeId: string | null;
  serviceTaskNodeId: string | null;
  status: string;
  confirmedStartAt: Date | null;
  confirmedEndAt: Date | null;
  completedAt: Date | null;
}

/** Appointment figures of a provider for 54 §3.1 operational reliability and §4 badges. */
export interface ProviderAppointmentStats {
  /** Requests received in the last 90 days, and those answered (confirm, propose, decline) within 24 h. */
  requests90: number;
  respondedWithin24h90: number;
  /** Requests of the last 30 days with a provider answer, and their average first-response time. */
  responded30: number;
  avgResponseMinutes30: number | null;
  /** Average first-response time over every answered request (ProviderProfile.measured_response_time_minutes). */
  avgResponseMinutesAll: number | null;
  /** Appointments that reached confirmed in the last 90 days, and those the provider cancelled afterwards. */
  confirmed90: number;
  providerCancelledAfterConfirm90: number;
  /** Outcomes in the last 90 days: completed, and no-shows (54 §3.1: never lowers the score). */
  completed90: number;
  noShow90: number;
  /** Median hours from the request to confirmed_start_at (last 90 days) and the number of samples. */
  medianTurnaroundHours90: number | null;
  turnaroundSamples90: number;
  /** Completed in the last 12 months, and those from requesters with an earlier completed appointment here. */
  completed12m: number;
  repeatCompleted12m: number;
  /** Completed fleet appointments (any time). */
  fleetCompleted: number;
  lastCompletedAt: Date | null;
}

/** A fleet appointment for fleet reports (40 fleet.report downtime / provider usage, 54 §8). */
export interface FleetAppointmentFact {
  id: string;
  vehicleId: string;
  providerOrgId: string;
  status: string;
  createdAt: Date;
  checkedInAt: Date | null;
  /** First ready_for_pickup, else completion (54 §8 fleet_downtime_avg end point). */
  finishedAt: Date | null;
  serviceSystemNodeId: string | null;
  costEstimateAmount: string | null;
  costEstimateCurrency: string | null;
}

export abstract class AppointmentFacts {
  /** Appointments a fleet requested, created in [from, to) (fleet context or system). */
  abstract fleetAppointments(scope: TxScope, fleetOrgId: string, from: Date, to: Date): Promise<FleetAppointmentFact[]>;
  /** Visits by id in any RLS context (definer appointment.visit_cards). */
  abstract visits(scope: TxScope, ids: readonly string[]): Promise<Map<string, AppointmentVisit>>;
  /** The signed-in user's own appointments with a provider (requester), newest first, ≤ 50. */
  abstract mine(scope: TxScope, userId: string, providerOrgId: string): Promise<AppointmentVisit[]>;
  /** Completed appointments of a provider (system or provider context), newest first, ≤ 2000. */
  abstract completed(scope: TxScope, providerOrgId: string): Promise<AppointmentVisit[]>;
  /**
   * Appointments that took place since `since` (completed, or confirmed and
   * 24 h past the scheduled time, 52 §21) and so may get a review invitation.
   * System context.
   */
  abstract tookPlaceSince(scope: TxScope, since: Date, now: Date, limit: number): Promise<AppointmentVisit[]>;
  /** Trust-scoring figures of a provider (system context). */
  abstract stats(scope: TxScope, providerOrgId: string, now: Date): Promise<ProviderAppointmentStats>;
  /** Providers with appointment activity since `since` (trust scoring sweeps). */
  abstract activeProviders(scope: TxScope, since: Date, limit: number): Promise<string[]>;
  /**
   * The earliest open slot of a provider in the next `days` days over its
   * active locations with availability rules (search availability fit and
   * SearchFilters.available_within_days, 54 §5.1); null without a calendar
   * or without a free slot.
   */
  abstract nextOpenSlot(scope: TxScope, providerOrgId: string, now: Date, days?: number): Promise<Date | null>;
}

export interface TriageDraft {
  providerOrgId: string;
  /** Pointer of the provider field for 422 errors (e.g. /draft_appointment_with). */
  pointer: string;
  vehicleId: string;
  issueId: string | null;
  triageSessionId: string;
  matchResultId: string | null;
  /** The user's own words from the session (never AI text). */
  description: string;
  locale: Locale;
  urgency: Urgency;
  symptomNodeId: string | null;
  serviceSystemNodeId: string | null;
  serviceTaskNodeId: string | null;
}

export abstract class AppointmentDrafts {
  /**
   * A personal draft request (status draft, no time windows) from a completed
   * Help Me session (40 triage.complete draft_appointment_with), with the
   * rules of appointments.create; nothing reaches the provider before the
   * user submits it (SEC-AI-3). Caller's transaction. Returns its id.
   */
  abstract draftFromTriage(ctx: OperationContext, scope: TxScope, d: TriageDraft): Promise<string>;
}
