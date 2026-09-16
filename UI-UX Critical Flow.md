 **UI/UX and User Journey specification** 

# 1. Design Principles for Both Flows

| Principle | Meaning |
|---|---|
| Vehicle context first | Every screen should show which vehicle is being discussed. |
| Progressive disclosure | Ask only what is needed to move to the next step. |
| Safety before polish | Safety-critical symptoms must interrupt normal flow with clear warnings. |
| Explain AI decisions | Recommendations must show why a provider was chosen. |
| Human control | AI drafts and suggests; users approve and submit. |
| Fast paths | Returning users should be able to complete flows in minimal taps. |

---

# 2. Flow A: Triage Wizard

## 2.1 Purpose

Help a user describe a vehicle problem, understand urgency, and get matched with the most suitable service provider or parts vendor.

## 2.2 Primary users

- Individual car owner
- Fleet driver
- Fleet manager creating a request on behalf of a vehicle

## 2.3 Entry points

- Consumer app: **Help Me** tab
- Home/Discover: “Describe your problem” card
- Vehicle Detail: “Report an issue”
- Fleet Dashboard: “Report issue” or driver mobile view
- Search: “Not sure what to search? Use Help Me”

## 2.4 Success metrics

- Percentage of started triages completed
- Time from start to provider recommendation
- Appointment request conversion rate
- Safety-critical issue escalation rate
- User confidence in recommendation

---

# 3. Triage Wizard Screen Map

## 3.1 High-level flow

```text
Entry
  → Select Vehicle
  → Describe Symptom
  → AI Clarifying Questions
  → Safety/Urgency Check
  → Issue Summary
  → Provider Recommendations
  → Appointment Request Draft
  → Confirmation
```

---

## 3.2 Screen IDs

These extend the earlier consumer screen map.

| Screen ID | Screen Name |
|---|---|
| `C-HELP-01` | Help Me Landing |
| `C-HELP-02` | Select Vehicle |
| `C-HELP-03` | Symptom Intake |
| `C-HELP-04` | AI Clarifying Questions |
| `C-HELP-05` | Safety and Urgency Check |
| `C-HELP-06` | Issue Summary and Recommendations |
| `C-HELP-07` | Appointment Request Draft |
| `C-HELP-08` | Request Confirmation |

---

# 4. Triage Wizard Screens

## 4.1 `C-HELP-01` — Help Me Landing

### Purpose

Start the problem-solving flow with minimal friction.

### Main components

- Selected vehicle chip
- Large input field: “What is happening with your vehicle?”
- Common symptom shortcuts:
  - Warning light
  - Noise
  - Brakes
  - Vibration
  - Overheating
  - No start
  - AC issue
  - Suspension/clunking
- Photo/video upload button
- “Start guided help” primary button
- Safety notice: “If the vehicle feels unsafe, stop driving and seek urgent inspection.”

### Primary actions

- Select vehicle
- Choose symptom shortcut
- Enter free-text symptom
- Start triage

### Next screen

- `C-HELP-02` if no vehicle selected
- `C-HELP-03` if vehicle already selected

### States

| State | Handling |
|---|---|
| No vehicle exists | Prompt to add vehicle or continue with generic vehicle |
| Vehicle limit reached | Show limit notice and archive/upgrade options |
| AI unavailable | Show manual category selection fallback |

---

## 4.2 `C-HELP-02` — Select Vehicle

### Purpose

Attach the issue to a specific vehicle context.

### Main components

- Vehicle cards:
  - photo
  - nickname
  - brand/model/series
  - mileage
  - active issue indicator
- Add new vehicle button
- Continue without vehicle option, limited matching

### Primary actions

- Select vehicle
- Add vehicle
- Continue

### Next screen

- `C-HELP-03`

### States

| State | Handling |
|---|---|
| No vehicles | Empty state with “Add your first vehicle” |
| Fleet user | Show only fleet vehicles assigned or permitted |
| Guest/manual mode | Allow generic vehicle but reduce match accuracy |

---

## 4.3 `C-HELP-03` — Symptom Intake

### Purpose

Capture the initial problem in the user’s own words.

### Main components

- Vehicle context header
- Free-text description field
- Symptom category chips
- Urgency selector:
  - Not urgent
  - Needs attention soon
  - Urgent
  - Unsafe to drive
- Photo/video upload
- Audio note optional future
- “Next” button

### AI behavior

- Detect likely category from text
- Detect safety keywords:
  - brakes
  - steering
  - smoke
  - burning smell
  - airbag
  - overheating
  - loss of power
- Suggest symptom tags

### Next screen

- `C-HELP-04`
- If safety keywords detected, branch to `C-HELP-05`

### States

| State | Handling |
|---|---|
| Input too short | Ask for more detail |
| Safety keyword detected | Show urgent banner |
| Media upload failed | Retry or continue without media |
| User skips details | Continue with lower-confidence triage |

---

## 4.4 `C-HELP-04` — AI Clarifying Questions

### Purpose

Narrow down the likely issue without overwhelming the user.

### Layout

- Progress indicator: “Question 2 of 5”
- Question card
- Answer chips or selectable options
- “Not sure” button
- “Skip” button
- Upload photo/video context button
- Safety banner if relevant

### Example questions

For noise:

- “When does the noise happen?”
  - While braking
  - While turning
  - Over bumps
  - At idle
  - While accelerating

For warning light:

- “Is the light steady or flashing?”
- “What color is the warning light?”
- “Did you notice performance changes?”

For overheating:

- “Is steam or smoke visible?”
- “Did the temperature gauge go into red?”
- “Is the vehicle safe to stop and restart?”

### AI behavior

- Select next question based on previous answer
- Stop asking when confidence is sufficient
- Escalate if answer indicates danger
- Generate structured issue tags

### Next screen

- `C-HELP-05` if urgency/safety needs confirmation
- `C-HELP-06` if enough information collected

### States

| State | Handling |
|---|---|
| Low confidence | Ask one or two more questions |
| User answers “Not sure” | Use broader category and lower confidence |
| Safety-critical answer | Immediate safety screen |
| AI timeout | Use rule-based fallback questions |

---

## 4.5 `C-HELP-05` — Safety and Urgency Check

### Purpose

Handle potentially dangerous issues carefully.

### Trigger conditions

- Brake failure symptoms
- Steering loss
- Airbag warning
- Fire/smell/smoke
- Severe overheating
- Wheel vibration at high speed
- User selects “Unsafe to drive”

### Main components

- Large warning banner
- Safety instructions:
  - Stop driving if unsafe
  - Pull over safely
  - Do not ignore brake/steering symptoms
  - Consider towing
- Urgency level display
- Options:
  - Find urgent provider
  - Request towing if available
  - Continue anyway
  - Save issue for later

### Primary actions

- Find urgent help
- Save issue
- Continue with caution

### Next screen

- `C-HELP-06` with urgent providers prioritized

### States

| State | Handling |
|---|---|
| No urgent provider nearby | Show broader radius or towing suggestion |
| User ignores warning | Log acknowledgment and continue |
| Fleet driver | Notify fleet manager if policy requires |

---

## 4.6 `C-HELP-06` — Issue Summary and Recommendations

### Purpose

Show the user what the system understood and recommend next action.

### Main sections

#### 1. Issue summary card

- Vehicle
- Symptom description
- Likely categories
- Urgency level
- Confidence level
- Uploaded media thumbnails
- Edit summary button

#### 2. Recommended providers

Each provider card shows:

- Provider name
- Distance
- Rating
- Relevant badge
- Availability
- Match explanation
- Request button

Example match explanation:

> “Recommended because this provider has 18 verified suspension jobs on BMW 3 Series and a 4.9 rating for suspension work.”

#### 3. Alternative actions

- View more providers
- Search parts instead
- Ask community question
- Save for later

### Primary actions

- Select provider
- Change urgency
- Edit issue summary
- View map
- Save issue

### Next screen

- `C-HELP-07`

### States

| State | Handling |
|---|---|
| No matching provider | Broaden filters, suggest nearby generalist, or suggest part vendor |
| Low AI confidence | Show “General inspection recommended” |
| Fleet approval required | Show “Submit to fleet manager” instead of direct request |
| Safety-critical | Urgent providers shown first |

---

## 4.7 `C-HELP-07` — Appointment Request Draft

### Purpose

Convert the triage outcome into a structured appointment request.

### Main components

- Provider card
- Vehicle summary
- Issue summary
- AI pre-visit summary preview
- Preferred date/time selector
- Available slots from provider
- Photo/media included toggle
- Consent to share service history toggle
- Notes to provider
- Fleet approval indicator if fleet vehicle
- Submit request button

### AI behavior

- Suggest likely service duration
- Suggest optimal time slots
- Warn if provider is likely too busy
- Warn if safety-critical issue needs urgent handling

### Primary actions

- Select time
- Toggle consent
- Add note
- Submit request
- Choose different provider

### Next screen

- `C-HELP-08`

### States

| State | Handling |
|---|---|
| No consent given | Explain limited provider context |
| Provider unavailable | Suggest alternate time/provider |
| Fleet approval required | Submit as approval request, not direct appointment |
| Validation error | Highlight missing time/consent |

---

## 4.8 `C-HELP-08` — Request Confirmation

### Purpose

Confirm submission and set expectations.

### Main components

- Success message
- Request ID/reference
- Provider name
- Vehicle
- Expected next step
- Cancellation/edit options
- “Track request” button

### Primary actions

- Track request
- Return home
- Add another issue

### States

| State | Handling |
|---|---|
| Request pending provider | Show pending status |
| Fleet approval pending | Show approval status |
| Submission failed | Retry option |

---

# 5. Triage Wizard Decision Logic

## 5.1 Basic decision tree

```text
Start
  ├─ No vehicle selected?
  │    └─ Ask vehicle selection
  │
  ├─ Symptom contains safety keywords?
  │    └─ Show Safety/Urgency screen
  │
  ├─ Enough info for category?
  │    ├─ Yes → Generate summary and recommendations
  │    └─ No → Ask clarifying questions
  │
  ├─ Fleet vehicle?
  │    ├─ Driver role → Submit to fleet approval
  │    └─ Manager role → Direct request allowed
  │
  └─ Providers found?
       ├─ Yes → Show ranked providers
       └─ No → Broaden search or suggest general inspection
```

---

## 5.2 Urgency handling

| Urgency | UX Behavior |
|---|---|
| Low | Normal flow, standard provider ranking |
| Medium | Highlight “schedule soon” |
| High | Show urgent warning, prioritize available providers |
| Safety-critical | Interrupt flow, strong warning, urgent/towing options |

---

## 5.3 Confidence handling

| AI confidence | UX Behavior |
|---|---|
| High | Show specific category and specialist providers |
| Medium | Show likely categories and ask confirmation |
| Low | Recommend general diagnosis/inspection |
| Missing | Manual category selection fallback |

---

# 6. Triage Wizard AI/MCP Mapping

| Step | MCP Resources Used | MCP Tools Used |
|---|---|---|
| Select vehicle | `res:vehicle.summary` | None |
| Symptom intake | `res:taxonomy.symptoms` | `tool:triage.classify_symptom` |
| Clarifying questions | `res:vehicle.active_issues`, `res:vehicle.service_history` | `tool:triage.ask_question` |
| Safety check | `res:vehicle.summary` | `tool:triage.safety_check` |
| Recommendations | `res:provider.capabilities`, `res:provider.review_summary`, `res:match.provider_candidates` | `tool:match.provider_to_need`, `tool:match.explain` |
| Appointment draft | `res:appointment.availability`, `res:vehicle.consent_status` | `tool:appointment.draft_request`, `tool:appointment.suggest_duration` |
| Pre-visit summary | `res:vehicle.service_history` | `tool:appointment.create_pre_visit_report` |

---

# 7. Triage Wizard UX Rules

1. Do not ask more than 5 questions unless user volunteers more detail.
2. Always show the selected vehicle at the top.
3. Always allow “Not sure” and “Skip”.
4. Never give absolute diagnostic certainty.
5. Safety warnings must be visually distinct.
6. Match explanations must be visible before appointment submission.
7. Fleet drivers should not bypass fleet approval unless policy allows.
8. If AI fails, manual category selection must still work.

---

# 8. Flow B: Fleet Dashboard

## 8.1 Purpose

Give fleet managers a single operational view to:

- monitor vehicle health
- handle driver-reported issues
- approve repairs
- choose trusted providers
- reduce downtime
- track maintenance cost

## 8.2 Primary users

- Fleet owner
- Fleet manager
- Maintenance coordinator
- Driver, limited mobile view

## 8.3 Entry points

- Web portal after login
- Notification: “Driver reported issue”
- Notification: “Approval required”
- Vehicle Detail: “View fleet dashboard”
- Admin-assisted fleet onboarding

## 8.4 Success metrics

- Time from issue report to manager approval
- Time from approval to appointment request
- Number of overdue maintenance items
- Monthly repair cost trend
- Vehicle downtime estimate
- Driver-reported issue completion rate

---

# 9. Fleet Dashboard Screen Map

## 9.1 High-level manager flow

```text
Login
  → Fleet Dashboard
  → Review Alerts
      ├─ Vehicle due for service
      ├─ Driver-reported issue
      ├─ Pending approval
      └─ Active repair
  → Open Vehicle/Issue Detail
  → Review AI Summary
  → Approve/Reject/Request Info
  → Choose Provider
  → Request Appointment
  → Track Completion
  → View Report
```

---

## 9.2 Screen IDs

| Screen ID | Screen Name |
|---|---|
| `F-DASH-01` | Fleet Dashboard Home |
| `F-ALERT-01` | Alerts and Approvals Queue |
| `F-VEH-02` | Fleet Vehicle Detail |
| `F-ISSUE-01` | Driver Issue Report |
| `F-ISSUE-02` | Issue Review and Approval |
| `F-APP-02` | Appointment Approval |
| `F-APP-01` | Appointment List |
| `F-REP-01` | Fleet Reports |

---

# 10. Fleet Dashboard Screens

## 10.1 `F-DASH-01` — Fleet Dashboard Home

### Purpose

Daily operational cockpit.

### Layout

#### Top KPI row

- Total vehicles
- Active issues
- Pending approvals
- Vehicles due for service
- Vehicles in repair
- Monthly spend

#### Main widgets

1. **Needs attention**
   - Driver-reported issues
   - Safety-critical alerts
   - Pending approvals

2. **Maintenance due**
   - Vehicles approaching service by date/mileage
   - Overdue items

3. **Active repairs**
   - Vehicles currently with providers
   - Appointment status
   - Estimated completion

4. **Recent activity**
   - Completed repairs
   - New issue reports
   - Approved requests
   - Cost updates

5. **Quick actions**
   - Add vehicle
   - Report issue
   - Create appointment request
   - Invite driver
   - Export report

### Primary actions

- Open alert
- Approve request
- View vehicle
- Create request
- View reports

### States

| State | Handling |
|---|---|
| New fleet, no vehicles | Onboarding checklist |
| No active issues | Positive empty state |
| Approval overload | Sort by urgency and safety |
| Data loading | Skeleton loaders per widget |
| Plan limit reached | Show upgrade/contact sales prompt |

---

## 10.2 `F-ALERT-01` — Alerts and Approvals Queue

### Purpose

Central queue for items requiring manager action.

### Table/card fields

- Alert type
- Vehicle
- Driver
- Urgency
- AI summary
- Submitted time
- Status
- Action button

### Alert types

- Driver issue reported
- Approval required
- Service due
- Repair completed
- Provider responded
- Cost estimate ready

### Filters

- Urgency
- Vehicle
- Driver
- Status
- Date

### Primary actions

- Open
- Approve
- Reject
- Request more info
- Assign provider

### States

| State | Handling |
|---|---|
| Empty queue | “No pending actions” |
| Safety-critical alert | Pinned to top with red indicator |
| Stale approval | Highlight age and remind |

---

## 10.3 `F-VEH-02` — Fleet Vehicle Detail

### Purpose

Show full context for one fleet vehicle.

### Header

- Vehicle photo/name
- VIN masked
- License plate
- Assigned driver
- Mileage
- Status
- Active issue indicator

### Tabs

| Tab | Content |
|---|---|
| Overview | Key stats, active issues, reminders |
| Service History | Past services and providers |
| Costs | Repair cost by period/category |
| Documents | Insurance, registration, invoices |
| Issues | Open and resolved issues |
| Appointments | Past/upcoming repair requests |

### Primary actions

- Report issue
- Create appointment request
- Assign driver
- Upload document
- View cost report

### States

| State | Handling |
|---|---|
| No driver assigned | Prompt assignment |
| No service history | Empty state with add record |
| Open safety issue | Banner at top |
| In repair | Show appointment status card |

---

## 10.4 `F-ISSUE-01` — Driver Issue Report

### Purpose

Allow driver to report a problem quickly, usually mobile-first.

### Main components

- Assigned vehicle selector
- Symptom input
- Common issue shortcuts
- Photo upload
- Urgency selector
- Safety checkbox: “Vehicle feels unsafe”
- Submit to manager button

### AI behavior

- Classify symptom
- Suggest urgency
- Generate issue summary
- Trigger safety warning if needed

### Primary actions

- Submit report
- Add photo
- Mark unsafe
- Save draft

### Next screen

- Confirmation screen or dashboard depending on role

### States

| State | Handling |
|---|---|
| No assigned vehicle | Ask driver to contact fleet manager |
| Safety-critical | Show urgent warning and notify manager immediately |
| Offline | Save draft and sync later |
| Media upload failed | Allow text-only submission |

---

## 10.5 `F-ISSUE-02` — Issue Review and Approval

### Purpose

Allow manager to evaluate a driver-reported issue.

### Main sections

#### Issue summary

- Vehicle
- Driver
- Reported symptom
- Photos
- Urgency
- AI triage summary
- Safety flags

#### Vehicle context

- Mileage
- Recent service history
- Past related issues
- Warranty/insurance notes if relevant

#### AI recommendation

- Likely service category
- Recommended action
- Suggested provider list
- Estimated cost range if available

### Primary actions

- Approve repair request
- Reject
- Request more info from driver
- Choose provider
- Convert to appointment request
- Mark resolved

### States

| State | Handling |
|---|---|
| Needs more info | Send structured question to driver |
| Safety-critical | Block low-priority handling; require urgent action |
| No provider available | Broaden search or add manual provider |
| Cost too high | Request alternative estimate |

---

## 10.6 `F-APP-02` — Appointment Approval

### Purpose

Approve a specific repair request and provider selection.

### Main components

- Vehicle summary
- Issue summary
- Selected provider card
- Provider match explanation
- Estimated cost
- Estimated duration
- Preferred time windows
- Approval notes
- Approve/reject buttons

### AI behavior

- Recommend provider based on:
  - fleet preferred providers
  - capability fit
  - rating
  - distance
  - availability
  - historical cost performance

### Primary actions

- Approve
- Reject
- Change provider
- Change time
- Request info

### Next screen

- `F-APP-01` appointment tracking

### States

| State | Handling |
|---|---|
| Missing cost estimate | Allow approval with “estimate pending” flag |
| Provider not preferred | Show warning but allow override |
| Duplicate request | Warn manager |
| Driver unavailable | Allow manager to schedule anyway |

---

## 10.7 `F-APP-01` — Appointment List

### Purpose

Track all fleet appointments.

### Table fields

- Vehicle
- Provider
- Service category
- Status
- Date/time
- Cost estimate
- Approval status
- Action needed

### Filters

- Status
- Vehicle
- Provider
- Date
- Approval status

### Primary actions

- View detail
- Contact provider
- Reschedule request
- Mark completed
- Leave review

### States

| State | Handling |
|---|---|
| No appointments | Empty state with CTA |
| Awaiting parts | Highlight delay reason |
| Completed | Trigger review and cost logging |
| Cancelled | Show reason and restart option |

---

## 10.8 `F-REP-01` — Fleet Reports

### Purpose

Provide operational and cost visibility.

### Report widgets

- Total spend by month
- Cost by vehicle
- Cost by service category
- Most repaired vehicles
- Provider usage
- Average approval time
- Downtime estimate
- Maintenance compliance

### Primary actions

- Change date range
- Group by vehicle/provider/category
- Export CSV
- Schedule report optional future

### States

| State | Handling |
|---|---|
| No data | Explain minimum data needed |
| Large fleet | Paginate or summarize top offenders |
| Export failed | Retry and notify |

---

# 11. Fleet User Journeys

## 11.1 Journey 1: Fleet manager handles routine maintenance

```text
Manager opens Fleet Dashboard
  → Sees “3 vehicles due for service”
  → Opens vehicle list
  → Selects vehicle
  → Chooses preferred provider
  → Requests appointment
  → Provider confirms
  → Manager tracks completion
  → Service record and cost update dashboard
```

---

## 11.2 Journey 2: Driver reports a safety issue

```text
Driver opens assigned vehicle
  → Selects “Report issue”
  → Describes brake noise
  → AI flags safety-critical
  → Driver confirms vehicle feels unsafe
  → System notifies fleet manager immediately
  → Manager sees urgent alert
  → Approves urgent inspection
  → System recommends brake specialist
  → Manager selects provider
  → Appointment requested
  → Provider confirms
  → Vehicle marked “In repair”
  → Completion updates fleet dashboard
```

---

## 11.3 Journey 3: Manager approves a costly repair

```text
Provider submits cost estimate
  → Manager receives notification
  → Opens Appointment Approval screen
  → Reviews AI summary:
      - likely failure point
      - past repair history
      - estimated downtime
      - provider rating
  → Manager compares preferred provider alternative
  → Approves or requests second estimate
  → Decision logged
  → Appointment proceeds or pauses
```

---

## 11.4 Journey 4: Fleet manager reviews monthly cost

```text
Manager opens Reports
  → Selects last month
  → Groups by vehicle
  → Sees one vehicle with repeated suspension cost
  → Drills into vehicle detail
  → Reviews service history and provider notes
  → Decides whether to continue repair or replace vehicle
  → Exports report for management
```

---

# 12. Fleet Dashboard Role Differences

| Screen | Fleet Owner | Fleet Manager | Driver |
|---|---:|---:|---:|
| Dashboard Home | Full | Full | Limited |
| Alerts Queue | Full | Full | Own issues only |
| Vehicle Detail | Full | Full | Assigned vehicle only |
| Issue Report | Can create | Can create | Assigned vehicle only |
| Approval Screen | Full | Full | No |
| Appointment List | Full | Full | Assigned vehicle only |
| Reports | Full | Full | No |
| Settings/Plan | Full | Limited | No |

---

# 13. Fleet Dashboard AI/MCP Mapping

| Screen/Step | MCP Resources Used | MCP Tools Used |
|---|---|---|
| Dashboard alerts | `res:fleet.maintenance_board`, `res:fleet.approvals` | None or summary tool |
| Driver issue report | `res:vehicle.summary`, `res:taxonomy.symptoms` | `tool:triage.classify_symptom`, `tool:fleet.create_issue_report` |
| Issue review | `res:vehicle.service_history`, `res:vehicle.active_issues` | `tool:fleet.summarize_vehicle_health`, `tool:triage.create_summary` |
| Approval recommendation | `res:fleet.preferred_providers`, `res:provider.capabilities`, `res:match.provider_candidates` | `tool:fleet.draft_approval_recommendation`, `tool:fleet.suggest_provider` |
| Appointment request | `res:appointment.availability` | `tool:appointment.draft_request` |
| Pre-visit report | `res:vehicle.summary`, `res:vehicle.service_history` | `tool:appointment.create_pre_visit_report` |
| Reports | `res:fleet.cost_summary` | `tool:fleet.generate_cost_report` |

---

# 14. Shared UI States and Edge Cases

## 14.1 Loading states

| Area | Behavior |
|---|---|
| Triage AI question | Show short skeleton or typing indicator |
| Provider recommendations | Skeleton cards with “Finding trusted specialists…” |
| Fleet dashboard widgets | Independent skeletons per widget |
| Reports | Show generated-at timestamp and loading state |

## 14.2 Empty states

| Screen | Empty State |
|---|---|
| Triage recommendations | “No exact specialists nearby. Try broader search or general inspection.” |
| Fleet dashboard alerts | “No urgent actions. Fleet is healthy.” |
| Fleet vehicles | “Add your first vehicle to start tracking maintenance.” |
| Appointment list | “No appointments yet.” |
| Reports | “Add vehicles and service records to unlock insights.” |

## 14.3 Error states

| Error | Handling |
|---|---|
| AI unavailable | Fall back to manual category selection |
| Provider search failed | Retry, widen radius, show saved providers |
| Appointment submission failed | Preserve form data and retry |
| Fleet approval failed | Show reason and notify admin if permission issue |
| Media upload failed | Allow submission without media |

---

# 15. Notification Touchpoints

## Triage Wizard notifications

| Event | Recipient | Channel |
|---|---|---|
| Request submitted | User/fleet manager | In-app/email |
| Provider confirms | User/fleet manager | In-app/email/push |
| Provider proposes alternative | User/fleet manager | In-app/email/push |
| Safety-critical issue detected | Fleet manager if fleet vehicle | Push/email |
| Review invitation after completion | User | In-app/email |

## Fleet Dashboard notifications

| Event | Recipient | Channel |
|---|---|---|
| Driver reports issue | Fleet manager | Push/email |
| Approval required | Fleet manager | Push/email |
| Appointment confirmed | Fleet manager/driver | In-app/email |
| Repair completed | Fleet manager/driver | In-app/email |
| Vehicle due for service | Fleet manager | Email/in-app |
| Cost estimate ready | Fleet manager | Push/email |

---

# 16. Accessibility and Usability Rules

## Triage Wizard

- Large tap targets for mobile users.
- Simple language, no technical jargon unless explained.
- Safety warnings must not rely on color alone.
- Allow voice-to-text input if platform supports it.
- Show progress and allow back navigation without losing data.

## Fleet Dashboard

- Dense tables should remain readable on desktop.
- Critical alerts should be distinguishable by icon, text, and position.
- Approval actions should require explicit confirmation for high-cost items.
- Drivers should get a simplified mobile view, not the full manager dashboard.
- Export and reporting actions should show progress and result state.

---

# 17. MVP Scope Boundaries

## Triage Wizard MVP includes

- Vehicle selection
- Symptom intake
- AI clarifying questions
- Safety warnings
- Provider recommendations
- Match explanations
- Appointment request draft
- Fleet approval routing

## Triage Wizard MVP excludes

- Live OBDII diagnostics
- Real-time towing dispatch
- Voice-only triage
- Automatic emergency SOS
- Full cost guarantee

## Fleet Dashboard MVP includes

- Dashboard KPIs
- Vehicle list/detail
- Driver issue reports
- Approval workflow
- Provider recommendation
- Appointment tracking
- Basic cost reports

## Fleet Dashboard MVP excludes

- Live telematics
- Driver behavior scoring
- Automatic purchase orders
- Full accounting integration
- Predictive part failure modeling

---

# 18. Final Flow Summary

## Triage Wizard

```text
User needs help
  → Selects vehicle
  → Describes problem
  → AI asks a few questions
  → Safety check if needed
  → System summarizes issue
  → Trusted providers shown with explanations
  → User/fleet requests appointment
  → Provider receives pre-visit context
```

## Fleet Dashboard

```text
Fleet manager monitors fleet
  → Sees alerts/issues
  → Reviews vehicle and AI summary
  → Approves or rejects repair
  → Chooses trusted provider
  → Tracks appointment
  → Reviews cost and downtime after completion
```

