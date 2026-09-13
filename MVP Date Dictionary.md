**MVP Data Dictionary**


# 1. Notation

| Symbol | Meaning |
|---|---|
| R | Required |
| O | Optional |
| C | Conditional |
| S | System-generated |

Types are logical types:

- ID
- string
- text
- integer
- decimal
- boolean
- date
- datetime
- enum
- reference
- list
- structured object

---

# 2. Global Field Rules

Apply to all entities unless stated otherwise.

| Field | Type | Req/Opt | Validation |
|---|---|---|---|
| `id` | ID | S/R | Globally unique |
| `created_at` | datetime | S | Immutable |
| `updated_at` | datetime | S | Updated on change |
| `created_by` | reference | O | User, organization, or system |
| `updated_by` | reference | O | Last modifier |
| `status` | enum | C | Required for lifecycle entities |
| `version` | integer | S | Optimistic concurrency where needed |

For organization-scoped private data:

| Field | Type | Req/Opt | Validation |
|---|---|---|---|
| `organization_id` | reference | C | Required for tenant-scoped records |

For soft-delete-sensitive records:

| Field | Type | Req/Opt | Validation |
|---|---|---|---|
| `deleted_at` | datetime | O | Must be after `created_at` |
| `deletion_reason` | string | O | Max 500 chars |

---

# 3. Core Enums

## User status

- active
- suspended
- deactivated
- pending_verification

## Organization type

- provider
- vendor
- fleet
- hybrid_provider_vendor

## Verification status

- unverified
- pending
- verified
- rejected
- suspended

## Vehicle status

- active
- inactive
- sold
- in_repair
- archived

## Appointment status

- draft
- requested
- provider_reviewing
- alternative_proposed
- confirmed
- checked_in
- in_progress
- awaiting_parts
- ready_for_pickup
- completed
- cancelled
- no_show

## Review status

- draft
- pending_moderation
- published
- rejected
- removed

## Inventory status

- draft
- active
- pending_review
- hidden
- discontinued
- removed

## Fitment confidence

- confirmed
- likely
- uncertain

## MCP risk level

- read_only
- personalized_read
- draft_creation
- external_action
- admin_action

---

# 4. Identity and Access

## UserAccount

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `full_name` | string | R | 2–100 chars |
| `email` | string | R | Valid email, normalized, unique |
| `phone` | string | O | E.164 format, unique if used for login |
| `display_name` | string | O | 2–50 chars, public-safe |
| `locale` | string | O | Default `en` |
| `timezone` | string | O | Valid timezone name |
| `status` | enum | R | User status enum |
| `last_active_at` | datetime | S | Optional for analytics |
| `email_verified_at` | datetime | O | Required before sensitive actions |
| `phone_verified_at` | datetime | O | Optional |
| `preferred_contact_channel` | enum | O | in_app, email, push, sms |

### Rule

At least one verified contact method is required before publishing reviews or appointment requests.

---

## AuthenticationMethod

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `user_id` | reference | R | Must exist |
| `method_type` | enum | R | email_password, phone_otp, social |
| `identifier` | string | R | Unique per method type |
| `credential_reference` | string | C | Required for password/OTP; never plain text |
| `verified_at` | datetime | O | System-set |
| `status` | enum | R | active, disabled |

---

## RoleMembership

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `user_id` | reference | R | Must exist |
| `organization_id` | reference | R | Must exist |
| `role` | enum | R | individual, fleet_owner, fleet_manager, fleet_driver, provider_owner, provider_manager, provider_staff, vendor_owner, vendor_staff, admin |
| `status` | enum | R | invited, active, suspended, removed |
| `invited_by` | reference | O | User reference |
| `joined_at` | datetime | O | Required when status becomes active |

### Rule

One active role per user per organization.

---

## ConsentRecord

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `subject_type` | enum | R | user, organization |
| `subject_id` | reference | R | Must exist |
| `consent_type` | enum | R | vehicle_data_sharing, service_history_sharing, photo_publishing, ai_personalization, review_invitations, location_usage, marketing |
| `version` | string | R | Consent policy version |
| `granted` | boolean | R | True/false |
| `granted_at` | datetime | C | Required if granted |
| `withdrawn_at` | datetime | O | Must be after granted_at |
| `source` | enum | R | ui, admin, import |

---

# 5. Organizations and Plans

## Organization

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `name` | string | R | 2–120 chars |
| `legal_name` | string | O | 2–160 chars |
| `organization_type` | enum | R | provider, vendor, fleet, hybrid_provider_vendor |
| `verification_status` | enum | R | Verification status enum |
| `primary_location_id` | reference | C | Required before public profile |
| `contact_email` | string | R | Valid email |
| `contact_phone` | string | O | E.164 |
| `website` | string | O | Valid URL |
| `description` | text | O | Max 2000 chars |
| `slug` | string | O | Unique public URL slug |
| `status` | enum | R | draft, active, suspended, archived |

### Conditional rules

- If type is provider or hybrid, `ProviderProfile` required before publish.
- If type is vendor or hybrid, `VendorProfile` required before publish.
- If type is fleet, `FleetProfile` required.

---

## OrganizationLocation

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `organization_id` | reference | R | Must exist |
| `name` | string | O | 2–120 chars |
| `address_line_1` | string | R | 2–160 chars |
| `address_line_2` | string | O | Max 160 chars |
| `city` | string | R | Max 100 chars |
| `region` | string | O | Max 100 chars |
| `postal_code` | string | O | Max 20 chars |
| `country` | string | R | ISO country code |
| `latitude` | decimal | C | -90 to 90; required for map search |
| `longitude` | decimal | C | -180 to 180; required for map search |
| `service_radius_km` | integer | O | 0–1000 |
| `phone` | string | O | E.164 |
| `email` | string | O | Valid email |
| `hours` | structured | O | Structured weekly hours |
| `is_primary` | boolean | O | Only one primary per organization |
| `status` | enum | R | active, inactive |

---

## Plan

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `name` | string | R | Unique |
| `plan_type` | enum | R | individual_free, fleet_20, fleet_50, fleet_100, provider_basic, provider_pro, vendor_basic, vendor_pro, custom |
| `max_vehicles` | integer | O | Null means unlimited |
| `max_users` | integer | O | Null means unlimited |
| `description` | string | O | Max 500 chars |
| `status` | enum | R | active, inactive |

---

## Entitlement

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `plan_id` | reference | R | Must exist |
| `entitlement_key` | string | R | Unique per plan |
| `value_type` | enum | R | boolean, integer, string |
| `value` | string | R | Must match value_type |

Examples:

- `ai_tools_enabled`
- `fleet_reports_enabled`
- `inventory_bulk_import_enabled`
- `appointment_calendar_enabled`
- `export_enabled`

---

## Subscription

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `organization_id` | reference | R | Must exist |
| `plan_id` | reference | R | Must exist |
| `status` | enum | R | trial, active, past_due, expired, manual |
| `started_at` | datetime | R | System timestamp |
| `expires_at` | datetime | O | Future date if active |
| `billing_mode` | enum | R | manual, self_serve_future |
| `vehicle_limit_override` | integer | O | >= 0 |
| `user_limit_override` | integer | O | >= 0 |

### Rule

One active subscription per organization.

---

# 6. Vehicles

## Vehicle

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `owner_type` | enum | R | user, organization |
| `owner_id` | reference | R | Must exist |
| `vin` | string | O | 17 chars, alphanumeric, exclude I/O/Q, uppercase |
| `vin_hash` | string | S | Hashed VIN for matching |
| `license_plate` | string | O | Max 20 chars |
| `nickname` | string | O | 1–60 chars |
| `brand_node_id` | reference | R | Taxonomy vehicle brand |
| `model_node_id` | reference | R | Taxonomy vehicle model |
| `series_node_id` | reference | O | Taxonomy vehicle series |
| `year` | integer | R | 1950 to current year + 2 |
| `engine_type_node_id` | reference | O | Taxonomy engine type |
| `fuel_type_node_id` | reference | O | Taxonomy fuel type |
| `transmission` | enum | O | manual, automatic, cvt, other |
| `drivetrain` | enum | O | fwd, rwd, awd, 4wd |
| `body_style` | enum | O | sedan, hatchback, coupe, suv, pickup, van, other |
| `color` | string | O | Max 50 chars |
| `mileage` | integer | O | 0–2,000,000 |
| `status` | enum | R | Vehicle status enum |
| `profile_completeness` | integer | S | 0–100 |

### Conditional rules

- Individual users may have max 5 active vehicles.
- Fleet organizations limited by plan.
- If VIN exists, it should be unique per active vehicle within the owner.
- Duplicate VIN across owners should trigger warning, not hard block, unless active conflict.

---

## VehicleDocument

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `vehicle_id` | reference | R | Must exist |
| `document_type` | enum | R | insurance, registration, warranty, invoice, inspection_report, other |
| `title` | string | R | 2–120 chars |
| `media_asset_id` | reference | R | Must exist |
| `visibility` | enum | R | private, shared_with_provider, fleet |
| `uploaded_by` | reference | R | User reference |
| `expires_at` | date | O | Future date for expiring docs |
| `status` | enum | R | active, removed |

---

## VehicleServiceRecord

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `vehicle_id` | reference | R | Must exist |
| `service_date` | date | R | Not future |
| `provider_organization_id` | reference | C | Required if provider logged |
| `service_system_node_id` | reference | R | Taxonomy service system |
| `service_task_node_id` | reference | O | Taxonomy service task |
| `description` | text | O | Max 4000 chars |
| `cost_amount` | decimal | O | >= 0 |
| `currency` | string | C | ISO currency if cost exists |
| `warranty_note` | string | O | Max 500 chars |
| `source_type` | enum | R | user_manual, provider_logged, appointment_completed, invoice_upload |
| `verification_status` | enum | R | self_reported, provider_confirmed, appointment_verified, invoice_verified, admin_verified |
| `appointment_id` | reference | C | Required if source is appointment_completed |
| `status` | enum | R | active, disputed, removed |

---

## VehicleIssue

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `vehicle_id` | reference | R | Must exist |
| `title` | string | R | 3–120 chars |
| `description` | text | R | 10–3000 chars |
| `symptom_node_id` | reference | O | Taxonomy symptom |
| `urgency_level` | enum | R | low, medium, high, safety_critical |
| `status` | enum | R | open, investigating, scheduled, resolved, cancelled |
| `reported_by_user_id` | reference | R | Must exist |
| `fleet_approval_status` | enum | C | pending, approved, rejected; required for fleet driver reports |
| `converted_appointment_id` | reference | O | Appointment created from issue |
| `ai_triage_summary` | text | O | AI-generated, insight-controlled |
| `resolved_at` | datetime | O | Required when resolved |

---

## MaintenanceReminder

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `vehicle_id` | reference | R | Must exist |
| `reminder_type` | enum | R | oil, brakes, tires, battery, inspection, seasonal, custom |
| `title` | string | R | 3–120 chars |
| `reason` | string | O | Max 500 chars |
| `due_by_mileage` | integer | O | >= 0 |
| `due_by_date` | date | O | Current/future |
| `priority` | enum | R | low, medium, high |
| `status` | enum | R | upcoming, due, overdue, completed, dismissed |

### Rule

At least one of `due_by_mileage` or `due_by_date` is required.

---

# 7. Taxonomy

## TaxonomyNode

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `type` | enum | R | vehicle_brand, vehicle_model, vehicle_series, engine_type, fuel_type, service_system, service_task, part_category, symptom, amenity, badge_type |
| `parent_id` | reference | O | Must be compatible parent type |
| `name` | string | R | 2–120 chars |
| `slug` | string | R | Unique within type |
| `description` | string | O | Max 500 chars |
| `status` | enum | R | active, inactive, deprecated |
| `sort_order` | integer | O | >= 0 |

### Rules

- Model must belong to brand.
- Series must belong to model.
- No circular parent relationships.

---

## TaxonomySynonym

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `taxonomy_node_id` | reference | R | Must exist |
| `term` | string | R | 2–120 chars |
| `locale` | string | R | Default `en` |
| `source` | enum | R | manual, ai_suggested, import |
| `status` | enum | R | active, inactive |

### Rule

Unique per node + term + locale.

---

# 8. Provider Profile and Capabilities

## ProviderProfile

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `organization_id` | reference | R | Unique per provider profile |
| `provider_type` | enum | R | general_mechanic, garage, body_shop, mobile_mechanic, transmission_specialist, suspension_specialist, ev_specialist, tire_shop, detailing, diagnostics, fleet_service_center |
| `description` | text | O | Max 3000 chars |
| `years_in_business` | integer | O | 0–150 |
| `price_tier` | enum | R | budget, mid_range, premium, unspecified |
| `response_time_target` | enum | O | same_day, within_24h, within_48h, within_week |
| `warranty_policy` | text | O | Max 1000 chars |
| `profile_completeness` | integer | S | 0–100 |
| `public_status` | enum | R | draft, published, suspended |

### Publish rules

To publish:

- organization verified or pending allowed by policy
- at least one active location
- at least one service category
- at least one supported brand

---

## ProviderServiceCategory

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `provider_organization_id` | reference | R | Must exist |
| `taxonomy_node_id` | reference | R | Must be service system/task |
| `experience_level` | enum | R | beginner, intermediate, advanced, specialist |
| `visibility` | enum | R | public, private |
| `source` | enum | R | self_declared, ai_suggested, evidence_based |
| `status` | enum | R | active, inactive |

### Rule

Unique per provider + taxonomy node.

---

## ProviderVehicleCoverage

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `provider_organization_id` | reference | R | Must exist |
| `brand_node_id` | reference | R | Must exist |
| `model_node_id` | reference | C | Required if series exists |
| `series_node_id` | reference | O | Must belong to model |
| `engine_node_id` | reference | O | Optional specialization |
| `coverage_level` | enum | R | basic, standard, advanced, specialist |
| `source` | enum | R | self_declared, ai_suggested, evidence_based |
| `status` | enum | R | active, inactive |

---

## ProviderCapability

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `provider_organization_id` | reference | R | Must exist |
| `brand_node_id` | reference | O | Vehicle brand |
| `model_node_id` | reference | C | Required if series exists |
| `series_node_id` | reference | O | Must belong to model |
| `service_system_node_id` | reference | R | Must exist |
| `service_task_node_id` | reference | O | More specific task |
| `confidence_level` | enum | R | self_declared, low_evidence, moderate_evidence, strong_evidence, verified_expert |
| `evidence_count` | integer | S | >= 0 |
| `public_visibility` | boolean | R | Default false |
| `badge_eligible` | boolean | S | System-calculated |
| `source` | enum | R | self_declared, ai_suggested, evidence_based, admin_verified |
| `status` | enum | R | active, inactive, pending_review |

### Rule

Public badge requires at least moderate or strong evidence, depending on trust policy.

---

## ProviderCapabilityEvidence

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `capability_id` | reference | R | Must exist |
| `evidence_type` | enum | R | completed_job, review, portfolio_item, certification, appointment, service_record |
| `reference_entity_type` | string | R | Entity type |
| `reference_entity_id` | ID | R | Must exist |
| `weight` | integer | O | 0–100 |

---

## SkillHeatmapEntry

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `provider_organization_id` | reference | R | Must exist |
| `scope_type` | enum | R | brand, model, service_system, service_task |
| `taxonomy_node_id` | reference | R | Scope reference |
| `score` | decimal | O | 0–100 |
| `confidence` | enum | O | low, moderate, high |
| `trend` | enum | O | rising, stable, declining |
| `evidence_summary` | text | O | Max 1000 chars |
| `local_demand_score` | decimal | O | 0–100 |
| `generated_at` | datetime | S | AI batch/event timestamp |
| `status` | enum | R | active, expired, hidden |

---

## ProviderBadge

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `provider_organization_id` | reference | R | Must exist |
| `badge_type` | enum | R | verified_business, high_response_rate, repeat_customer_favorite, category_specialist, fleet_friendly, ev_ready, custom |
| `title` | string | R | 3–100 chars |
| `reason` | string | R | Max 500 chars |
| `awarded_at` | datetime | S | System timestamp |
| `expires_at` | datetime | O | Optional expiry |
| `visibility` | enum | R | public, private |
| `status` | enum | R | active, revoked, expired |

---

## ProviderAvailabilityRule

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `provider_organization_id` | reference | R | Must exist |
| `location_id` | reference | R | Must exist |
| `day_of_week` | integer | R | 0–6 |
| `start_time` | time | R | Valid time |
| `end_time` | time | R | Must be after start_time |
| `max_concurrent_appointments` | integer | O | >= 1 |
| `buffer_minutes` | integer | O | 0–240 |
| `status` | enum | R | active, inactive |

---

# 9. Portfolio and Media

## PortfolioItem

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `provider_organization_id` | reference | R | Must exist |
| `title` | string | R | 3–140 chars |
| `description` | text | O | Max 3000 chars |
| `brand_node_id` | reference | O | Vehicle brand |
| `model_node_id` | reference | O | Vehicle model |
| `series_node_id` | reference | O | Vehicle series |
| `service_system_node_id` | reference | R | Must exist |
| `service_task_node_id` | reference | O | Optional task |
| `job_date` | date | O | Not future |
| `consent_status` | enum | R | not_requested, granted, withdrawn, unknown |
| `visibility` | enum | R | draft, private, public, unlisted |
| `ai_caption` | text | O | AI-generated |
| `provider_approved_caption` | text | O | Human-approved |
| `status` | enum | R | draft, pending_review, published, rejected, archived |

### Rule

Public portfolio requires:

- at least one media asset
- consent granted if customer/vehicle identifiable

---

## MediaAsset

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `owner_type` | enum | R | user, organization |
| `owner_id` | reference | R | Must exist |
| `media_type` | enum | R | image, video, document |
| `storage_reference` | string | R | Storage key |
| `thumbnail_reference` | string | O | For image/video |
| `uploaded_by` | reference | R | User reference |
| `file_size_bytes` | integer | O | > 0 |
| `mime_type` | string | O | Allowed types only |
| `consent_status` | enum | R | not_required, not_requested, granted, withdrawn |
| `redaction_status` | enum | R | not_needed, pending, completed, failed |
| `moderation_status` | enum | R | pending, approved, rejected |
| `status` | enum | R | active, removed |

### Validation

- Max file size defined by platform policy.
- Allowed media types only.
- Public media must be moderation-approved.

---

# 10. Reviews and Trust

## Review

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `author_user_id` | reference | R | Must exist |
| `subject_organization_id` | reference | R | Must exist |
| `subject_type` | enum | R | provider, vendor |
| `context_vehicle_id` | reference | O | Vehicle context |
| `context_appointment_id` | reference | C | Required for appointment-verified review |
| `context_service_record_id` | reference | O | Optional evidence |
| `overall_rating` | integer | R | 1–5 |
| `quality_rating` | integer | O | 1–5 |
| `communication_rating` | integer | O | 1–5 |
| `timeliness_rating` | integer | O | 1–5 |
| `price_rating` | integer | O | 1–5 |
| `cleanliness_rating` | integer | O | 1–5 |
| `title` | string | O | 3–120 chars |
| `body` | text | R | 10–5000 chars |
| `service_category_node_id` | reference | O | Related category |
| `verified_status` | enum | R | unverified, appointment_verified, invoice_verified, provider_confirmed, admin_verified |
| `status` | enum | R | draft, pending_moderation, published, rejected, removed |
| `published_at` | datetime | O | System timestamp |

### Rules

- User cannot review their own organization.
- One review per user per appointment/service context.
- Verified review requires matching evidence.

---

## ReviewTag

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `review_id` | reference | R | Must exist |
| `taxonomy_node_id` | reference | R | Must exist |
| `sentiment` | enum | R | positive, neutral, negative |
| `source` | enum | R | user_selected, ai_suggested |

### Rule

Unique per review + tag.

---

## ReviewResponse

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `review_id` | reference | R | Must exist |
| `organization_id` | reference | R | Must match review subject |
| `response_text` | text | R | 1–3000 chars |
| `ai_assisted` | boolean | R | Default false |
| `status` | enum | R | draft, published, removed |
| `published_at` | datetime | O | Required when published |
| `responded_by_user_id` | reference | R | Must exist |

### Rule

One published response per review.

---

## ReviewReport

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `review_id` | reference | R | Must exist |
| `reported_by` | reference | R | User, organization, or system |
| `reason` | enum | R | fake, abusive, off_topic, privacy, misleading, spam, other |
| `details` | text | O | Max 2000 chars |
| `status` | enum | R | open, investigating, resolved, dismissed |
| `resolved_at` | datetime | O | Required when resolved |

---

# 11. Appointments

## Appointment

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `requester_type` | enum | R | user, organization |
| `requester_id` | reference | R | Must exist |
| `provider_organization_id` | reference | R | Must be provider/hybrid |
| `vehicle_id` | reference | R | Must exist |
| `service_system_node_id` | reference | R | Must exist |
| `service_task_node_id` | reference | O | Optional task |
| `description` | text | R | 10–3000 chars |
| `urgency_level` | enum | R | low, medium, high, safety_critical |
| `preferred_start_at` | datetime | O | Future datetime |
| `preferred_end_at` | datetime | O | Must be after preferred_start_at |
| `confirmed_start_at` | datetime | C | Required when confirmed |
| `confirmed_end_at` | datetime | O | Must be after confirmed_start_at |
| `estimated_duration_minutes` | integer | O | 5–1440 |
| `status` | enum | R | Appointment status enum |
| `cancellation_reason` | string | O | Max 500 chars |
| `completed_at` | datetime | C | Required when completed |
| `consent_to_share_history` | boolean | R | Must be true before history sharing |
| `consent_reference_id` | reference | C | Required if sharing vehicle history |

### Rules

- Vehicle must belong to requester or requester’s fleet.
- Provider must be active and publishable.
- Confirmed appointment must have confirmed start time.
- Completed appointment can generate service record and review invitation.

---

## AppointmentStatusHistory

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `appointment_id` | reference | R | Must exist |
| `old_status` | enum | O | Null for creation event |
| `new_status` | enum | R | Appointment status enum |
| `changed_by` | reference | R | User/system |
| `note` | string | O | Max 500 chars |
| `changed_at` | datetime | S | Immutable |

---

## AppointmentNote

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `appointment_id` | reference | R | Must exist |
| `author_user_id` | reference | R | Must exist |
| `note_type` | enum | R | internal, customer_visible |
| `body` | text | R | 1–3000 chars |

### Rule

Internal notes visible only to provider staff and relevant fleet approvers if shared.

---

## AppointmentParticipant

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `appointment_id` | reference | R | Must exist |
| `user_id` | reference | R | Must exist |
| `organization_id` | reference | O | Participant org context |
| `participant_role` | enum | R | requester, fleet_manager, driver, service_advisor, technician |
| `status` | enum | R | active, removed |

---

## PreVisitReport

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `appointment_id` | reference | R | Unique per appointment |
| `vehicle_summary` | text | R | Max 2000 chars |
| `issue_summary` | text | R | Max 2000 chars |
| `ai_triage_summary` | text | O | AI-generated |
| `relevant_history_summary` | text | O | Max 3000 chars |
| `suggested_focus_areas` | list | O | Taxonomy or text entries |
| `urgency_level` | enum | R | low, medium, high, safety_critical |
| `consent_reference_id` | reference | C | Required if history/media shared |
| `generated_at` | datetime | S | System timestamp |
| `status` | enum | R | draft, generated, shared, archived |

---

# 12. Vendor Inventory

## VendorProfile

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `organization_id` | reference | R | Unique per vendor profile |
| `vendor_type` | enum | R | parts_retailer, wholesaler, used_parts, performance_parts, oem_supplier, tire_specialist, battery_specialist, accessories |
| `description` | text | O | Max 3000 chars |
| `delivery_options` | list | O | pickup, delivery, shipping_future |
| `pickup_available` | boolean | R | Default false |
| `trade_customers_supported` | boolean | R | Default false |
| `return_policy` | text | O | Max 1000 chars |
| `warranty_policy` | text | O | Max 1000 chars |
| `profile_completeness` | integer | S | 0–100 |
| `public_status` | enum | R | draft, published, suspended |

---

## InventoryItem

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `vendor_organization_id` | reference | R | Must exist |
| `sku` | string | R | 1–80 chars, unique within vendor |
| `name` | string | R | 3–160 chars |
| `normalized_name` | string | S | AI/system normalized |
| `brand` | string | O | Max 100 chars |
| `oem_number` | string | O | Max 100 chars |
| `aftermarket_number` | string | O | Max 100 chars |
| `part_category_node_id` | reference | R | Must exist |
| `condition` | enum | R | new, used, refurbished, remanufactured |
| `price_public` | decimal | C | >= 0; required if public price visible |
| `price_trade` | decimal | O | >= 0 |
| `price_on_request` | boolean | O | Allows hidden pricing |
| `currency` | string | C | ISO currency if price exists |
| `stock_quantity` | integer | O | >= 0 |
| `stock_status` | enum | R | in_stock, low_stock, out_of_stock, available_on_request |
| `location_id` | reference | O | Vendor location |
| `warranty_note` | string | O | Max 500 chars |
| `visibility` | enum | R | public, trade_only, hidden |
| `data_quality_score` | integer | S | 0–100 |
| `status` | enum | R | draft, active, pending_review, hidden, discontinued, removed |

### Rules

- SKU unique per vendor.
- Public item requires category and name.
- If `price_public` absent, `price_on_request` should be true.
- Trade-only items not visible to normal users.

---

## InventoryFitment

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `inventory_item_id` | reference | R | Must exist |
| `brand_node_id` | reference | R | Must exist |
| `model_node_id` | reference | C | Required if series exists |
| `series_node_id` | reference | O | Must belong to model |
| `year_start` | integer | O | Valid year |
| `year_end` | integer | O | >= year_start |
| `engine_node_id` | reference | O | Optional |
| `notes` | string | O | Max 500 chars |
| `confidence` | enum | R | confirmed, likely, uncertain |
| `source` | enum | R | manual, csv_import, ai_suggested, vendor_confirmed |
| `status` | enum | R | active, inactive |

---

## StockInquiry

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `inventory_item_id` | reference | R | Must exist |
| `vendor_organization_id` | reference | R | Must match item vendor |
| `requester_type` | enum | R | user, provider, fleet |
| `requester_id` | reference | R | Must exist |
| `vehicle_id` | reference | O | Optional fitment context |
| `message` | text | R | 10–2000 chars |
| `status` | enum | R | open, answered, reserved, unavailable, completed, cancelled |
| `response_note` | text | O | Max 2000 chars |
| `responded_at` | datetime | O | Required when answered |

---

# 13. Fleet Management

## FleetProfile

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `organization_id` | reference | R | Unique per fleet profile |
| `fleet_size` | integer | R | 1–100000 |
| `industry` | string | O | Max 100 chars |
| `approval_workflow_enabled` | boolean | R | Default true |
| `preferred_provider_mode` | enum | R | strict, preferred, suggested |
| `reporting_currency` | string | R | ISO currency |
| `status` | enum | R | active, suspended, archived |

---

## FleetVehicleAssignment

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `vehicle_id` | reference | R | Must exist |
| `driver_user_id` | reference | R | Must exist |
| `assigned_by` | reference | R | Fleet manager/admin |
| `assigned_at` | datetime | R | System/user timestamp |
| `ended_at` | datetime | O | Must be after assigned_at |
| `status` | enum | R | active, ended |

### Rule

One active assignment per vehicle.

---

## FleetPreferredProvider

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `fleet_organization_id` | reference | R | Must exist |
| `provider_organization_id` | reference | R | Must exist |
| `service_category_node_id` | reference | O | Optional category specificity |
| `priority` | integer | R | 1–10 |
| `notes` | string | O | Max 500 chars |
| `status` | enum | R | active, inactive |

---

## FleetApproval

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `fleet_organization_id` | reference | R | Must exist |
| `vehicle_id` | reference | R | Must exist |
| `related_issue_id` | reference | O | Optional source issue |
| `related_appointment_id` | reference | O | Optional appointment |
| `requested_by_user_id` | reference | R | Must exist |
| `approver_user_id` | reference | C | Required once decided |
| `approval_type` | enum | R | repair_request, provider_selection, cost_estimate |
| `status` | enum | R | pending, approved, rejected, needs_more_info |
| `decision_reason` | string | O | Max 500 chars |
| `decided_at` | datetime | C | Required when decided |

---

# 14. Community/Social

## Follow

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `user_id` | reference | R | Must exist |
| `organization_id` | reference | R | Must exist |
| `status` | enum | R | active, unfollowed |

### Rule

Unique active follow per user + organization.

---

## Post

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `author_organization_id` | reference | R | Must exist |
| `post_type` | enum | R | showcase, tip, availability, event, educational |
| `title` | string | O | 3–140 chars |
| `body` | text | R | 10–3000 chars |
| `visibility` | enum | R | public, unlisted, private |
| `moderation_status` | enum | R | pending, approved, rejected |
| `published_at` | datetime | O | Required when public |

---

## Comment

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `target_type` | enum | R | post, question, answer, showcase |
| `target_id` | reference | R | Must exist |
| `author_user_id` | reference | R | Must exist |
| `body` | text | R | 1–2000 chars |
| `status` | enum | R | active, hidden, removed |
| `moderation_status` | enum | R | pending, approved, rejected |

---

## Reaction

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `target_type` | enum | R | post, comment, question, answer, showcase |
| `target_id` | reference | R | Must exist |
| `user_id` | reference | R | Must exist |
| `reaction_type` | enum | R | helpful, like, thanks |

### Rule

Unique per user + target + reaction type.

---

## Question

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `author_user_id` | reference | R | Must exist |
| `vehicle_id` | reference | O | Optional context |
| `title` | string | R | 5–160 chars |
| `body` | text | R | 10–5000 chars |
| `category_node_id` | reference | O | Taxonomy category |
| `status` | enum | R | open, answered, closed, hidden |
| `accepted_answer_id` | reference | O | Must belong to question |
| `moderation_status` | enum | R | pending, approved, rejected |

---

## Answer

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `question_id` | reference | R | Must exist |
| `author_user_id` | reference | R | Must exist |
| `author_organization_id` | reference | O | If answering as organization |
| `body` | text | R | 10–5000 chars |
| `helpful_count` | integer | S | >= 0 |
| `status` | enum | R | active, hidden, removed |
| `moderation_status` | enum | R | pending, approved, rejected |

---

# 15. Notifications and Preferences

## Notification

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `recipient_type` | enum | R | user, organization |
| `recipient_id` | reference | R | Must exist |
| `channel` | enum | R | in_app, email, push, sms |
| `notification_type` | enum | R | appointment, review, inquiry, fleet_approval, ai_suggestion, system, marketing |
| `title` | string | R | 3–140 chars |
| `body` | text | R | 1–1000 chars |
| `reference_entity_type` | string | O | Optional target type |
| `reference_entity_id` | ID | O | Optional target ID |
| `read_at` | datetime | O | Set when read |
| `status` | enum | R | pending, sent, failed, read |

---

## NotificationPreference

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `user_id` | reference | R | Must exist |
| `channel` | enum | R | in_app, email, push, sms |
| `notification_category` | enum | R | appointments, reviews, inquiries, fleet_approvals, ai_suggestions, system, marketing |
| `enabled` | boolean | R | True/false |

### Rule

Unique per user + channel + category.

---

# 16. AI/MCP and Governance

## McpClient

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `name` | string | R | Unique |
| `client_type` | enum | R | internal_assistant, matching_engine, moderation_assistant, analytics_engine, partner_agent_future |
| `status` | enum | R | active, suspended, revoked |
| `rate_limit_policy` | string | O | Policy reference |
| `allowed_scopes` | list | R | Scoped permissions |
| `environment` | enum | R | dev, staging, prod |

---

## McpAccessLog

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `mcp_client_id` | reference | R | Must exist |
| `principal_type` | enum | R | user, organization, system |
| `principal_id` | reference | R | Must exist |
| `organization_id` | reference | O | Tenant context |
| `operation_type` | enum | R | resource_read, tool_invoke |
| `resource_or_tool_id` | string | R | Resource/tool identifier |
| `context_entity_type` | string | O | Context target type |
| `context_entity_id` | ID | O | Context target ID |
| `consent_reference_id` | reference | O | Required for sensitive context |
| `policy_decision` | enum | R | allowed, denied, consent_required, error |
| `result_status` | enum | R | success, failure, partial |
| `latency_ms` | integer | O | >= 0 |
| `created_at` | datetime | S | Immutable |

---

## AiInsight

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `insight_type` | enum | R | skill_heatmap, profile_suggestion, review_theme, maintenance_suggestion, inventory_normalization, match_explanation, fraud_flag, moderation_recommendation |
| `subject_entity_type` | string | R | Entity type |
| `subject_entity_id` | ID | R | Entity ID |
| `source_tool_id` | string | R | MCP tool ID |
| `source_client_id` | reference | O | MCP client |
| `model_version` | string | O | Model identifier |
| `prompt_version` | string | O | Prompt identifier |
| `confidence_score` | integer | O | 0–100 |
| `summary` | text | R | 1–2000 chars |
| `structured_payload` | structured | O | Machine-readable output |
| `evidence_references` | list | O | References to evidence |
| `approval_status` | enum | R | not_required, pending, approved, rejected |
| `created_at` | datetime | S | Immutable |

---

## AiSuggestion

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `insight_id` | reference | R | Must exist |
| `target_entity_type` | string | R | Entity type |
| `target_entity_id` | ID | R | Entity ID |
| `suggestion_text` | text | R | 1–2000 chars |
| `suggested_action` | enum | R | add, update, remove, publish_draft, confirm, review |
| `status` | enum | R | pending, accepted, rejected, expired |
| `accepted_at` | datetime | C | Required if accepted |
| `rejected_at` | datetime | C | Required if rejected |

---

## ApprovalRequest

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `requested_by_client_id` | reference | O | MCP client |
| `requested_by_user_id` | reference | O | User if human-initiated |
| `action_type` | enum | R | publish_content, send_request, update_profile, confirm_fitment, moderate_content, admin_action |
| `subject_entity_type` | string | R | Entity type |
| `subject_entity_id` | ID | R | Entity ID |
| `risk_level` | enum | R | low, medium, high, critical |
| `summary` | text | R | 1–1000 chars |
| `payload_reference` | string | O | Reference to draft/payload |
| `approver_role` | enum | R | provider_admin, vendor_admin, fleet_manager, admin |
| `status` | enum | R | pending, approved, rejected, expired |
| `decision_reason` | string | O | Max 500 chars |
| `decided_by` | reference | C | Required when decided |
| `decided_at` | datetime | C | Required when decided |

---

# 17. Audit, Moderation, Feature Flags

## AuditLog

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `actor_type` | enum | R | user, admin, system, mcp_client |
| `actor_id` | reference | R | Must exist |
| `organization_id` | reference | O | Tenant context |
| `action` | string | R | Action identifier |
| `entity_type` | string | R | Affected entity type |
| `entity_id` | ID | R | Affected entity ID |
| `previous_state_summary` | text | O | Max 2000 chars |
| `new_state_summary` | text | O | Max 2000 chars |
| `reason` | string | O | Max 500 chars |
| `created_at` | datetime | S | Immutable |

---

## FeatureFlag

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `key` | string | R | Unique |
| `description` | string | O | Max 500 chars |
| `enabled` | boolean | R | True/false |
| `target_type` | enum | O | global, user, organization, plan, environment |
| `target_id` | reference | C | Required if target not global |
| `environment` | enum | R | dev, staging, prod |

---

## ModerationCase

| Field | Type | Req/Opt | Validation / Rule |
|---|---|---|---|
| `case_type` | enum | R | review, post, comment, portfolio, inventory_item, question, answer |
| `target_entity_type` | string | R | Entity type |
| `target_entity_id` | ID | R | Entity ID |
| `reported_by` | reference | O | User/system |
| `reason` | enum | R | spam, fake, abusive, privacy, unsafe, counterfeit, misleading, other |
| `severity` | enum | R | low, medium, high, critical |
| `ai_risk_score` | integer | O | 0–100 |
| `status` | enum | R | open, investigating, action_taken, dismissed, escalated |
| `assigned_to` | reference | O | Admin user |
| `resolution` | text | O | Max 1000 chars |
| `resolved_at` | datetime | C | Required when resolved |

---

# 18. Cross-Entity Validation Rules

These rules apply across multiple entities.

## Vehicle limits

- Individual free user: max 5 active vehicles.
- Fleet organization: active vehicles cannot exceed plan limit.
- Archived/sold vehicles should not count toward active limits.

## Organization publish rules

A provider organization can be public only if:

- organization status is active
- at least one active location exists
- provider profile is complete enough
- at least one service category exists
- at least one supported brand exists

A vendor organization can be public only if:

- organization status is active
- at least one active location exists
- vendor profile is complete enough
- at least one inventory item exists or profile explicitly says catalog coming soon

## Review trust rules

A review can be marked appointment-verified only if:

- appointment exists
- appointment is completed
- review author is connected to the appointment

A review can be invoice-verified only if:

- a document of type invoice exists
- document is linked to vehicle or service record
- user consent allows verification use

## Appointment rules

An appointment can be confirmed only if:

- provider accepted or proposed accepted
- confirmed start time exists
- vehicle context exists
- consent exists if service history is shared

An appointment can be completed only if:

- status passed through confirmed or checked-in
- completed timestamp exists
- provider logged outcome or service record is created

## Inventory rules

An inventory item can be public only if:

- vendor profile is published
- item status is active
- item has category
- item has name
- price is public or marked price-on-request

Fitment can be marked confirmed only if:

- vendor manually confirms it, or
- trusted structured data supports it

## AI/MCP rules

AI insight can affect public data only if:

- relevant approval exists, or
- policy marks the action as low-risk and non-public

AI suggestion can be accepted only if:

- target entity exists
- user has permission to modify target
- suggestion is still pending

---

# 19. Field Validation Standards

## Text fields

| Category | Default max length |
|---|---:|
| Names/titles | 120–160 chars |
| Short descriptions | 500–1000 chars |
| Long descriptions | 2000–5000 chars |
| Internal notes | 500–3000 chars |

All user-entered text should be:

- trimmed
- sanitized
- checked for private information where relevant
- moderated if public

## Numeric fields

| Field type | Rule |
|---|---|
| Ratings | Integer 1–5 |
| Scores | 0–100 |
| Quantities | Integer >= 0 |
| Money | Decimal >= 0 |
| Distance | Kilometers/miles according to locale |
| Duration | Positive integer minutes |

## Date/time fields

| Field type | Rule |
|---|---|
| Past events | Cannot be future unless logically allowed |
| Appointments | Future or current |
| Expiry dates | Future when created |
| Timestamps | UTC-normalized recommended |

## Reference fields

All reference fields must:

- point to an existing record
- respect tenant isolation
- respect permission rules
- avoid circular references where hierarchy exists

---

# 20. MVP Data Dictionary Priorities

## Must-have entities

- UserAccount
- Organization
- OrganizationLocation
- RoleMembership
- Subscription/Plan
- Vehicle
- VehicleServiceRecord
- VehicleIssue
- TaxonomyNode
- ProviderProfile
- ProviderCapability
- ProviderVehicleCoverage
- PortfolioItem
- MediaAsset
- Review
- ReviewResponse
- Appointment
- PreVisitReport
- VendorProfile
- InventoryItem
- InventoryFitment
- StockInquiry
- FleetProfile
- FleetApproval
- ConsentRecord
- McpClient
- McpAccessLog
- AiInsight
- ApprovalRequest
- AuditLog
- ModerationCase

## Secondary but useful

- SkillHeatmapEntry
- ProviderBadge
- MaintenanceReminder
- Post
- Question/Answer
- Reaction
- NotificationPreference
- FeatureFlag
