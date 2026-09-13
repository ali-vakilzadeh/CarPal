# MVP Vision

## Product essence

The MVP is a **trust-first automotive social network** that helps car owners, fleet managers, repair professionals, and parts vendors connect through verified expertise, transparent reputation, and intelligent matching.

The core promise is:

> **“Find the right trusted expert for your exact vehicle and problem—not just the nearest shop.”**

The MVP should already feel intelligent, but the intelligence should be mostly in the background: helping users describe problems, helping providers present their true strengths, helping vendors make inventory searchable, and helping the platform route each request to the best-matched expert.

---

# 1. MVP Scope Philosophy

The MVP must prove four things:

1. **Trust can be structured**
   - Reviews, service history, before/after proof, and provider capabilities can be turned into reliable expertise signals.

2. **Matching can be specific**
   - A BMW body specialist should not be recommended for a Mercedes suspension issue unless there is evidence.

3. **AI can quietly improve every workflow**
   - Users get help describing issues.
   - Providers get help improving profiles, responding to reviews, and showcasing work.
   - Vendors get help making inventory searchable.
   - The platform gets better at matching.

4. **The platform can become a larger ecosystem**
   - The MVP must seed a comprehensive MCP service so future OBDII, telematics, parts ordering, insurance, fleet systems, and AI agents can plug in cleanly.

---

# 2. MVP Phasing Context

## MVP Phase 1: Core trust network + AI background intelligence

This is the plan below.

### Included in MVP

- User roles and profiles
- Vehicle profiles with VIN-based structure
- Service provider profiles with capability portfolios
- Vendor profiles with searchable inventory
- Reviews, ratings, and trust signals
- Search, discovery, and intelligent matching
- Appointment request and basic scheduling
- Service history logging
- Lightweight social/community features
- AI assistance in the background
- MCP service foundation
- Admin/moderation/trust tooling
- Fleet portal basics for corporate users
- Notification system
- Analytics and audit foundation

### Not fully in MVP, but architected for

These are Phase 2/3 extensions:

- Deep OBDII diagnostics
- Live ECU data interpretation
- Pre-visit OBDII reports to mechanic
- Bluetooth hardware pairing
- Crash detection via mobile gyro
- SOS/emergency calling
- Full payments/checkout
- Full parts commerce
- Live chat
- Shop POS/DMS integrations
- Insurance claim workflows

The MVP should still create data structures and MCP hooks for these future capabilities.

---

# 3. MVP User Roles

The platform supports four primary role families, each with distinct permissions and portals.

---

## 3.1 Normal User — Individual Car Owner

### Who they are

Everyday car owners, enthusiasts, people maintaining personal vehicles.

### Plan

Free tier.

### Vehicle limit

Up to **5 vehicles**.

### Main goals

- Keep vehicle information organized.
- Find trustworthy repair help.
- Understand symptoms and problems.
- Store repair/service history.
- Review providers.
- Follow shops and vendors.
- Ask for help.

### Core features

- Sign up/login
- Create personal profile
- Add up to 5 vehicles
- Build vehicle profile using VIN or manual entry
- View vehicle service history
- Add manual service records
- Search providers and vendors
- Use AI “Help Me” problem triage
- Request appointments
- Leave reviews and star ratings
- Upload photos of issues
- Follow shops/vendors
- Receive maintenance suggestions
- Save favorite providers
- Report problems or unsafe advice

---

## 3.2 Corporate User — Fleet Manager

### Who they are

Companies managing multiple vehicles: delivery fleets, service companies, rental operators, logistics firms, government departments, etc.

### Plan

Paid tiers.

### Suggested MVP vehicle tiers

- 20 vehicles
- 50 vehicles
- 100 vehicles
- Custom by admin/manual plan for larger fleets

For MVP, billing can be simple: admin-managed plans, manual invoicing, or basic subscription stub. Full self-service billing can come later.

### Main goals

- Manage many vehicles in one place.
- Assign drivers or custodians.
- Track service needs and costs.
- Reduce downtime.
- Find reliable providers for specific vehicle types.
- Approve and monitor repair appointments.
- Export reports.

### Fleet portal MVP features

- Fleet organization profile
- Multiple staff users:
  - Fleet owner/admin
  - Fleet manager
  - Driver/operator
  - Maintenance coordinator
- Vehicle list and vehicle detail pages
- Vehicle assignment to drivers
- Mileage tracking
- Service due reminders
- Maintenance status board
- Repair cost logging
- Appointment request workflow
- Provider discovery for fleet vehicle needs
- Basic approval flow:
  - Driver reports issue
  - Manager approves request
  - Manager selects provider
- Service history by vehicle
- Cost summary by vehicle/month/category
- CSV export
- Fleet-level analytics:
  - most repaired vehicles
  - most common issues
  - maintenance spend
  - downtime estimates
- Corporate provider preferences:
  - preferred shops
  - approved vendors

### Future Phase hooks

- Predictive maintenance
- OBDII vehicle health scores
- Driver behavior scoring
- Bulk scheduling
- Integrated invoicing

---

## 3.3 Service Provider

### Who they are

Repair freelancers, independent mechanics, garages, service centers, body shops, tire shops, detailing specialists, EV specialists, mobile mechanics.

### Plan

Free basic profile, with premium/extended provider features.

For MVP, premium features can be enabled by plan or trial, but full monetization can be simplified.

### Main goals

- Be discovered by the right customers.
- Prove expertise.
- Manage appointments.
- Reduce no-shows and wait times.
- Respond to reviews professionally.
- Showcase work.
- Improve ratings.
- Understand what skills to promote.

### Provider profile structure

A provider profile is not just a business listing. It is a **capability portfolio**.

#### Core provider profile fields

- Business name
- Provider type:
  - independent mechanic
  - garage
  - body shop
  - mobile mechanic
  - tire/wheel specialist
  - transmission specialist
  - EV/hybrid specialist
  - detailing/reconditioning
  - diagnostics specialist
  - fleet service center
- Locations
- Service radius
- Working hours
- Contact channels
- Certifications
- Years in business
- Languages
- Amenities:
  - waiting area
  - loaner car
  - pickup/drop-off
  - towing partner
  - EV charging
  - wheelchair access
- Supported brands
- Supported models
- Supported series/generations
- Supported engine/fuel types:
  - petrol
  - diesel
  - hybrid
  - EV
  - PHEV
- Service systems:
  - engine
  - gearbox/transmission
  - brakes
  - suspension/steering
  - electrical
  - HVAC
  - body/paint
  - wheels/tires
  - diagnostics
  - battery/EV systems
  - exhaust
  - cooling
  - interior/detailing
- Specific service tasks:
  - brake pad replacement
  - clutch replacement
  - suspension overhaul
  - engine diagnostics
  - accident repair
  - paint correction
  - wheel alignment
  - battery replacement
  - etc.
- Price indicator:
  - budget
  - mid-range
  - premium
- Warranty policy
- Response time
- Appointment capacity
- Media gallery
- Before/after showcase
- Reviews
- Verified badges

### Provider MVP features

- Provider onboarding wizard
- Profile completeness score
- Unlimited supported brand/model/service combinations
- Service catalog builder
- Portfolio builder
- Before/after project uploads
- Job logging
- Review inbox
- AI-assisted review response
- AI skill heatmap
- AI profile helper
- AI improvement suggestions
- Appointment calendar
- Appointment request management
- Customer pre-visit report viewer
- Simple customer notes
- Basic service history entry for customers
- Public profile page
- Followable provider profile
- Insights dashboard

---

## 3.4 Vendor — Parts Supplier / Seller / Manufacturer

### Who they are

Parts sellers, spare part distributors, used parts yards, performance parts vendors, OEM suppliers, accessory sellers, tire sellers, battery sellers.

### Plan

Free basic profile, premium inventory/search features.

### Main goals

- Make inventory discoverable.
- Connect parts to correct vehicles.
- Receive inquiries from users and providers.
- Build trust through accurate fitment and fulfillment.
- Maintain a secure, searchable inventory database.

### Vendor profile structure

- Vendor name
- Vendor type:
  - parts retailer
  - wholesaler
  - used parts specialist
  - performance parts
  - OEM supplier
  - tire specialist
  - battery specialist
  - accessories
- Locations
- Delivery/pickup options
- Supported brands/models/categories
- Trade/B2B capabilities
- Warranty/return policy
- Business verification
- Inventory catalog
- Price visibility rules
- Stock availability
- Ratings and reviews

### Vendor MVP features

- Vendor onboarding wizard
- Inventory item creation
- Bulk inventory import via CSV
- Inventory categorization
- Fitment mapping to vehicle profiles
- Secure multi-tenant inventory database
- Inventory search
- Public and trade price visibility
- Stock inquiry workflow
- Vendor profile page
- Vendor ratings
- AI inventory normalization
- AI fitment suggestions
- Duplicate detection
- Low-quality listing cleanup
- Inventory analytics:
  - most searched parts
  - missing fitment data
  - popular categories

---

# 4. Core MVP Concept: The Trust Graph

The MVP should not treat “rating” as a single number. It should build a **trust graph** connecting:

- users
- vehicles
- service providers
- vendors
- parts
- service records
- reviews
- photos
- appointments
- capabilities
- locations
- time

This trust graph becomes the foundation for matching.

## Trust signals in MVP

### User-generated signals

- star rating
- written review
- review tags
- photos
- repeat customer behavior
- helpful votes
- Q&A participation

### Provider-generated signals

- completed job logs
- before/after media
- response time
- profile completeness
- service categories
- certifications
- appointment reliability
- review response quality

### Platform-verified signals

- confirmed appointment
- verified invoice upload
- service record confirmation
- review authenticity checks
- moderation outcomes
- dispute outcomes

### AI-derived signals

- skill heatmap
- sentiment themes
- review quality score
- profile confidence score
- likely specialization
- risk/fraud flags

The MVP does not need to expose all of this publicly, but it should store and compute these signals from day one.

---

# 5. MVP Data Model / Domain Structure

This is the conceptual structure of the platform.

---

## 5.1 Identity and Accounts

### User Account

Represents a human login.

Fields:

- account ID
- name
- contact info
- authentication method
- role preferences
- notification preferences
- privacy settings
- consent settings
- AI personalization preferences
- status
- last active

### Role Membership

A user can belong to multiple organizations or act as individual.

Examples:

- John is an individual car owner.
- John also works at Mike’s Shop.
- Sarah is a fleet manager at Logistics Co.

Fields:

- user
- organization
- role
- permissions
- status

---

## 5.2 Organizations

### Organization

Represents a business or fleet entity.

Types:

- service provider
- vendor
- fleet/corporate
- hybrid provider+vendor

Fields:

- organization ID
- legal/business name
- display name
- type
- verification status
- plan/tier
- locations
- contacts
- operating hours
- public profile
- trust score
- status

### Organization Location

Fields:

- address
- geo coordinates
- service radius
- opening hours
- access instructions
- phone
- primary contact

---

## 5.3 Vehicles

### Vehicle

Fields:

- vehicle ID
- owner account or fleet organization
- VIN
- license plate optional
- nickname
- brand
- model
- series/generation
- make year
- engine type
- fuel type
- transmission
- drivetrain
- body style
- color
- mileage
- status
- notes
- profile completeness

### Vehicle Profile Enrichment

AI or VIN decode can enrich:

- exact model variant
- engine code
- common issues
- maintenance schedule categories
- compatible service categories
- compatible part categories

For MVP, VIN decode can be optional or manual. The architecture should support a third-party VIN decoder later.

### Vehicle Service Record

Fields:

- vehicle
- date
- service provider
- service category
- service task
- description
- parts used
- cost estimate
- warranty notes
- evidence:
  - invoice
  - photos
  - appointment record
  - OBD code future
- verified status
- created by
- visible to

---

## 5.4 Taxonomy

This is critical. The platform needs a controlled vocabulary.

### Brand

Examples:

- BMW
- Mercedes-Benz
- Toyota
- Ford
- Volkswagen
- Tesla

### Model

Examples:

- 3 Series
- C-Class
- Corolla
- Transit
- Golf
- Model 3

### Series / Generation

Examples:

- E46
- E90
- W205
- MK7
- Mk8
- TNGA
- etc.

### Engine / Powertrain Attributes

- petrol
- diesel
- hybrid
- plug-in hybrid
- electric
- performance variant
- engine code where available

### Service System Categories

Examples:

- engine
- transmission/drivetrain
- brakes
- suspension/steering
- electrical/electronics
- HVAC
- cooling system
- exhaust
- body/paint
- wheels/tires
- diagnostics
- detailing
- EV battery systems
- safety systems

### Service Task Categories

Examples:

- inspection
- oil service
- brake repair
- clutch replacement
- suspension repair
- engine rebuild
- diagnostic scan
- wheel alignment
- accident repair
- paint correction
- battery replacement
- tire replacement

### Part Categories

Examples:

- brake pads
- rotors
- control arms
- struts
- water pumps
- alternators
- sensors
- body panels
- lighting
- filters
- batteries
- tires
- electronics

### Symptom Categories

Examples:

- squeaking noise
- grinding noise
- vibration
- pulling to one side
- warning light
- overheating
- no start
- rough idle
- oil leak
- battery drain
- AC not cooling

This taxonomy powers:

- profiles
- search
- AI matching
- skill heatmaps
- inventory fitment
- service records
- review tagging

---

## 5.5 Provider Capabilities

### Provider Capability

Represents what a provider claims or proves they can do.

Fields:

- provider
- brand
- model
- series
- service system
- service task
- source:
  - self-declared
  - AI-suggested
  - job evidence
  - review evidence
  - certification
- confidence level
- evidence count
- public visibility
- badge eligibility

### Skill Heatmap Entry

AI-generated summary of capability strength.

Fields:

- provider
- capability scope
- score
- confidence
- recency
- evidence types
- trend
- explanation summary

Example narrative output:

> “This provider shows strong evidence for BMW 3 Series bodywork based on 34 completed jobs, 29 five-star reviews, 21 before/after photo sets, and repeated customer mentions of paint quality and panel alignment.”

---

## 5.6 Portfolio and Media

### Portfolio Item

Fields:

- provider
- title
- description
- vehicle brand/model/series
- service category
- before media
- after media
- job date
- consent status
- moderation status
- AI caption
- tags
- public/private

### Media Asset

Fields:

- asset ID
- owner entity
- type: image/video/document
- thumbnail
- moderation status
- privacy level
- EXIF stripped flag
- redaction status
- consent status

---

## 5.7 Reviews and Trust

### Review

Fields:

- review ID
- author user
- subject organization
- context:
  - vehicle
  - service category
  - appointment
  - service record
- overall star rating
- sub-ratings:
  - work quality
  - communication
  - timeliness
  - price fairness
  - cleanliness
- text
- tags
- photos
- verified status
- status
- helpful count
- report status
- AI sentiment
- AI themes
- provider response

### Provider Response

Fields:

- review
- response text
- response status:
  - draft
  - published
- AI-assisted flag
- responded by
- timestamp

### Review Request

Fields:

- appointment/service record
- invited user
- channel
- reminder count
- conversion status

### Dispute/Report

Fields:

- target entity
- reason
- status
- moderator notes
- resolution

---

## 5.8 Appointments

### Appointment Request

Fields:

- requester user or fleet
- provider
- vehicle
- service need
- symptom/category
- urgency
- description
- photos
- preferred time windows
- status
- source:
  - direct search
  - AI match
  - review profile
  - fleet workflow
- assigned staff
- estimated duration
- notes

### Appointment Statuses

- draft
- requested
- provider reviewing
- proposed alternative
- confirmed
- checked in
- in progress
- awaiting parts
- ready for pickup
- completed
- cancelled
- no-show

### Pre-Visit Report

Generated before the appointment.

Contents:

- vehicle summary
- reported symptoms
- AI triage summary
- user photos
- service history summary
- prior related repairs
- known warnings
- likely service categories
- suggested diagnostic focus
- customer preferences
- fleet approval status if applicable

Phase 2 will add OBDII data here.

---

## 5.9 Vendor Inventory

### Inventory Item

Fields:

- vendor
- SKU
- name
- brand
- OEM/aftermarket/used/refurbished
- part numbers
- category
- subcategory
- condition
- price
- trade price
- stock quantity
- location
- images
- notes
- warranty
- fitment data
- visibility rules
- status

### Fitment Record

Fields:

- inventory item
- brand
- model
- series
- year range
- engine/fuel type
- notes
- confidence
- source:
  - manual
  - CSV import
  - AI-suggested
  - manufacturer data future

### Stock Inquiry

Fields:

- requester
- vendor
- inventory item
- vehicle context
- message
- status:
  - sent
  - answered
  - reserved
  - unavailable
  - completed

For MVP, no full checkout. Inquiry/reservation is enough.

---

## 5.10 Social/Community

### Follow

Fields:

- follower user
- followed organization
- notification preference

### Post / Update

Lightweight social object.

Fields:

- author organization
- type:
  - before/after showcase
  - service availability
  - seasonal advice
  - special offer
  - educational tip
  - job completion
- text
- media
- tags
- related vehicle taxonomy
- visibility
- moderation status

### Q&A

Fields:

- question author
- related vehicle
- question text
- photos
- category
- answers
- provider participants
- accepted answer
- moderation status

For MVP, Q&A can be lightweight and public. It helps the social feel and provides more trust data.

---

## 5.11 Notifications

### Notification

Fields:

- recipient
- channel:
  - in-app
  - email
  - SMS optional
  - push
- event type
- payload
- read status
- preferences

Notification events:

- appointment requested
- appointment confirmed
- appointment reminder
- review received
- review response published
- inquiry received
- service reminder
- AI suggestion ready
- moderation update
- fleet approval needed

---

## 5.12 Plans and Entitlements

### Plan

Examples:

- Individual Free
- Fleet 20
- Fleet 50
- Fleet 100
- Provider Basic
- Provider Pro
- Vendor Basic
- Vendor Pro

### Entitlements

Examples:

- max vehicles
- fleet users
- AI tools enabled
- inventory item limits
- appointment capacity tools
- advanced analytics
- featured placement eligibility
- export access

For MVP, entitlements can be managed by admin and plan flags.

---

## 5.13 MCP / AI Service Entities

### MCP Client

Represents an internal service or approved external agent that can access MCP.

Fields:

- client ID
- name
- type
- scopes
- allowed resources
- allowed tools
- rate limits
- status

### MCP Access Log

Fields:

- client
- resource accessed
- tool invoked
- context scope
- user/org consent reference
- result status
- latency
- audit trail

### AI Insight

Any AI-generated object should be stored as an insight, not silently mixed with source data.

Fields:

- insight ID
- type
- subject entity
- input references
- output summary
- confidence
- model/version
- human approval status
- created date

Examples:

- skill heatmap
- suggested response
- suggested category
- maintenance reminder
- fraud flag
- profile gap suggestion

---

# 6. MVP Functional Modules

---

## Module A: Onboarding and Role Selection

### Purpose

Guide users into the correct role and organization type quickly.

### Flows

#### Individual onboarding

1. Sign up.
2. Choose “I own or manage personal vehicles.”
3. Add first vehicle.
4. Optional: describe current issue.
5. See recommended providers.

#### Fleet onboarding

1. Sign up.
2. Choose “I manage a fleet.”
3. Create organization.
4. Select fleet size tier.
5. Invite managers/drivers optional.
6. Add vehicles manually or CSV import.
7. Configure approval workflow.

#### Provider onboarding

1. Sign up.
2. Create business profile.
3. Choose service categories.
4. Add supported brands/models.
5. Upload portfolio/photos optional.
6. Set working hours and appointment capacity.
7. AI profile helper suggests missing capabilities.
8. Verification checklist.

#### Vendor onboarding

1. Sign up.
2. Create vendor profile.
3. Choose part categories.
4. Import inventory CSV or add items manually.
5. AI normalizes categories and fitment.
6. Set pricing visibility.
7. Publish searchable inventory.

### MVP requirements

- Role switcher for users with multiple roles.
- Organization switcher.
- Profile completeness checklist.
- Admin approval for certain verified badges.
- Trial access for premium features.

---

## Module B: Vehicle Profiles

### Purpose

Create a structured vehicle identity that powers matching, service history, and future OBDII features.

### Core features

- Add vehicle by VIN or manual entry.
- VIN decode optional.
- Manual override for all fields.
- Vehicle photo.
- Nickname.
- Current mileage.
- Ownership start date.
- Vehicle status:
  - active
  - sold
  - inactive
  - in repair
- Service history tab.
- Documents tab:
  - insurance
  - registration
  - warranty
  - invoices
- Issues tab:
  - active issues
  - resolved issues
- Maintenance reminders.
- Future OBDII placeholder section.

### Vehicle profile fields

- VIN
- brand
- model
- series
- year
- engine type
- fuel type
- transmission
- drivetrain
- body style
- color
- mileage
- notes

### AI features for vehicles

- Suggest missing fields.
- Suggest likely model/series from partial data.
- Suggest maintenance checks based on age/mileage.
- Suggest likely issue category from user description.
- Generate vehicle summary for pre-visit report.

### Limits

- Individual free: max 5 active vehicles.
- Corporate: max based on plan.
- Providers/vendors do not “own” customer vehicles but can be granted service context access.

---

## Module C: Provider Profiles and Capability Portfolio

### Purpose

Make provider expertise explicit, structured, and evidence-backed.

### Core profile sections

1. Overview
2. Services
3. Supported vehicles
4. Portfolio
5. Reviews
6. Availability
7. Location
8. Verification
9. Contact/appointment

### Capability builder

Providers can declare capabilities using a matrix:

- Brand
- Model
- Series
- Service system
- Service task
- Experience level
- Evidence attached

Example:

> BMW / 3 Series / E90 / Suspension / Control arm replacement / Advanced / 14 jobs / 12 reviews / 8 photos

### Profile completeness score

Based on:

- business info complete
- location verified
- hours set
- categories selected
- portfolio items uploaded
- reviews received
- response rate
- appointment availability enabled
- certifications uploaded

### AI Profile Helper

This is one of the most important MVP AI features.

It should:

- analyze provider job logs
- analyze portfolio tags
- analyze review text
- analyze repeated service categories
- suggest capabilities the provider likely performs but has not listed
- suggest missing brands/models/series
- suggest services to highlight
- suggest profile gaps
- suggest badges when evidence threshold is reached
- warn when claims are weak or inconsistent

Important principle:

> AI suggests, provider approves, platform verifies.

The public profile should not show AI-invented capabilities. It should show AI-suggested capabilities only after provider confirmation and sufficient evidence.

### Skill Heatmap

Private provider dashboard feature.

Displays strength by:

- brand
- model
- service system
- service task
- geographic demand
- rating trend
- repeat customers

Example output:

- Strong: BMW bodywork
- Strong: Mercedes suspension
- Emerging: VW brakes
- Weak: EV diagnostics
- Opportunity: local demand for Audi suspension is high, but your profile lacks evidence

### Public badges

Badges can include:

- Verified Business
- High Response Rate
- Repeat Customer Favorite
- BMW Bodywork Specialist
- Suspension Expert
- Fast Appointment Turnaround
- Excellent Communication
- Fleet Friendly
- EV Ready

Badges must be rule-based and auditable.

---

## Module D: Vendor Inventory and Search

### Purpose

Enable vendors to create a secure, searchable inventory database and allow users/providers to find parts that fit their vehicle context.

### Inventory MVP capabilities

- Manual item creation
- CSV import
- Bulk edit
- Inventory search
- Category filtering
- Fitment filtering
- Stock status
- Price visibility
- Image upload
- Duplicate detection
- AI categorization
- AI fitment suggestion
- Vendor inventory analytics

### Inventory search experiences

#### For normal user

Search by:

- vehicle
- part name
- category
- symptom
- brand
- price range

Example:

> “Brake pads for 2018 Volkswagen Golf”

#### For provider

Search by:

- customer vehicle context
- part number
- category
- vendor location
- availability now
- trade price

Example:

> “Water pump for 2015 Audi A4 within 10 miles, available today.”

#### For fleet manager

Search by:

- fleet vehicle
- part category
- preferred vendor
- cost
- warranty

### Security

Inventory data is multi-tenant and secure.

Rules:

- Vendors only see their own inventory.
- Public users see only public price/stock.
- Trade users see trade price if authorized.
- Competitors cannot scrape or access private catalog data.
- AI inventory enrichment must not leak one vendor’s private data to another vendor.

### Vendor AI features

- Normalize messy item names.
- Map items to categories.
- Suggest fitment.
- Detect duplicates.
- Detect missing images.
- Detect missing warranty info.
- Suggest popular part categories to add.
- Suggest inventory gaps based on local provider demand.

---

## Module E: Discovery, Search, and Matching

This is the heart of the MVP.

### Search targets

The platform should support searching for:

- service providers
- vendors
- parts
- vehicle-specific expertise
- symptoms/issues
- service categories
- locations
- posts/showcases
- Q&A

### Search inputs

- free text
- vehicle context
- location
- category
- urgency
- availability
- rating
- badges
- price indicator
- provider type
- vendor type

### Search filters

#### Provider filters

- distance
- rating
- verified status
- service category
- brand
- model
- series
- service system
- availability
- appointment type:
  - in-shop
  - mobile mechanic
  - pickup/drop-off
- price tier
- fleet friendly
- EV capable
- warranty offered
- response time
- languages

#### Vendor filters

- distance
- part category
- brand
- condition
- stock availability
- delivery/pickup
- trade pricing
- vendor rating
- fitment confidence

### Search results

Results should show:

- name
- distance
- rating
- relevant badge
- match explanation
- availability
- thumbnail portfolio
- price indicator
- verified status
- response time

### Matching logic

The matching engine should combine:

1. **Explicit fit**
   - Does the provider list the brand/model/service?

2. **Evidence fit**
   - Do job logs, photos, and reviews prove this work?

3. **Rating quality**
   - Are the ratings strong for this specific category?

4. **Recency**
   - Is the evidence recent?

5. **Availability**
   - Can the provider take the appointment?

6. **Location**
   - Is the provider near the user or willing to serve the area?

7. **Trust signals**
   - Verified profile, response rate, dispute history.

8. **User preference**
   - Preferred provider, favorites, fleet approved list.

### Match explanation

Every recommendation should explain why.

Example:

> “Bob’s Auto Suspension is recommended because he has 27 verified suspension jobs on BMW 3 Series E90, 4.8 average rating in suspension repairs, and availability tomorrow morning.”

This explanation is critical for trust.

### AI matching features

- Symptom-to-category inference
- Vehicle-to-provider matching
- Provider ranking
- Explanation generation
- Alternative suggestions
- Urgency detection
- Missing information prompts

Example:

> “You described a clunking noise when turning. This may relate to suspension or steering. Please confirm whether the noise happens while moving or while stationary.”

---

## Module F: Reviews and Reputation

### Purpose

Create a TripAdvisor-like reputation layer, but more structured and trustworthy.

### Review eligibility

To protect trust, MVP should support:

#### Verified reviews

Generated from:

- completed appointment
- confirmed service record
- provider-confirmed job
- invoice verification
- fleet service confirmation

#### Unverified reviews

Allowed only with clear label, and weighted lower.

Example label:

> “Experience reported but not verified through a completed appointment.”

For MVP, you may choose to allow only verified reviews for core scoring, with unverified reviews shown separately.

### Review structure

For service providers:

- overall stars
- work quality
- communication
- timeliness
- price accuracy
- cleanliness
- would return

For vendors:

- overall stars
- part accuracy
- availability accuracy
- price fairness
- service speed
- communication

### Review context

Each review should link to:

- vehicle type optional
- service category
- service task
- date
- provider location
- appointment ID optional
- photos optional

### Review tags

Examples:

- “explained clearly”
- “fixed first time”
- “on time”
- “fair price”
- “delayed”
- “part unavailable”
- “excellent finish”
- “needed follow-up”

### Provider response

Providers can:

- respond publicly
- respond with AI draft
- edit draft before publishing
- flag abusive/fake reviews
- request mediation

### AI review features

#### Sentiment analysis

Detect:

- positive
- neutral
- negative
- safety-related
- pricing complaint
- timeliness complaint
- quality complaint
- communication complaint

#### Theme extraction

Examples:

- “customer praised paint finish”
- “multiple reviews mention long wait time”
- “customers appreciate detailed explanation”

#### Review response drafting

AI drafts a professional response based on:

- review sentiment
- issue category
- provider tone
- historical approved responses
- platform policy

AI must not:

- admit legal liability automatically
- invent facts
- disclose private customer data
- publish without provider approval

#### Review improvement suggestions

For provider analytics:

- “Improve communication before delays.”
- “Clarify estimates before starting work.”
- “Customers love before/after photos; add more.”
- “Three recent reviews mention wait time; consider adjusting appointment buffers.”

### Review moderation

Admin tools for:

- reported reviews
- suspicious patterns
- duplicate reviews
- fake review flags
- inappropriate content
- disputes
- removal with audit reason

---

## Module G: Appointment Management

### Purpose

Reduce customer wait time and make the provider’s workflow manageable.

### MVP appointment model

The MVP does not need full workshop management, but it should support a reliable request-to-completion flow.

### User/fleet flow

1. Choose vehicle.
2. Describe problem or select service.
3. AI suggests likely service category.
4. Choose provider.
5. Choose time window.
6. Add photos/notes.
7. Submit request.
8. Provider confirms/proposes alternative.
9. User receives confirmation.
10. Reminder sent.
11. Provider updates status.
12. Job completed.
13. Review request sent.
14. Service record saved.

### Provider calendar

Provider can define:

- working hours
- service slots
- buffer time
- maximum concurrent appointments
- unavailable dates
- appointment types:
  - diagnosis
  - repair
  - inspection
  - bodywork estimate
  - parts installation

### Appointment states

- requested
- pending confirmation
- alternative proposed
- confirmed
- checked in
- in progress
- awaiting parts
- completed
- cancelled
- no-show

### Wait time minimization features

- slot availability
- appointment buffers
- customer reminders
- status updates
- delayed arrival notification
- parts availability note
- pre-visit report
- customer check-in link
- estimated completion window

### Provider AI appointment features

- suggest optimal slot
- detect schedule conflicts
- suggest longer slot for complex jobs
- suggest rescheduling if parts unavailable
- summarize customer need
- identify urgent issues

### Fleet appointment additions

- driver requests issue
- manager approval
- preferred provider routing
- cost approval
- service record sync to fleet dashboard

---

## Module H: Pre-Visit Report

This is a key differentiator and should be included in MVP even before OBDII.

### Purpose

Give the mechanic context before the vehicle arrives.

### Report contents

- vehicle identity
- mileage
- reported symptoms
- user description
- AI triage summary
- likely service categories
- relevant service history
- previous related repairs
- uploaded photos
- customer expectations
- urgency level
- fleet approval status
- preferred communication method

### AI pre-visit summary example

> “Customer reports a clunking noise from the front right when going over bumps. The vehicle is a 2014 BMW 328i with 98,000 miles. Previous service history includes front brake replacement 8 months ago. Likely inspection areas: front suspension bushings, sway bar links, strut mounts, control arms. Customer has uploaded a short video of the noise.”

Phase 2 can add OBDII codes and live sensor data to this report.

---

## Module I: Service History

### Purpose

Give users a durable vehicle record and give providers context.

### Sources of service records

1. User manual entry
2. Provider logged job
3. Completed appointment
4. Uploaded invoice
5. Imported file future
6. OBDII event future

### Service record fields

- date
- vehicle
- provider optional
- service category
- task
- description
- parts used
- cost
- warranty
- evidence
- verified status
- next service suggestion

### AI service history features

- summarize long repair notes
- detect recurring issues
- suggest next maintenance
- detect duplicate entries
- extract service category from free text
- suggest whether issue is resolved or ongoing

### User benefits

- better resale documentation
- easier diagnosis
- maintenance reminders
- provider continuity
- fleet compliance

---

## Module J: Lightweight Social Network Features

The platform should feel social, not just transactional.

### MVP social components

#### 1. Follow

Users can follow:

- providers
- vendors
- fleet brands maybe not needed
- car clubs future

#### 2. Provider updates/posts

Providers can publish:

- before/after job showcases
- seasonal maintenance tips
- availability announcements
- educational posts
- community events

#### 3. Before/after showcase

A central social object.

Features:

- before/after slider
- service tags
- vehicle tags
- provider caption
- AI-generated caption optional
- customer consent flag
- public comments optional
- helpful/like reaction

#### 4. Q&A

Users can ask questions tied to:

- vehicle
- symptom
- category

Providers can answer.

Answers build trust and can lead to appointments.

#### 5. Helpful reactions

Users can mark:

- helpful review
- helpful answer
- helpful post

### What MVP should avoid

To keep scope controlled, avoid a full Facebook-style feed in MVP. Instead, use a focused “Discover” feed showing:

- nearby providers
- relevant showcases
- Q&A activity
- maintenance tips
- followed providers

---

## Module K: Fleet Portal MVP

The fleet portal should be practical, not overbuilt.

### Fleet dashboard

Shows:

- total vehicles
- vehicles due for service
- active repair requests
- open issues
- monthly spend
- most repaired vehicles
- driver-reported issues

### Fleet vehicle page

Shows:

- vehicle details
- assigned driver
- mileage
- status
- service history
- active appointments
- cost history
- documents
- notes

### Fleet workflow

1. Driver reports issue.
2. AI triage suggests urgency/category.
3. Manager receives alert.
4. Manager approves or rejects.
5. Manager selects provider.
6. Appointment is requested.
7. Provider confirms.
8. Repair completed.
9. Cost logged.
10. Vehicle returns to active status.

### Fleet permissions

- Owner: full control
- Manager: manage vehicles/appointments/reports
- Driver: report issues and view assigned vehicle
- Viewer: read-only reports

### Fleet analytics MVP

- cost by vehicle
- cost by category
- service frequency
- downtime estimates
- provider usage
- preferred provider performance

### Fleet plan enforcement

- vehicle count limit
- user seat limit optional
- export access
- approval workflow enabled
- AI fleet suggestions enabled

---

## Module L: Notifications

### Notification channels

MVP should support:

- in-app notifications
- email notifications
- push notifications if mobile app
- SMS optional later

### Notification categories

#### User notifications

- appointment status
- review invitation
- service reminder
- AI triage ready
- provider responded
- vendor inquiry answered
- favorite provider update

#### Provider notifications

- new appointment request
- review received
- review response draft ready
- AI skill insight ready
- customer message
- moderation alert
- profile suggestion

#### Vendor notifications

- new inquiry
- inventory import finished
- AI fitment suggestion
- low data quality alert
- review received

#### Fleet notifications

- driver issue reported
- approval required
- appointment confirmed
- repair completed
- vehicle due for service
- monthly report ready

### Notification preferences

Users can control:

- frequency
- channels
- AI suggestions
- marketing
- critical alerts only

---

## Module M: Admin and Moderation Console

This is essential for trust and safety.

### Admin domains

#### User management

- view users
- suspend/reactivate
- role changes
- reset onboarding
- handle impersonation reports

#### Organization management

- verify businesses
- approve provider/vendor profiles
- manage locations
- manage plan/tier
- resolve duplicate organizations

#### Taxonomy management

- add/edit brands/models/series
- manage service categories
- manage part categories
- manage symptom categories
- merge duplicate taxonomy items

#### Review moderation

- review reports
- remove reviews
- restore reviews
- manage disputes
- audit moderation actions

#### Content moderation

- posts
- photos
- Q&A
- inappropriate media
- consent issues
- redaction issues

#### AI oversight

- view AI suggestions
- approve/reject AI-generated profile suggestions
- monitor AI flags
- review hallucination reports
- manage AI feature flags
- audit MCP tool calls

#### Inventory moderation

- flagged listings
- counterfeit concerns
- inaccurate fitment reports
- vendor compliance

#### Analytics

- growth metrics
- trust metrics
- matching quality
- review quality
- AI usage
- moderation load

#### Feature flags

- enable/disable AI features by role/region/org
- beta features
- emergency kill switch for AI automation

---

# 7. MVP AI Feature Specification

The AI layer should be comprehensive but controlled. AI should not directly change public data without approval unless the action is low-risk and clearly safe.

---

## 7.1 AI Principles

1. **Human-in-the-loop for public content**
   - AI drafts, human approves.

2. **Explainability**
   - Every major recommendation should have a reason.

3. **Evidence first**
   - AI should not create expertise claims without supporting evidence.

4. **Privacy minimization**
   - AI receives only necessary context.

5. **Auditability**
   - All AI actions are logged.

6. **Safety awareness**
   - Safety-critical symptoms trigger warnings.

7. **No hidden ranking manipulation**
   - Paid placement must be clearly separated from trust-based matching.

---

## 7.2 User AI Features

### A. AI “Help Me” Problem Triage

#### Trigger

User says:

- “My car makes a noise.”
- “Check engine light is on.”
- “Brakes feel soft.”
- “AC not cold.”

#### Inputs

- vehicle profile
- symptom description
- photos optional
- mileage
- service history
- active issues

#### AI actions

- ask clarifying questions
- classify symptom
- infer likely systems
- estimate urgency
- suggest safe next steps
- recommend service category
- suggest matching providers
- prepare appointment request draft

#### Safety handling

If symptom relates to brakes, steering, airbags, fire smell, overheating, no-start in unsafe context, etc.:

- show safety warning
- recommend urgent inspection
- suggest not driving if severe
- show urgent providers/towing options if available

#### Output example

> “Based on your description and vehicle history, this may be related to the braking system. Because soft brake pedal can affect safety, we recommend urgent inspection. We can show nearby brake specialists with high verified ratings.”

---

### B. AI Maintenance Suggestions

#### Inputs

- vehicle age
- mileage
- service history
- season
- previous repairs
- manufacturer-style maintenance categories

#### AI actions

- suggest periodic checks
- suggest likely upcoming services
- avoid making absolute claims
- prioritize safety and reliability

#### Examples

- “Your vehicle mileage suggests checking brake fluid.”
- “Since you had battery issues before, consider a charging system inspection before winter.”
- “Tire rotation may be due based on last service date.”

---

### C. AI Provider Matching

#### Inputs

- vehicle profile
- issue category
- location
- urgency
- provider capabilities
- evidence
- ratings
- availability
- user preferences

#### Output

- ranked list
- match score
- explanation
- alternatives
- confidence level

---

### D. AI Vehicle Profile Helper

#### Inputs

- VIN partial/full
- user-entered data
- photos optional
- manual corrections

#### AI actions

- suggest missing fields
- detect inconsistent model/year
- normalize engine/fuel type
- suggest common model variant

---

## 7.3 Provider AI Features

### A. AI Skill Heatmap

#### Purpose

Show providers where they are strong, weak, and where market opportunity exists.

#### Inputs

- completed jobs
- portfolio items
- reviews
- ratings
- categories
- repeat customers
- response time
- dispute history
- local demand data

#### Outputs

- capability score
- confidence level
- trend
- evidence summary
- suggested next actions

#### Example

> “Your suspension work on Mercedes C-Class has a 4.9 rating across 18 jobs. Consider adding this as a featured specialty.”

---

### B. AI Profile Helper

#### Purpose

Complete and improve the provider’s portfolio of skills.

#### Inputs

- current profile
- job logs
- reviews
- media tags
- certifications
- appointment history

#### AI actions

- suggest missing brands/models
- suggest missing service categories
- suggest capability evidence
- suggest removing weak claims
- suggest profile text improvements
- suggest badge eligibility

#### Approval

Provider must approve suggestions before they become public.

---

### C. AI Review Response Assistant

#### Purpose

Help providers respond professionally, especially to negative reviews.

#### Inputs

- review text
- rating
- sentiment
- category
- provider tone preferences
- past approved responses

#### AI actions

- classify issue
- suggest response strategy
- draft response
- flag legal/safety sensitivity
- recommend private follow-up if needed

#### Rules

- No automatic publishing.
- No admission of liability without provider approval.
- No private customer details in public response.
- No aggressive tone.

#### Example strategy

For a bad review about waiting:

- acknowledge frustration
- explain context if appropriate
- apologize for experience
- state process improvement
- invite private resolution

---

### D. AI Analytics for Star Improvement

#### Purpose

Tell providers what to improve to raise ratings.

#### Inputs

- review themes
- rating trends
- appointment completion rates
- response times
- cancellation rates
- portfolio quality
- profile completeness

#### Outputs

- priority improvements
- expected impact
- suggested actions
- benchmark against similar providers

#### Examples

- “Customers mention delayed start times. Consider adding buffer time.”
- “Reviews praise quality but mention unclear pricing. Add estimate confirmation step.”
- “Your response rate to negative reviews is low. Responding professionally may improve trust.”

---

### E. AI Showroom Agent / Before-After Composer

#### Purpose

Turn job photos into professional showcase posts.

#### Inputs

- before/after photos
- job category
- vehicle model
- provider notes
- customer consent

#### AI actions

- group photos by job
- detect before/after pairs
- suggest redaction of plates/faces
- generate captions
- suggest tags
- suggest service category
- draft public showcase post

#### Human approval

Provider approves before publishing.

#### Example caption

> “Front bumper repair and repaint on a BMW 3 Series. Panel alignment, primer, color match, and clear coat completed in two days.”

---

### F. AI Appointment Suggestions

#### Inputs

- service category
- estimated duration
- existing calendar
- parts availability
- job complexity

#### AI actions

- suggest best slot
- warn about conflicts
- suggest longer duration for complex jobs
- suggest follow-up appointment if needed

---

## 7.4 Vendor AI Features

### A. AI Inventory Normalization

#### Inputs

- raw item names
- part numbers
- categories
- images
- fitment notes

#### AI actions

- clean item names
- assign categories
- identify condition
- suggest part type
- detect duplicates
- suggest missing fields

#### Example

Raw:

> “Brake pad set front VW Golf 7 MK7 2015-2018”

Normalized:

- Category: Brake Pads
- Position: Front
- Brand: Volkswagen
- Model: Golf
- Series: MK7
- Years: 2015–2018

---

### B. AI Fitment Suggestion

#### Inputs

- part description
- part numbers
- historical fitment patterns
- vendor catalog

#### AI actions

- suggest compatible vehicles
- flag uncertain fitment
- ask vendor to confirm

---

### C. AI Inventory Gap Suggestions

#### Inputs

- local provider demand
- search queries
- missing inventory categories
- popular part requests

#### AI actions

- suggest parts to stock
- suggest categories to add
- identify demand without supply

---

## 7.5 Platform AI Features

### A. Fraud and Fake Review Detection

Signals:

- sudden review bursts
- repeated phrases
- same device/location patterns
- suspicious reviewer behavior
- review timing anomalies
- provider self-review patterns

Action:

- flag for moderation
- lower trust weight
- require verification

### B. Duplicate Entity Detection

Detect duplicates:

- same shop listed twice
- same vendor multiple locations
- same vehicle added twice
- same inventory item duplicated

### C. Search Relevance Improvement

AI helps with:

- synonyms
- misspellings
- category mapping
- local terms
- service aliases

### D. Moderation Assistance

AI flags:

- offensive content
- personal information
- unsafe advice
- misleading claims
- non-consensual media

Human moderators make final decisions.

---

# 8. MCP Service Specification for MVP

The MVP should seed a comprehensive MCP service as the central AI context and capability layer.

## What the MCP service does

It provides a secure, governed way for AI features and future external agents to access:

- platform context
- user consent
- vehicle context
- provider capabilities
- reviews
- inventory
- appointments
- taxonomy
- analytics
- tools/actions

It becomes the “AI integration spine” of the platform.

---

## 8.1 Why MCP is essential

Without MCP, AI features become fragmented:

- each feature fetches data separately
- privacy rules become inconsistent
- prompts become unmanaged
- auditability is weak
- future integrations become difficult

With MCP:

- AI features share a governed context layer
- tools are reusable
- permissions are centralized
- logs are consistent
- future OBDII, telematics, insurance, and partner agents can plug in

---

## 8.2 MCP Core Components

### 1. MCP Registry

Registers approved AI clients and agents.

Fields:

- client identity
- allowed scopes
- allowed resources
- allowed tools
- rate limits
- environment
- status

### 2. Resource Catalog

Defines what context can be read.

Examples:

- vehicle summary
- provider profile
- provider capability summary
- review summary
- appointment summary
- inventory item summary
- fleet summary
- taxonomy definitions
- local demand summary

### 3. Tool Catalog

Defines what actions AI can perform.

Examples:

- search providers
- match provider
- draft review response
- generate pre-visit summary
- suggest maintenance
- normalize inventory item
- suggest capability
- create appointment draft
- flag review
- generate showcase caption

### 4. Prompt Registry

Stores prompt templates and versions.

Examples:

- triage prompt
- review response prompt
- skill heatmap explanation prompt
- inventory normalization prompt
- pre-visit summary prompt
- showroom caption prompt

### 5. Context Builder

Assembles only the necessary context for a given task.

Example for provider matching:

- vehicle profile
- issue category
- location
- provider capability summary
- rating summary
- availability summary
- user preferences

It should not include unnecessary private data.

### 6. Policy Engine

Controls:

- what data can be accessed
- which AI can access it
- whether user consent exists
- whether provider consent exists
- whether action requires human approval
- rate limits
- geographic restrictions
- sensitive data redaction

### 7. Audit Log

Records:

- who invoked what
- what context was used
- what tool ran
- what output was produced
- whether human approved
- timestamp
- model/version

### 8. Evaluation Layer

Tracks AI quality:

- user acceptance
- provider approval
- correction rate
- moderator override rate
- match acceptance rate
- hallucination reports

---

## 8.3 MVP MCP Resources

### User-side resources

- current user profile summary
- user vehicle list
- selected vehicle summary
- service history summary
- active issue summary
- user preferences

### Provider-side resources

- provider profile summary
- provider capabilities
- provider portfolio summary
- review summary
- appointment calendar summary
- analytics summary
- improvement suggestions

### Vendor-side resources

- vendor profile summary
- inventory summary
- fitment summary
- inquiry summary
- catalog quality summary

### Fleet-side resources

- fleet vehicle list
- vehicle service summary
- driver issue summary
- approval workflow status
- cost summary

### Platform resources

- taxonomy
- location/geography
- search index summaries
- trust signal summaries
- moderation status

---

## 8.4 MVP MCP Tools

### Discovery tools

- search_providers
- search_vendors
- search_parts
- search_showcases
- search_qa
- get_provider_match_explanation

### Matching tools

- match_provider_to_vehicle_issue
- rank_providers
- suggest_alternative_providers
- detect_urgency

### Vehicle tools

- summarize_vehicle_profile
- suggest_maintenance_checks
- extract_vehicle_fields
- summarize_service_history

### Provider tools

- suggest_provider_capabilities
- generate_skill_heatmap_summary
- draft_review_response
- analyze_review_themes
- generate_showcase_caption
- suggest_profile_improvements
- suggest_appointment_slot

### Vendor tools

- normalize_inventory_item
- suggest_fitment
- detect_duplicate_inventory
- summarize_inventory_gaps

### Workflow tools

- create_appointment_request_draft
- create_pre_visit_report
- create_service_record_draft
- create_review_request
- flag_review
- flag_content

### Governance tools

- check_consent
- redact_sensitive_data
- log_ai_action
- request_human_approval

---

## 8.5 MCP Permission Model

### Scopes examples

- read:public_profiles
- read:provider_capabilities
- read:vehicle_summary
- read:review_summary
- read:inventory_public
- read:inventory_trade
- write:appointment_draft
- write:review_response_draft
- write:showcase_draft
- admin:moderation_flags

### Consent rules

- User vehicle data requires user consent.
- Fleet data requires organization consent.
- Provider analytics require provider consent.
- Vendor private inventory requires vendor consent.
- AI cannot use one vendor’s private inventory to benefit another vendor.
- Personal contact details should be redacted unless necessary.
- AI outputs should not reveal private user identity publicly.

---

## 8.6 MCP Design Principles

1. **Read actions are broad but governed**
2. **Write actions create drafts, not final public changes**
3. **Sensitive actions require approval**
4. **Every AI action is traceable**
5. **Context is minimized**
6. **Tools are versioned**
7. **External agents can be added later without redesign**

---

# 9. High-Level System Architecture

The MVP should be architected as a **modular monolith with event-driven AI/MCP services**. This avoids premature microservice complexity while preserving clean domain boundaries.

---

## 9.1 Client Layer

### Consumer App

Mobile-first app or responsive web app for individual users.

Main sections:

- Home/Discover
- My Garage
- Help Me
- Appointments
- Reviews/Community
- Notifications
- Profile

### Provider Portal

Web and mobile-friendly.

Main sections:

- Dashboard
- Appointment Requests
- Calendar
- Profile
- Portfolio
- Reviews
- AI Insights
- Messages/Inquiries
- Settings

### Vendor Portal

Web-first.

Main sections:

- Dashboard
- Inventory
- Inquiries
- Profile
- Reviews
- AI Catalog Assistant
- Analytics
- Settings

### Fleet Portal

Web-first.

Main sections:

- Dashboard
- Vehicles
- Drivers
- Maintenance
- Appointments
- Reports
- Settings

### Admin Console

Web-only, internal.

Main sections:

- Users/Orgs
- Taxonomy
- Reviews/Moderation
- AI Oversight
- MCP Clients/Audit
- Analytics
- Plans/Entitlements
- Feature Flags

---

## 9.2 API / Experience Layer

### API Gateway

Handles:

- authentication
- rate limiting
- routing
- request validation
- API versioning
- audit logging

### Backend-for-Frontend layers

Optional but recommended:

- Consumer BFF
- Provider BFF
- Vendor BFF
- Fleet BFF
- Admin BFF

These tailor data for each portal.

---

## 9.3 Core Domain Services / Modules

These can begin as modules inside a modular monolith.

### Identity and Access Module

Handles:

- signup/login
- roles
- permissions
- sessions
- multi-factor optional
- consent
- organization membership

### Organization Profile Module

Handles:

- provider profiles
- vendor profiles
- fleet organizations
- locations
- verification
- business hours
- plan entitlements

### Vehicle Module

Handles:

- vehicle records
- VIN data
- service records
- documents
- maintenance reminders
- future OBDII placeholder

### Taxonomy Module

Handles:

- brands/models/series
- service categories
- part categories
- symptoms
- mappings
- synonyms

### Discovery/Search Module

Handles:

- search indexes
- provider search
- vendor search
- parts search
- geo search
- ranking
- match explanations

### Trust & Reviews Module

Handles:

- reviews
- ratings
- verification
- disputes
- moderation workflow
- trust signals

### Appointment Module

Handles:

- appointment requests
- calendar
- statuses
- reminders
- pre-visit reports
- fleet approvals

### Inventory Module

Handles:

- vendor inventory
- fitment
- stock inquiries
- CSV import
- catalog quality

### Media Module

Handles:

- photo/video upload
- thumbnails
- moderation
- redaction
- consent
- before/after grouping

### Notification Module

Handles:

- in-app
- email
- push
- SMS optional
- preferences
- delivery tracking

### Analytics Module

Handles:

- event collection
- KPI dashboards
- AI usage metrics
- funnel metrics
- trust metrics

### Admin/Moderation Module

Handles:

- moderation queues
- audit logs
- feature flags
- taxonomy administration
- user/org administration

### Billing/Plan Module

For MVP:

- plan definitions
- entitlement enforcement
- manual plan assignment
- trial flags
- future payment integration placeholder

---

## 9.4 AI/MCP Platform

This is a separate architectural layer but tightly governed.

### Components

#### MCP Gateway

Entry point for AI tools/resources.

#### LLM Orchestration Layer

Manages:

- prompt selection
- model routing
- retries
- fallback
- streaming/async responses
- cost controls

#### Context Service

Builds context from domain modules.

#### Policy Engine

Checks consent, scopes, and permissions.

#### Tool Executor

Runs approved tools.

#### Insight Store

Stores AI outputs.

#### Evaluation Store

Stores feedback, corrections, approvals.

#### Vector/Semantic Index

Used for:

- semantic search
- similar providers
- similar issues
- review theme clustering
- inventory normalization
- Q&A matching

---

## 9.5 Data Layer

### Primary operational database

Stores structured domain data:

- users
- orgs
- vehicles
- profiles
- reviews
- appointments
- inventory
- plans
- audit logs

### Search index

Stores searchable projections:

- providers
- vendors
- inventory
- posts
- Q&A
- showcases

### Object storage

Stores:

- images
- documents
- thumbnails
- export files

### Cache

Stores:

- session data
- frequent search results
- profile summaries
- availability slots
- feature flags

### Event log / message bus

Stores domain events for asynchronous processing.

### Analytics warehouse/lake

Stores aggregated events for reporting.

### Vector store

Stores embeddings for semantic AI features.

---

## 9.6 Event-Driven Architecture

The platform should use events to keep AI and analytics updated without blocking user flows.

### Key domain events

- user.registered
- vehicle.created
- vehicle.updated
- provider.profile.published
- vendor.inventory.imported
- inventory.updated
- appointment.requested
- appointment.confirmed
- appointment.completed
- review.created
- review.published
- review.reported
- portfolio.published
- service_record.created
- qna.question.created
- inquiry.sent
- ai.insight.generated
- moderation.action.taken

### Event consumers

- search indexer
- AI insight generator
- notification service
- analytics pipeline
- trust scoring pipeline
- skill heatmap pipeline
- fraud detection pipeline
- MCP audit logger

---

# 10. Key MVP User Flows

---

## Flow 1: Individual user finds the right specialist

1. User opens app.
2. Selects vehicle.
3. Uses “Help Me.”
4. Describes issue.
5. AI asks clarifying questions.
6. AI suggests likely service category.
7. AI recommends providers with explanations.
8. User compares profiles.
9. User views before/after work and reviews.
10. User requests appointment.
11. Provider confirms.
12. User receives pre-visit summary and reminders.
13. Repair completed.
14. User leaves verified review.
15. Provider skill heatmap updates.

---

## Flow 2: Provider improves trust and rankings

1. Provider completes profile.
2. AI profile helper suggests missing capabilities.
3. Provider uploads before/after photos.
4. AI showroom agent drafts showcase post.
5. Provider approves.
6. Customer leaves verified review.
7. AI analyzes review themes.
8. AI suggests improvements.
9. Provider responds to negative review with AI draft.
10. Skill heatmap updates.
11. Provider becomes eligible for a badge.
12. Provider appears more often for matched searches.

---

## Flow 3: Vendor inventory becomes searchable

1. Vendor signs up.
2. Uploads CSV inventory.
3. AI normalizes names/categories.
4. AI suggests fitment.
5. Vendor confirms fitment.
6. Inventory is indexed.
7. Provider searches part for customer vehicle.
8. Vendor receives inquiry.
9. Vendor confirms availability.
10. Provider schedules repair with parts confidence.

---

## Flow 4: Fleet manager handles a breakdown

1. Driver reports issue from fleet portal/mobile.
2. AI triage flags likely brakes issue as urgent.
3. Fleet manager receives notification.
4. Manager approves service request.
5. System recommends brake specialist near vehicle location.
6. Manager selects preferred provider.
7. Appointment request sent.
8. Provider confirms.
9. Vehicle serviced.
10. Cost logged.
11. Fleet dashboard updates vehicle status.

---

# 11. MVP Information Architecture

## Consumer App Structure

### Home / Discover

- search bar
- AI Help Me button
- nearby trusted providers
- recommended for your vehicles
- recent activity
- seasonal maintenance tips

### My Garage

- vehicle cards
- add vehicle
- vehicle detail
- service history
- documents
- active issues
- reminders

### Help Me

- guided problem description
- photo upload
- AI triage conversation
- urgency indicator
- provider recommendations
- appointment draft

### Appointments

- upcoming
- past
- requested
- cancelled
- pre-visit report
- review action

### Community

- followed providers
- showcases
- Q&A
- helpful posts

### Profile

- account settings
- privacy
- notification preferences
- AI preferences
- favorite providers
- plan/vehicle limit

---

## Provider Portal Structure

### Dashboard

- today’s appointments
- new requests
- review alerts
- AI suggestions
- profile completeness
- response time

### Requests

- appointment requests
- pre-visit reports
- accept/propose/decline

### Calendar

- daily/weekly view
- capacity
- buffers
- unavailable times

### Profile

- overview
- services
- supported vehicles
- certifications
- locations
- hours
- verification

### Portfolio

- before/after items
- AI composer
- media library
- consent management

### Reviews

- review inbox
- AI draft responses
- published responses
- themes/analytics
- reports

### Insights

- skill heatmap
- improvement suggestions
- rating drivers
- demand opportunities
- profile gaps

### Settings

- notification preferences
- AI assistant settings
- appointment rules
- team users
- plan/billing placeholder

---

## Vendor Portal Structure

### Dashboard

- inquiries
- inventory quality score
- recent reviews
- AI suggestions
- popular searches

### Inventory

- item list
- add item
- bulk import
- AI normalization queue
- fitment editor
- stock status

### Inquiries

- open
- answered
- reserved
- closed

### Profile

- vendor overview
- categories
- locations
- delivery/pickup
- trade policies

### Reviews

- vendor ratings
- response tools

### Insights

- search demand
- missing fitment
- inventory gaps
- catalog quality

---

## Fleet Portal Structure

### Dashboard

- fleet health
- alerts
- approvals
- active repairs
- cost snapshot

### Vehicles

- vehicle list
- filters
- vehicle detail
- documents
- service history

### Drivers

- driver list
- assignment
- driver-reported issues

### Maintenance

- due services
- open issues
- service reminders

### Appointments

- requests
- approved
- scheduled
- completed

### Reports

- cost reports
- repair frequency
- provider usage
- export

---

## Admin Console Structure

### Users & Orgs

### Taxonomy

### Reviews & Moderation

### AI Oversight

### MCP Clients & Audit

### Plans & Entitlements

### Analytics

### Feature Flags

---

# 12. Search and Matching Architecture

## Search sources

The search system should index:

- providers
- vendors
- inventory items
- showcases
- Q&A
- service categories
- symptoms

## Search capabilities

### Text search

- typo tolerance
- synonyms
- partial matching
- category mapping

### Geo search

- nearby providers
- service radius
- location clustering
- distance sorting

### Semantic search

Uses embeddings for:

- “car shakes when braking”
- “noise over bumps”
- “engine warning light”
- “BMW suspension specialist”

### Contextual search

If user selects a vehicle, search automatically filters by:

- brand
- model
- series
- engine
- year

## Ranking factors

### Provider ranking

- capability match
- evidence strength
- rating in relevant category
- review recency
- verified status
- response rate
- availability
- distance
- profile completeness
- dispute history

### Vendor ranking

- fitment confidence
- stock availability
- distance
- vendor rating
- price visibility
- response time
- category relevance

### Inventory ranking

- fitment confidence
- stock status
- price
- condition
- vendor rating
- distance
- data completeness

## Match explanation generation

The system should store structured reasons:

- capability evidence
- rating evidence
- location
- availability
- urgency fit
- user preference

Then AI can render a human-readable explanation.

---

# 13. Trust, Safety, and Moderation

## Trust requirements

### Business verification

Provider/vendor verification may include:

- business name
- address
- phone
- email
- business documents optional
- location confirmation
- admin review

### User verification

For reviews and fleet roles:

- email/phone verification
- role approval
- fleet organization approval

### Review authenticity

Signals:

- appointment link
- service record link
- invoice evidence
- reviewer history
- timing patterns
- device/location anomalies

### Content safety

Moderation needed for:

- hate speech
- harassment
- private information
- unsafe repair advice
- counterfeit parts
- fraudulent reviews
- misleading claims

### AI safety

AI should:

- not diagnose with absolute certainty
- not tell users to ignore safety symptoms
- not publish unverified claims
- not reveal private data
- not favor paid providers in organic trust ranking

---

# 14. Privacy and Data Governance

## Core privacy principles

1. Users own their vehicle and repair data.
2. Providers see customer data only when needed for service.
3. Vendors see vehicle context only for part fitment inquiries.
4. Fleet data is isolated per organization.
5. AI uses minimized context.
6. Consent is recorded.
7. Sensitive media can be redacted.
8. Data retention policies are configurable.

## Key consent areas

- vehicle data sharing with provider
- service history sharing
- photo publishing
- before/after showcase publishing
- AI personalization
- review invitation communications
- fleet manager visibility of driver data

## GDPR/CCPA-like readiness

MVP should support:

- data export
- data deletion
- consent withdrawal
- right to rectification
- audit trail
- data minimization

---

# 15. Non-Functional Requirements

## Performance

- Search results should respond quickly under normal load.
- AI drafts can be asynchronous if needed.
- Provider match explanations should be generated quickly enough for interactive use.
- Inventory import should support bulk processing without blocking UI.

## Availability

- MVP target: high availability for core flows.
- Background AI can degrade gracefully.
- If AI is unavailable, manual search/appointment still works.

## Scalability

Architecture must support:

- more vehicles per fleet
- more inventory items
- more media uploads
- more search traffic
- more AI usage
- future OBDII data streams

## Security

- encryption in transit
- encryption at rest
- role-based access
- audit logging
- secure file upload
- malware scanning for uploads if possible
- rate limiting
- secrets management
- MCP token scoping

## Accessibility

- readable contrast
- screen reader support
- accessible forms
- simple language
- large tap targets for mobile

## Localization readiness

Even if MVP launches in one language, structure for:

- multiple languages
- local currency
- local date/time formats
- regional vehicle taxonomies
- local phone/address formats

---

# 16. MVP Analytics and Success Metrics

## Activation metrics

- percentage of new users who add a vehicle
- percentage who perform first search
- percentage who view a provider profile
- percentage who request first appointment
- provider profile completion rate
- vendor inventory import completion rate

## Trust metrics

- verified review rate
- review response rate
- review report rate
- fake review flag rate
- profile verification rate
- badge accuracy rate

## Matching metrics

- match acceptance rate
- appointment request conversion from AI recommendation
- user rating of match usefulness
- provider response time to requests
- mismatch complaints

## Provider value metrics

- appointment requests received
- appointments completed
- new customers acquired
- rating improvement over time
- review response usage
- AI suggestion acceptance rate

## Vendor value metrics

- inventory items indexed
- inventory search volume
- inquiries received
- inquiry-to-response time
- fitment completion rate

## Fleet value metrics

- vehicles added
- service requests resolved
- average approval time
- cost tracking completeness
- repeat fleet usage

## AI quality metrics

- AI suggestion acceptance rate
- AI draft edit rate
- AI moderation override rate
- hallucination reports
- triage correction rate
- provider match explanation quality rating

---

# 17. MVP Release Plan

This is a suggested structure, not a coding plan.

---

## Stage 1: Foundation and Taxonomy

### Goals

- finalize roles
- finalize taxonomy
- define trust rules
- define AI guardrails
- define data model
- define MCP resource/tool catalog

### Deliverables

- product requirements
- user journey maps
- taxonomy catalog
- data schema
- permission matrix
- moderation policy
- AI policy
- design system direction

---

## Stage 2: Core Accounts and Profiles

### Goals

Users can exist and create their core entities.

### Deliverables

- signup/login
- role selection
- individual profiles
- fleet org creation
- provider profiles
- vendor profiles
- vehicle profiles
- organization locations
- plan limits
- basic admin management

---

## Stage 3: Discovery and Profiles

### Goals

Users can search and view useful profiles.

### Deliverables

- provider public pages
- vendor public pages
- search filters
- geo search
- capability display
- portfolio display
- inventory search
- basic analytics events

---

## Stage 4: Trust and Appointments

### Goals

The platform becomes transactional and reputation-driven.

### Deliverables

- appointment requests
- provider calendar
- pre-visit report
- review creation
- verified review logic
- provider responses
- service history logging
- notifications
- moderation queue

---

## Stage 5: AI/MCP Layer

### Goals

AI becomes the intelligence backbone.

### Deliverables

- MCP gateway
- resource/tool catalog
- AI triage
- AI matching
- AI review response
- AI skill heatmap
- AI profile helper
- AI showroom composer
- AI inventory normalization
- AI audit logging
- evaluation dashboard

---

## Stage 6: Fleet and Vendor Depth

### Goals

Make paid/fleet and vendor workflows strong enough for real use.

### Deliverables

- fleet dashboard
- driver reporting
- approvals
- fleet analytics
- vendor CSV import
- fitment editor
- inventory inquiries
- vendor analytics

---

## Stage 7: Beta Hardening

### Goals

Prepare for real users.

### Deliverables

- moderation playbooks
- AI quality evaluation
- search tuning
- trust scoring calibration
- performance testing
- security review
- privacy review
- admin tooling completion
- onboarding content
- support workflow

---

# 18. MVP Must-Have vs Should-Have vs Later

## Must-Have for MVP

- Four role types
- Vehicle profiles
- Provider capability profiles
- Vendor inventory search
- Reviews and ratings
- Search/discovery
- AI matching
- AI triage
- Appointment requests
- Basic provider calendar
- Pre-visit report
- Service history
- AI review response
- AI skill heatmap
- AI profile helper
- AI showroom composer
- MCP service foundation
- Admin/moderation
- Notifications
- Fleet basic portal
- Analytics/audit

## Should-Have if scope allows

- Q&A
- provider posts/feed
- CSV fleet vehicle import
- CSV vendor inventory import
- review invitations
- basic export
- simple subscription plan management
- AI inventory gap suggestions

## Later / Phase 2+

- OBDII Bluetooth integration
- ECU code reading
- live vehicle health reports
- advanced pre-visit OBDII report
- full payments
- parts checkout
- live chat
- crash detection/SOS
- insurance integrations
- DMS/POS integrations
- advanced predictive maintenance
- public API/partner MCP agents

---

# 19. Key Product Rules for MVP

These rules will keep the product coherent and trustworthy.

1. **No fake expertise**
   - Public capability badges require evidence.

2. **No hidden paid ranking**
   - Paid features cannot silently distort trust-based matching.

3. **AI drafts, humans approve**
   - AI-generated public content needs approval.

4. **Every recommendation explains itself**
   - Users should understand why a provider is recommended.

5. **Vehicle context drives everything**
   - Search, matching, parts, and service suggestions should use vehicle context.

6. **Service history is a long-term asset**
   - It should be portable, structured, and valuable to users.

7. **Providers should get business tools, not just listings**
   - The platform must help them improve, not only judge them.

8. **Vendors need secure inventory isolation**
   - Inventory data must be searchable but not leaky.

9. **Fleet workflows need approvals and cost visibility**
   - Fleets care about control, downtime, and reporting.

10. **MCP is the future spine**
   - All AI and future integrations should flow through governed MCP capabilities.

---

# 20. Risks and Mitigations

## Risk 1: Cold start problem

New platform may lack reviews and providers.

### Mitigation

- provider onboarding concierge
- AI profile import
- review invitation flow
- verified past-service import
- local launch focus on one city/category
- showcase-first profiles even before many reviews

---

## Risk 2: Fake reviews

### Mitigation

- verified appointment reviews
- invoice evidence
- AI fraud detection
- moderation
- review velocity limits
- trust weighting

---

## Risk 3: Providers claim false expertise

### Mitigation

- evidence-based badges
- AI skill heatmap with confidence thresholds
- admin verification
- user reports
- portfolio requirements

---

## Risk 4: AI gives unsafe automotive advice

### Mitigation

- safety-critical warnings
- no definitive diagnosis
- recommend professional inspection
- urgent issue escalation
- disclaimers
- human-approved content for public posts

---

## Risk 5: Vendor inventory data quality

### Mitigation

- AI normalization
- fitment confidence labels
- vendor data quality score
- duplicate detection
- admin catalog moderation

---

## Risk 6: Scope creep

### Mitigation

- strict MVP boundaries
- phase hooks instead of full features
- product rule: if it does not improve trust/matching/appointment conversion, defer it

---

# 21. Final MVP Definition

The MVP should be defined as:

> A trust-driven automotive service network where users build vehicle profiles, discover and review verified service providers and parts vendors, request appointments, and receive AI-assisted matching. Providers gain intelligent profile and reputation tools. Vendors gain searchable inventory. Fleet managers gain basic vehicle and repair oversight. All AI features operate through a secure MCP layer that stores context, governs tools, logs actions, and prepares the platform for OBDII, telematics, and partner integrations in later phases.

---

# 22. Recommended Next Steps

To continue maturing this, the next most useful workstreams are:

1. **Define the MVP user journeys in screen-by-screen detail**
   - individual user
   - provider
   - vendor
   - fleet manager

2. **Define the taxonomy**
   - service systems
   - service tasks
   - part categories
   - symptoms
   - review tags

3. **Define the trust and scoring rules**
   - verified review rules
   - badge thresholds
   - provider capability confidence levels
   - fraud signals

4. **Define the MCP tool/resource catalog**
   - exact resources
   - exact tools
   - consent rules
   - audit rules

5. **Define the AI guardrails**
   - what AI may suggest
   - what AI may draft
   - what AI may never do without approval
   - safety rules for automotive advice
