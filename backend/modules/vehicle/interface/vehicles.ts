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
  /** GD-34: a fleet vehicle's documents and history reach providers of fleet appointments unless private. */
  dataSharing: 'appointments' | 'private';
}

/** A document a fleet shares with the provider of one of its appointments (GD-34). */
export interface SharedDocument {
  id: string;
  documentType: string;
  title: string;
  expiresAt: string | null;
  mediaAssetId: string;
}

export abstract class VehicleCards {
  /** Cards of any vehicles (definer read): for providers and vendors in appointments and inquiries. */
  abstract cards(scope: TxScope, ids: readonly string[]): Promise<Map<string, VehicleCard>>;
  /** A vehicle the caller's RLS context owns (the user's personal vehicle, or the fleet's), else null. */
  abstract visible(scope: TxScope, vehicleId: string): Promise<OwnedVehicle | null>;
  /**
   * The fleet that owns a vehicle (vehicle.vehicle_fleet_owner definer), for
   * operations on {me} paths that also admit fleet members (40 triage.start
   * USR | ORG(F*) DRV): the caller authorizes that organization next. Null for
   * personal vehicles and unknown ids; never returned to clients.
   */
  abstract fleetOwner(scope: TxScope, vehicleId: string): Promise<string | null>;
  /** Active document ids of a vehicle the caller owns, newest first (≤ 20): what a fleet appointment shares. */
  abstract documentIds(scope: TxScope, vehicleId: string): Promise<string[]>;
  /** Live: is the fleet vehicle's data shared through appointments (definer; any context, e.g. the provider's)? */
  abstract fleetDataShared(scope: TxScope, vehicleId: string): Promise<boolean>;
  /** The listed documents of a fleet vehicle still shared (definer); the caller has checked the appointment. */
  abstract fleetSharedDocuments(scope: TxScope, vehicleId: string, ids: readonly string[]): Promise<SharedDocument[]>;
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
  /**
   * The parties of a service record the caller can see (RLS: the owner, or
   * the provider of record): disputes about service records (40 §15.3).
   */
  abstract serviceRecordParties(
    scope: TxScope,
    recordId: string,
  ): Promise<{ ownerType: 'user' | 'organization'; ownerId: string; providerOrgId: string | null } | null>;
  /** A fleet's vehicles (fleet context or system): dashboards, reports, exports. Never the VIN, only its last four. */
  abstract fleetVehicles(scope: TxScope, orgId: string, vehicleIds?: readonly string[]): Promise<FleetVehicleRow[]>;
  /** Active service records of a fleet's vehicles with service dates in [from, to] (YYYY-MM-DD). */
  abstract fleetServiceRecords(
    scope: TxScope,
    orgId: string,
    from: string,
    to: string,
    vehicleIds?: readonly string[],
  ): Promise<FleetServiceRow[]>;
  /** Issues of a fleet's vehicles reported in [from, to). */
  abstract fleetIssues(scope: TxScope, orgId: string, from: Date, to: Date): Promise<FleetIssueRow[]>;
  /** 40 FleetDashboard vehicle figures. */
  abstract fleetDashboard(scope: TxScope, orgId: string): Promise<FleetVehicleFigures>;
  /** Service records of appointments visible to the caller (owner, or provider of record), by appointment id. */
  abstract appointmentRecords(scope: TxScope, appointmentIds: readonly string[]): Promise<Map<string, string>>;
}

export interface FleetVehicleRow {
  id: string;
  brandNodeId: string;
  modelNodeId: string;
  year: number;
  nickname: string | null;
  licensePlate: string | null;
  vinLast4: string | null;
  status: string;
  mileageKm: number | null;
  createdAt: Date;
}

export interface FleetServiceRow {
  id: string;
  vehicleId: string;
  serviceDate: string;
  providerOrgId: string | null;
  serviceSystemNodeId: string;
  serviceTaskNodeId: string | null;
  costAmount: string | null;
  currency: string | null;
  appointmentId: string | null;
}

export interface FleetIssueRow {
  id: string;
  vehicleId: string;
  symptomNodeId: string | null;
  source: string;
  status: string;
  createdAt: Date;
}

export interface FleetVehicleFigures {
  total: number;
  dueForService: number;
  inRepair: number;
  openIssues: number;
  driverReportedIssues: number;
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
  /** A fleet approval was decided for a driver's issue (52 VehicleIssue.fleet_approval_status). */
  abstract setIssueApproval(scope: TxScope, issueId: string, status: 'approved' | 'rejected'): Promise<void>;
  /**
   * Creates a fleet vehicle with the rules of vehicles.create (taxonomy
   * chain, VIN sealing and per-owner uniqueness, max_vehicles inside the
   * transaction, vehicle.created): fleet CSV imports (W7). The body has
   * passed the vehicles.create input schema. Returns the vehicle id.
   */
  abstract createFleetVehicle(scope: TxScope, orgId: string, body: Record<string, unknown>, createdBy: string): Promise<string>;
  /**
   * An issue reported from a completed Help Me session (40 triage.complete
   * create_issue; 52 VehicleIssue source ai_triage, or fleet_driver for a
   * driver so the fleet approval workflow applies). The text is the user's own
   * (AI output is referenced through ai_triage_insight_id, never stored as
   * issue text). Emits vehicle.issue.reported. Caller's transaction, with the
   * fleet as organization for fleet vehicles. Returns the issue id.
   */
  abstract reportTriageIssue(scope: TxScope, i: TriageIssue): Promise<string>;
}

export interface TriageIssue {
  vehicleId: string;
  /** The fleet owning the vehicle, or null for a personal vehicle. */
  orgId: string | null;
  driver: boolean;
  userId: string;
  title: string;
  description: string;
  locale: string;
  symptomNodeId: string | null;
  urgency: 'low' | 'medium' | 'high' | 'safety_critical';
  triageSessionId: string;
  aiInsightId: string | null;
  mediaIds: readonly string[];
}
