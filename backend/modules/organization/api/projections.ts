// Response projections of the organization module (40 §7.1, §8.1, §9.1),
// built by allowlist for members of the organization. Optional members of the
// *Write types are omitted when the column is null; derived values are
// passed in by the use case. Exact coordinates appear only here (member
// views); public projections (S6) use the public point (SEC-OUT-4).
import type { Selectable } from 'kysely';
import { textArray, type DB } from '#libs/db/index.js';
import { isoOrNull, meta } from '#libs/http-pipeline/index.js';
import type { MediaAttachmentView } from '#modules/media/interface/media.js';
import type { OrgMemberRecord } from '#modules/identity/interface/identity.js';

export type OrgRow = Selectable<DB['organization.organizations']>;
export type LocationRow = Selectable<DB['organization.organization_locations']>;
export type VerificationRow = Selectable<DB['organization.organization_verifications']>;
export type ProviderProfileRow = Selectable<DB['organization.provider_profiles']>;
export type CertificationRow = Selectable<DB['organization.provider_certifications']>;
export type ServiceCategoryRow = Selectable<DB['organization.provider_service_categories']>;
export type CoverageRow = Selectable<DB['organization.provider_vehicle_coverage']>;
export type CapabilityRow = Selectable<DB['organization.provider_capabilities']>;
export type EvidenceRow = Selectable<DB['organization.provider_capability_evidence']>;
export type JobLogRow = Selectable<DB['organization.provider_job_logs']>;
export type CustomerNoteRow = Selectable<DB['organization.provider_customer_notes']>;
export type PortfolioRow = Selectable<DB['organization.portfolio_items']>;
export type VendorProfileRow = Selectable<DB['organization.vendor_profiles']>;
export type VendorCoverageRow = Selectable<DB['organization.vendor_coverage']>;

/** Copies the listed optional members whose value is not null. */
function optional<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Partial<Record<K, NonNullable<T[K]>>> {
  const out: Partial<Record<K, NonNullable<T[K]>>> = {};
  for (const k of keys) if (row[k] !== null && row[k] !== undefined) out[k] = row[k] as NonNullable<T[K]>;
  return out;
}

const num = (v: string | number): number => Number(v);

/** 40 Organization (my_role derived for the caller). */
export function toOrganization(o: OrgRow, myRole: string) {
  return {
    ...meta(o),
    name: o.name,
    legal_name: o.legal_name,
    organization_type: o.organization_type,
    verification_status: o.verification_status,
    primary_location_id: o.primary_location_id,
    contact_email: o.contact_email,
    contact_phone: o.contact_phone,
    website: o.website,
    description_translations: o.description_translations as Record<string, string> | null,
    slug: o.slug,
    trust_score: o.trust_score,
    status: o.status,
    merged_into_organization_id: o.merged_into_organization_id,
    my_role: myRole,
  };
}

/** 40 OrgMember. */
export function toOrgMember(m: OrgMemberRecord) {
  return {
    membership_id: m.membershipId,
    version: m.version,
    user_id: m.userId,
    full_name: m.fullName,
    display_name: m.displayName,
    email: m.email,
    role: m.role,
    status: m.status,
    joined_at: isoOrNull(m.joinedAt),
  };
}

/** 40 Location (member view: exact point and public point). */
export function toLocation(l: LocationRow) {
  return {
    ...meta(l),
    ...optional(l, [
      'name',
      'address_line_2',
      'region',
      'postal_code',
      'service_radius_km',
      'phone',
      'email',
      'primary_contact_user_id',
      'access_instructions_translations',
      'hours',
    ] as const),
    address_line_1: l.address_line_1,
    city: l.city,
    country: l.country,
    public_address_visibility: l.public_address_visibility,
    timezone: l.timezone,
    is_primary: l.is_primary,
    status: l.status,
    organization_id: l.organization_id,
    latitude: num(l.latitude),
    longitude: num(l.longitude),
    public_point: { lat: num(l.public_latitude), lng: num(l.public_longitude) },
    geo_source: l.geo_source,
    geo_address_distance_m: l.geo_address_distance_m,
    location_check_status: l.location_check_status,
    location_verified_at: isoOrNull(l.location_verified_at),
  };
}

/** 40 OrganizationVerification. */
export function toVerification(v: VerificationRow) {
  return {
    ...meta(v),
    verification_type: v.verification_type,
    status: v.status,
    submitted_document_ids: textArray(v.submitted_document_ids),
    reviewed_at: isoOrNull(v.reviewed_at),
    rejection_reason: v.rejection_reason,
    expires_at: isoOrNull(v.expires_at),
  };
}

/** 40 ProviderProfile (completeness and gaps computed per request). */
export function toProviderProfile(p: ProviderProfileRow, derived: { completeness: number; gaps: string[] }) {
  return {
    ...meta(p),
    provider_type: p.provider_type,
    ...optional(p, ['description_translations', 'years_in_business', 'warranty_policy_translations', 'response_time_target'] as const),
    languages_spoken: textArray(p.languages_spoken),
    amenity_node_ids: textArray(p.amenity_node_ids),
    service_modes: textArray(p.service_modes),
    contact_channels: p.contact_channels as unknown[],
    price_tier: p.price_tier,
    warranty_offered: p.warranty_offered,
    organization_id: p.organization_id,
    measured_response_time_minutes: p.measured_response_time_minutes,
    appointment_capacity_enabled: p.appointment_capacity_enabled,
    profile_completeness: derived.completeness,
    activity_status: p.activity_status,
    public_status: p.public_status,
    completeness_gaps: derived.gaps,
  };
}

/** 40 Certification. */
export function toCertification(c: CertificationRow) {
  return {
    ...meta(c),
    certification_type: c.certification_type,
    name: c.name,
    issuer: c.issuer,
    ...optional(c, ['credential_number', 'issued_at', 'expires_at', 'document_media_asset_id'] as const),
    scope_node_ids: textArray(c.scope_node_ids),
    verification_status: c.verification_status,
    status: c.status,
  };
}

/** 40 ServiceCategory. */
export function toServiceCategory(c: ServiceCategoryRow) {
  return {
    ...meta(c),
    taxonomy_node_id: c.taxonomy_node_id,
    ...optional(c, ['display_name_translations', 'description_translations', 'price_indicator', 'typical_duration_minutes'] as const),
    appointment_types: textArray(c.appointment_types),
    experience_level: c.experience_level,
    visibility: c.visibility,
    source: c.source,
    status: c.status,
    ai_insight_id: c.ai_insight_id,
  };
}

/** 40 Coverage. */
export function toCoverage(c: CoverageRow) {
  return {
    ...meta(c),
    brand_node_id: c.brand_node_id,
    ...optional(c, ['model_node_id', 'series_node_id', 'engine_type_node_id', 'fuel_type_node_id'] as const),
    coverage_level: c.coverage_level,
    source: c.source,
    status: c.status,
  };
}

/** 40 Capability. */
export function toCapability(c: CapabilityRow) {
  return {
    ...meta(c),
    ...optional(c, ['brand_node_id', 'model_node_id', 'series_node_id', 'service_task_node_id'] as const),
    service_system_node_id: c.service_system_node_id,
    experience_level: c.experience_level,
    public_visibility: c.public_visibility,
    confidence_level: c.confidence_level,
    confidence_score: c.confidence_score,
    evidence_count: c.evidence_count,
    badge_eligible: c.badge_eligible,
    source: c.source,
    status: c.status,
  };
}

/** 40 CapabilityEvidence. */
export function toEvidence(e: EvidenceRow) {
  return {
    ...meta(e),
    capability_id: e.capability_id,
    evidence_type: e.evidence_type,
    reference: { type: e.reference_entity_type, id: e.reference_entity_id },
    base_weight: e.base_weight,
    evidence_date: e.evidence_date,
    linked_by: e.linked_by,
    ai_insight_id: e.ai_insight_id,
    status: e.status,
  };
}

/** 40 JobLog. */
export function toJobLog(j: JobLogRow) {
  return {
    ...meta(j),
    job_date: j.job_date,
    ...optional(j, [
      'brand_node_id',
      'model_node_id',
      'series_node_id',
      'service_task_node_id',
      'description',
      'vehicle_id',
      'appointment_id',
      'service_record_id',
    ] as const),
    service_system_node_id: j.service_system_node_id,
    logged_by_user_id: j.logged_by_user_id,
    verification_status: j.verification_status,
    status: j.status,
  };
}

/** 40 CustomerNote (org-private). */
export function toCustomerNote(n: CustomerNoteRow) {
  return {
    ...meta(n),
    customer_user_id: n.customer_user_id,
    ...optional(n, ['vehicle_id'] as const),
    body: n.body,
    author_user_id: n.author_user_id,
    status: n.status,
  };
}

/** 40 PortfolioItem (member view, attachments from the media module). */
export function toPortfolioItem(p: PortfolioRow, media: MediaAttachmentView[]) {
  return {
    ...meta(p),
    title: p.title,
    content_locale: p.content_locale,
    ...optional(p, [
      'description',
      'brand_node_id',
      'model_node_id',
      'series_node_id',
      'service_task_node_id',
      'job_date',
      'job_log_id',
      'service_record_id',
      'appointment_id',
      'caption',
      'caption_source',
      'ai_caption_insight_id',
    ] as const),
    service_system_node_id: p.service_system_node_id,
    tag_node_ids: textArray(p.tag_node_ids),
    visibility: p.visibility,
    customer_consent_status: p.customer_consent_status,
    consent_reference_id: p.consent_reference_id,
    moderation_status: p.moderation_status,
    status: p.status,
    media: media.slice(0, 40),
  };
}

/** 40 VendorProfile. */
export function toVendorProfile(v: VendorProfileRow, completeness: number) {
  return {
    ...meta(v),
    vendor_type: v.vendor_type,
    ...optional(v, [
      'description_translations',
      'return_policy_translations',
      'warranty_policy_translations',
      'response_time_target',
    ] as const),
    delivery_options: textArray(v.delivery_options),
    trade_customers_supported: v.trade_customers_supported,
    default_price_visibility: v.default_price_visibility,
    catalog_coming_soon: v.catalog_coming_soon,
    organization_id: v.organization_id,
    measured_response_time_minutes: v.measured_response_time_minutes,
    catalog_quality_score: v.catalog_quality_score,
    profile_completeness: completeness,
    public_status: v.public_status,
  };
}

/** 40 VendorCoverage. */
export function toVendorCoverage(c: VendorCoverageRow) {
  return { ...meta(c), taxonomy_node_id: c.taxonomy_node_id, coverage_type: c.coverage_type, status: c.status };
}
