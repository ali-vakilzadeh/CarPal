# PWA P13 — open decisions

Collected 2026-10-31 from `pwa/dev_plan.json` (P13 stage, `open_questions`, `doc_issues`, `backend_alignment`, stage `notes_for_next`).
Fill in each **Answer** line. Leave it empty to accept the **Default**. Once finalised, the answers are written back into `pwa/dev_plan.json`.

---

## 1. Decisions P13's own tasks depend on

### Q1 — Privacy and Terms page (OQ-15, DI-30)
The legal review is still pending. No privacy or terms route exists in `pwa/src/app`. The cookie banner has no privacy link, and the sign-up "Read" dialogs say the text is under review. OQ-15 said "P9/P13 add the privacy page and the link".
- Options: (a) P13 ships a placeholder page per locale (says "under review", names the version) and links it from the banner and the sign-up form; (b) defer to the next iteration until legal delivers the texts.
- Default: blocked on legal (b)
- **Answer:**
The privacy policy is copied in "/Docs/Privacy Policy.md" ; user agreement is stored in "/Docs/User Agreement.md".

### Q2 — "Contact support" channel (OQ-18)
S-AUTH-09, Settings → Help and other screens offer "Contact support". Which channel (email address, help page, in-app form), and where is it configured (region config or PWA env)?
- Default: the action is left out until a channel exists
- **Answer:**
At MVP stage, support is connected to email address support@carpal.app
remember: I haven't secured the domain name carpal.app (it was taken before), I am looking to register a new domain, so after that, will update the domain name.

### Q3 — "Report a problem" on appointments (DI-65)
`reports.create` has no appointment target. `disputes.create` covers appointments but is a different flow. P10 noted "P11/P13 may add the dispute flow".
- Options: (a) add the dispute flow to W-APP-01 in P13; (b) defer.
- Default: not offered (b)
- **Answer:**
Expected to resolve by P13. additional solutions to be planned after MVP.

### Q4 — Questions sitemap and SSR of Q&A hub filtered views (P8 note)
- Options: (a) build in P13 (a sitemap of answered questions + server-rendered filtered hub views); (b) next iteration.
- Default: not built (b)
- **Answer:**
Resolve by P13

### Q5 — Strict-mode security check (DI-09, DI-22)
The security review (P13.T4) would otherwise run against the lite dev backend only. The proof-of-work path (ATT on the anonymous grant, review_invitations.open, reviews.create, sign-up) was never exercised. Origin / Sec-Fetch-Site / CSRF is enforced only by the PWA /id proxy, not by the auth host.
- Options: (a) also run the key security checks against a backend in strict mode; (b) lite only, and record strict mode as a next-iteration item.
- Default: lite only (b)
- **Answer:**
Resolve by P13

### Q6 — Performance measurement method (P13.T3)
Budget: LCP ≤ 2.5 s on a mid-range phone over 4G (landing, provider profile, directory, question pages). Only `@axe-core/playwright` is installed today.
- Options: (a) Playwright + Chrome DevTools network and CPU throttling + web-vitals, no new dependency (recommended); (b) add Lighthouse / Lighthouse CI as a new dev dependency.
- Also decide: the device profile for "mid-range phone on 4G" (e.g. 4× CPU slowdown, 1.6 Mbps down / 750 kbps up / 150 ms RTT).
- Default: none
- **Answer:**
Resolve by P13

---

## 2. Open questions running on their default — confirm or override

### OQ-02 — Map tile source
For local development and the pilot: a PMTiles extract of Tehran, a hosted vector tile service, or the WP1/WP8 tile build? Public OSM tile servers are not used.
- Default: built-in fallback style without a basemap; a real style can be set with `CARPAL_PWA_MAP_STYLE_URL`
- **Answer:**
Default is accepted.

### OQ-03 — Sign-in host in production
Should id.carpal.app serve the hosted sign-in pages from the PWA build (host-based routing) or from a separate small app? A separate host would lose the optional sign-up consents kept in sessionStorage (DI-30).
- Default: built in the PWA codebase as a separate route group; the deployment choice is left to WP1
- **Answer:**
Default is accepted.

### OQ-04 — Guests and Help Me
Should guests run Help Me without an account? The contract makes triage USR-only.
- Default: no; sign in at the vehicle step, and guests use search and the category picker
- **Answer:**
Default is settled.

### OQ-05 — Consumer posts (repair stories and tips)
Will the contract get a consumer post operation (W-COMP-01)?
- Default: the composer supports questions only (DI-02)
- **Answer:**
Default is settled.

### OQ-06 — BFF session store in production
Redis (shared with the backend's Redis) or another store? With more than one PWA instance, the refresh single-flight must become a distributed lock.
- Default: in-memory store in dev; Redis adapter written but unverified
- **Answer:**
Default is accepted.

### OQ-17 — Suspended / deactivated accounts at sign-in
They get the same answer as a wrong password (SEC-AU-11), so S-AUTH-09 (reason, appeal, data export, reactivation) cannot be shown. Should the auth host reveal the state after a correct credential (e.g. 403 ACCOUNT_SUSPENDED), or should these screens live elsewhere (an email with a link)?
- Default: not shown at sign-in; the generic message stays (DI-33)
- **Answer:**
Default is accepted.

### OQ-19 — HEIC/HEIF photos on the web
Ship a WASM decoder (libheif + libde265: LGPL, HEVC patents), or keep asking for a JPEG where the browser cannot convert?
- Default: no bundled decoder; the browser converts where it can, otherwise the upload asks for a JPEG
- **Answer:**
Default foe MVP.

### OQ-24 — Account format preferences on the web
Should the web follow the account settings calendar_system, digit_style and distance_unit, or keep following the page language (Jalali + Persian digits in fa, Gregorian + Latin in en) and the region's distance unit?
- Default: follow the page language and the region unit; the account preferences apply to the app and messages
- **Answer:**
Default is accepted.

### OQ-25 — "Service history for this appointment" default
Should it start on (as in the mobile prototype) or off (explicit opt-in, as built)?
- Default: off; the shop is told when history was not shared
- **Answer:**
default is accepted.

### OQ-26 — Web push sender and VAPID keys
Who sends web pushes, and where does the VAPID key pair live? Which push services must be reachable from the pilot (FCM, Mozilla, Apple)?
- Default: the backend notification worker sends them with a VAPID pair from its secret store; each PWA deployment sets `CARPAL_PWA_VAPID_PUBLIC_KEY`; until then no web push controls are shown
- **Answer:**
remain open - will decide later

### Already resolved in practice — confirm closing as answered
- [ ] **OQ-01** Framework versions: P1 took the current stable versions (recorded in the P1 report)
- [ ] **OQ-07** Consumer web push: built in P12
- [ ] **OQ-08** Playwright Chromium download: done (Chromium only)
- [ ] **OQ-09** Small backend changes by PWA stages: done (DI-08 resolved, recorded in both plans)

---

## 3. Backend-team items — pilot blocker or next iteration?

Mark each **B** (must be fixed by the backend before the pilot) or **N** (next iteration). P13.T6 builds the next_iteration list from this.

### Can block a production pilot

| ID | Issue | B / N |
|---|---|---|
| DI-25 | Auth endpoints rate-limit by socket IP; behind the BFF all users share one IP → about 30 sign-in calls per 15 min for the whole site. Needs a trusted forwarded IP or an exemption for confidential clients. |N|
| DI-26 | All server rendering (cp-ssr) shares one anonymous bucket (120/min, 3,000/day; search 10/min). SEO pages hit it within minutes of real traffic. |N|
| DI-28 | Header typeahead (taxonomy.suggest) shares the search bucket (10/min for guests). |N|
| DI-09 | The auth host does not enforce Origin / Sec-Fetch-Site / CSRF (SEC-WEB-3); only the PWA /id proxy does. |N|
| DI-72 | No web push sender in the backend (full-mode PushSender is a skeleton); no VAPID pair anywhere (see OQ-26). |N|
| DI-71 | The push payload carries only notification_id and template_key: no reference, organization_context_id or link. |N|
| DI-16 | Business notifications go to consumer web push tokens too (both are platform 'web'). |N|
| BA-22 | The backend fleet role model (backend OQ-18) is still open: it may change who is limited to linked vehicles. |N|

### Feature gaps (the PWA has a workaround)

| ID | Gap | B / N |
|---|---|---|
| DI-02 | No consumer post operation (stories and tips) |N|
| DI-03 | No public member read (W-PUB-07 Member Page) |N|
| DI-06 | No saved posts / parts / searches |N|
| DI-20 | No slug history: old /shop/<slug> links answer 404 |N|
| DI-30 | No policy versions in config.client; auth.signup takes no optional consents |N|
| DI-31 | No feed-preference operation (topics, brands) |N|
| DI-33 | No auth signals for suspended / locked / unknown number (see OQ-17) |N|
| DI-37 | No 410 / tombstone / merged_into for removed or merged public records |N|
| DI-38 | No public sitemap feed |N|
| DI-39 | Missing public fields: AI review themes, stock last-updated, AI alternatives, showcase consent marker, fitment confidence |N|
| DI-47 | No free-text provider name on service records; no light organization lookup |N|
| DI-48 | No sale date on StatusChange |N|
| DI-49 | Only two reaction types (OQ-21 accepted the mapping; can be closed) |N|
| DI-50 | No viewer context on community reads (is_author, reactions, moderation_status, Comment.organization, mine lists) |N|
| DI-51 | Q&A: no sort, no node ids, no follow question, no top answerers |N|
| DI-52 | followed_update feed cards carry organization_id only |N|
| DI-54 | community.followed_update notification lacks organization name and id |N|
| DI-55 | Profile / settings elements without contract fields (photo, country, deactivate, AI switches, quiet hours, SMS, …) |B|
| DI-56 | Web sessions show the client id as the device label |N|
| DI-57 | Notification types with no backend route (answer to your question, data export ready, request received, …) |N|
| DI-58 | No answer options on triage clarifying questions |N|
| DI-60 | No public.org_get by id |N|
| DI-61 | share_history cannot be updated on drafts; drafts cannot be deleted |N|
| DI-62 | No triage.mine_list (cross-device resume) |N|
| DI-63 | No towing providers; no region emergency numbers |N|
| DI-64 | No short appointment reference |N|
| DI-65 | No appointment target for reports (see Q3) |N|
| DI-66 | Review subject has no OrgSummary |N|
| DI-67 | Consent request view: no caption or tags; no "needs changes" response |N|
| DI-68 | No consumer list of pending consent requests |N|
| DI-70 | Review appeal uses mediation_request instead of moderation_appeal |N|
| DI-73 | IssueWrite has no triage_session_id; drivers cannot read the fleet decision reason |N|

---

## 4. Plan inconsistencies to fix in `pwa/dev_plan.json`

- [ ] `meta.progress.next_stage` is "P12"; P12 is done → set to "P13"
- [ ] The P12 handoff note ends "Next: P11", but P11 is done → record that P13 is next
- [ ] P13.T6 lists the contract gaps as "DI-02/03/06/07"; DI-07 is done in P8, and what is left of it is tracked as DI-52 → replace DI-07 with DI-52
- [ ] P13 vs P14 boundary: P13 deliverable "final README" vs the 2026-10-26 amendment (final README, merged next_iteration list and meta.status in P14.T7) → P13 writes a draft README and P14 finishes it?
  - **Answer:**
RESOLVE ALL IN P13.