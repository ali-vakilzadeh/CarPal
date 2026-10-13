// Public interface of the vehicle module (41 §4.2 interface/). Providers and
// vendors never own customer vehicles (52 §8): they get minimal cards
// through the vehicle.vehicle_cards definer, never VIN, plate, notes or
// owner. Owners' own modules (inquiries, fleet) resolve vehicles the caller
// can see. Appointments (S7) record completed work and schedule issues here.
import type { TxScope } from '#libs/tenancy/index.js';

/** Taxonomy and year of a vehicle (vehicle.vehicle_cards). */
export interface VehicleCard {
  id: string;
  brandNodeId: string;
  modelNodeId: string;
  seriesNodeId: string | null;
  year: number;
  engineTypeNodeId: string | null;
  fuelTypeNodeId: string | null;
  nickname: string | null;
}

/** A vehicle visible to the caller as its owner (user or fleet organization context). */
export interface OwnedVehicle extends VehicleCard {
  ownerType: 'user' | 'organization';
  ownerId: string;
  status: string;
}

export abstract class VehicleCards {
  /** Cards of any vehicles (definer read): for providers and vendors in appointments and inquiries. */
  abstract cards(scope: TxScope, ids: readonly string[]): Promise<Map<string, VehicleCard>>;
  /** A vehicle the caller's RLS context owns (the user's personal vehicle, or the fleet's), else null. */
  abstract visible(scope: TxScope, vehicleId: string): Promise<OwnedVehicle | null>;
  /** Open (due or overdue, else upcoming) reminders of a vehicle the caller owns, most urgent first (Discover feed tips). */
  abstract openReminders(scope: TxScope, vehicleId: string, limit: number): Promise<OpenReminder[]>;
  /**
   * Service records of the caller's own vehicles at a provider that prove a
   * visit (verification_status other than self_reported, not removed): 52
   * §21 service_record_verified for reviews. Newest first, ≤ 50.
   */
  abstract serviceVisits(scope: TxScope, providerOrgId: string): Promise<ServiceVisit[]>;
  /** Active service history of a vehicle the caller owns, newest first (pre-visit report under consent, S7). */
  abstract serviceHistory(scope: TxScope, vehicleId: string, limit: number): Promise<HistoryEntry[]>;
  /** An issue of a vehicle the caller owns (40 SearchRequest.issue_id, AppointmentCreate.related_issue_id), else null. */
  abstract issue(scope: TxScope, issueId: string): Promise<IssueCard | null>;
  /** Service records of appointments visible to the caller (owner, or provider of record), by appointment id. */
  abstract appointmentRecords(scope: TxScope, appointmentIds: readonly string[]): Promise<Map<string, string>>;
}

export interface ServiceVisit {
  id: string;
  vehicleId: string;
  serviceDate: string;
  verificationStatus: string;
  appointmentId: string | null;
  serviceSystemNodeId: string;
  serviceTaskNodeId: string | null;
}

export interface HistoryEntry {
  id: string;
  serviceDate: string;
  serviceSystemNodeId: string;
  serviceTaskNodeId: string | null;
  description: string | null;
  mileageKm: number | null;
}

export interface IssueCard {
  id: string;
  vehicleId: string;
  title: string;
  description: string;
  symptomNodeId: string | null;
  urgencyLevel: string;
  status: string;
}

export interface OpenReminder {
  id: string;
  reminder_type: string;
  title: string;
  status: string;
  priority: string;
}

/** 40 ServiceRecord written when an appointment completes (S7). */
export interface AppointmentServiceRecord {
  vehicleId: string;
  appointmentId: string;
  providerOrganizationId: string;
  serviceDate: string;
  serviceSystemNodeId: string;
  serviceTaskNodeId?: string | null;
  description?: string | null;
  mileageKm?: number | null;
  /** 40 PartUsed without inventory references (the provider names the parts it used). */
  partsUsed?: { name: string; part_number?: string; quantity: number }[];
  /** 40 completion final_cost (Money: amount + currency). */
  cost?: { amount: string; currency: string } | null;
  costBreakdown?: Record<string, string> | null;
  warrantyNote?: string | null;
}

export abstract class VehicleService {
  /**
   * appointment_completed record (verification appointment_verified,
   * created_by system) in the caller's transaction (system context, or the
   * provider's: RLS provider_insert). One record per appointment. Emits
   * service_record.created. Returns the record id.
   */
  abstract recordAppointmentService(scope: TxScope, r: AppointmentServiceRecord): Promise<string>;
  /** An issue converted into an appointment becomes scheduled (40 VehicleIssue.converted_appointment_id). */
  abstract markIssueScheduled(scope: TxScope, issueId: string, appointmentId: string): Promise<void>;
}
