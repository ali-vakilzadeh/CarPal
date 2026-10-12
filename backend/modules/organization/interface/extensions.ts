// Extension points of the organization module (GD-15). Provider work records
// refer to visits, customers and vehicles that other modules own; those
// modules register resolvers here at startup (onModuleInit). Until they do,
// every check fails closed: references are 422 REFERENCE_NOT_FOUND and a
// vehicle link is 403 CONSENT_REQUIRED.
//   appointment (S7)  visits 'appointment', customer check
//   vehicle (S5)      visits 'service_record', customer check, vehicle owners
//   inventory (S5)    active item counts (vendor publish rule)
//   trust, appointment, analytics (S6-S8)  insight metrics
import type { TxScope } from '#libs/tenancy/index.js';

export type VisitKind = 'appointment' | 'service_record';

/** 52 ProviderJobLog.verification_status a job log inherits from its linked visit (54 §1.1). */
export type JobLogVerification = 'self_reported' | 'appointment_verified' | 'customer_confirmed' | 'invoice_verified';

/** A visit of a customer at a provider (appointment or service record). */
export interface VisitInfo {
  customerUserId: string;
  vehicleId: string | null;
  /** What the visit proves about a job log linked to it (self_reported when it proves nothing). */
  jobLogVerification?: JobLogVerification;
}

/** The visit, when it exists and belongs to the provider organization; null otherwise. */
export type VisitResolver = (scope: TxScope, providerOrgId: string, visitId: string) => Promise<VisitInfo | null>;
/** True when the user has an appointment or service record with the provider (52 ProviderCustomerNote rule). */
export type CustomerCheck = (scope: TxScope, providerOrgId: string, userId: string) => Promise<boolean>;
/** The user owning a personal vehicle, or null (unknown vehicle, or a fleet vehicle). */
export type VehicleOwnerResolver = (scope: TxScope, vehicleId: string) => Promise<string | null>;
/** Active inventory items of a vendor organization. */
export type ItemCounter = (scope: TxScope, vendorOrgId: string) => Promise<number>;

/** Figures of 40 ProviderInsights / VendorInsights that other modules own. */
export type InsightKey =
  | 'provider.overall_rating'
  | 'provider.review_count'
  | 'provider.category_ratings'
  | 'provider.profile_views'
  | 'provider.map_pin_views'
  | 'provider.directions_taps'
  | 'provider.requests_received'
  | 'provider.requests_from_map'
  | 'provider.completion_rate'
  | 'vendor.inquiries_received'
  | 'vendor.inquiry_fulfillment_rate'
  | 'vendor.items_missing_fitment'
  | 'vendor.items_missing_images'
  | 'vendor.top_searched_part_categories'
  | 'vendor.popular_categories'
  | 'vendor.map_pin_views'
  | 'vendor.directions_taps';
export type InsightSource = (scope: TxScope, orgId: string, period: { from: string; to: string }) => Promise<unknown>;

export class OrganizationExtensions {
  readonly #visits = new Map<VisitKind, VisitResolver>();
  readonly #customers: CustomerCheck[] = [];
  #vehicleOwner: VehicleOwnerResolver | undefined;
  #items: ItemCounter | undefined;
  readonly #insights = new Map<InsightKey, InsightSource>();

  registerVisits(kind: VisitKind, resolver: VisitResolver): void {
    if (this.#visits.has(kind)) throw new Error(`visit resolver ${kind} registered twice`);
    this.#visits.set(kind, resolver);
  }

  registerCustomerCheck(check: CustomerCheck): void {
    this.#customers.push(check);
  }

  registerVehicleOwners(resolver: VehicleOwnerResolver): void {
    if (this.#vehicleOwner) throw new Error('vehicle owner resolver registered twice');
    this.#vehicleOwner = resolver;
  }

  registerItemCounter(counter: ItemCounter): void {
    if (this.#items) throw new Error('item counter registered twice');
    this.#items = counter;
  }

  registerInsight(key: InsightKey, source: InsightSource): void {
    if (this.#insights.has(key)) throw new Error(`insight ${key} registered twice`);
    this.#insights.set(key, source);
  }

  /** The visit at this provider, or null (also when no module resolves the kind yet). */
  async visit(scope: TxScope, kind: VisitKind, providerOrgId: string, visitId: string): Promise<VisitInfo | null> {
    const r = this.#visits.get(kind);
    return r ? r(scope, providerOrgId, visitId) : null;
  }

  async hasCustomer(scope: TxScope, providerOrgId: string, userId: string): Promise<boolean> {
    for (const check of this.#customers) if (await check(scope, providerOrgId, userId)) return true;
    return false;
  }

  async vehicleOwner(scope: TxScope, vehicleId: string): Promise<string | null> {
    return this.#vehicleOwner ? this.#vehicleOwner(scope, vehicleId) : null;
  }

  async activeItems(scope: TxScope, vendorOrgId: string): Promise<number> {
    return this.#items ? this.#items(scope, vendorOrgId) : 0;
  }

  /** A registered figure, or `fallback` until its module provides it. */
  async insight<T>(key: InsightKey, scope: TxScope, orgId: string, period: { from: string; to: string }, fallback: T): Promise<T> {
    const source = this.#insights.get(key);
    return source ? ((await source(scope, orgId, period)) as T) : fallback;
  }
}
