** Detailed project plan for the CarPal MVP **



### 1. Technology Stack & Resource Strategy (Minimizing Language Diversity)

To achieve the absolute lowest language diversity while covering Backend, AI, Web, and Mobile (iOS/Android), we will use a **Unified TypeScript Ecosystem** combined with **SQL** and **JSON**. 

| Layer | Technology | Language | Justification |
| :--- | :--- | :--- | :--- |
| **Backend & Microservices** | Node.js + NestJS | **TypeScript** | High performance, strict typing, native support for MCP/AI SDKs, shares types with frontend. |
| **Web Frontend (PC/Mobile Web)** | React + Next.js | **TypeScript** | SSR for SEO (public profiles), shares business logic and types with backend and mobile. |
| **Mobile Frontend (iOS/Android)** | React Native | **TypeScript** | Single codebase for iOS and Android. Shares up to 70% of logic/types with the Web frontend. |
| **Database** | PostgreSQL | **SQL** | Relational integrity, JSONB support for multi-language data, Row-Level Security (RLS) for tenancy. |
| **Search & Projections** | Elasticsearch | **JSON/REST** | High-performance geo-spatial and full-text search. |
| **AI & MCP Orchestration** | Vercel AI SDK / LangChain.js | **TypeScript** | Keeps AI orchestration in the same language as the backend, avoiding Python silos. |
| **Infrastructure & Configs** | Terraform, Docker, K8s | **HCL / YAML / JSON** | Standard IaC and container orchestration. |

**Total Core Programming Languages: 2 (TypeScript, SQL) + JSON for configs/data.**

---

### 2. Multi-Language & UI Dictionary Strategy (EN/FA First)

To ensure all modules are multi-language compatible without requiring code changes for new languages:

#### A. UI Dictionary (Static & Platform Text)
*   **Storage:** JSON files hosted on a CDN or S3 bucket (e.g., `cdn.carpal.app/i18n/v1/en.json`, `fa.json`). **Not in the database.**
*   **Structure:** Nested keys (e.g., `{"errors": {"vehicle_not_found": "Vehicle not found"}}`).
*   **Frontend Implementation:** Uses `react-i18next` (Web) and `i18next` (Mobile). The app fetches the JSON on startup and caches it. 
*   **RTL Support:** Persian (FA) requires Right-to-Left layout. The UI framework (Tailwind CSS for Web, `I18nManager` for React Native) will automatically flip layouts based on the active language.

#### B. Dynamic Data Translation (User/Entity Data)
*   **Database Strategy:** For translatable entity fields (e.g., Provider Descriptions, Inventory Names, Taxonomy labels), we use PostgreSQL **`JSONB`** columns.
    *   *Example:* `inventory_items.name_translations = {"en": "Brake Pad", "fa": "لنت ترمز"}`.
*   **API Strategy:** The API accepts an `Accept-Language: fa` header. The backend automatically extracts the requested language from the JSONB column. If the translation is missing, it falls back to English (`en`).

---

### 3. Work Packages (WP) Breakdown

Each WP is designed as an independent microservice or deployable unit. They can be built, tested, and deployed in isolation.

#### **WP1: Foundation, Infrastructure & Security (The "Plumbing")**
*   **Scope:** Multi-region cloud setup (EU, US, APAC), CI/CD pipelines, Kubernetes/ECS clusters, VPC networking, WAF, and global DNS routing.
*   **Independent Deployment:** Deployed via Terraform. No application code required.
*   **Testing:** Infrastructure-as-Code (IaC) linting, network connectivity tests, SSL certificate validation, and disaster recovery failover drills.
*   **Resources:** 1 DevOps/Cloud Engineer, 1 Security Engineer.

#### **WP2: Identity, Access & Consent (The "Gatekeeper")**
*   **Scope:** User accounts, OAuth2/OIDC authentication, RBAC, multi-tenancy context injection, and the `ConsentRecord` management (crucial for GDPR).
*   **Independent Deployment:** Deployed as the `identity-service` container.
*   **Testing:** JWT token generation/validation tests, RBAC matrix tests (ensuring User A cannot access Org B), consent revocation flow tests.
*   **Resources:** 2 Backend Engineers (TypeScript).

#### **WP3: Core Domain, Taxonomy & Plans (The "Brain")**
*   **Scope:** Organization profiles, Subscription/Plan limits, and the global `TaxonomyNode` hierarchy (with multi-language JSONB support).
*   **Independent Deployment:** Deployed as `core-service` and `taxonomy-service`.
*   **Testing:** CRUD operations, taxonomy hierarchy validation (no circular parents), plan limit enforcement tests (e.g., blocking 6th vehicle for free tier).
*   **Resources:** 2 Backend Engineers (TypeScript), 1 DBA (SQL).

#### **WP4: Vehicle & Garage Management (The "Context")**
*   **Scope:** Vehicle profiles, service records, issues, documents (S3 integration), and maintenance reminders.
*   **Independent Deployment:** Deployed as `vehicle-service`.
*   **Testing:** VIN validation logic, document upload/encryption tests, service history timeline generation, vehicle ownership boundary tests.
*   **Resources:** 2 Backend Engineers (TypeScript).

#### **WP5: Provider, Vendor & Search Projections (The "Supply")**
*   **Scope:** Provider capabilities/evidence, Vendor inventory/fitment, and syncing this data to Elasticsearch for fast geo-spatial and text search.
*   **Independent Deployment:** Deployed as `provider-service`, `vendor-service`, and `search-indexer`.
*   **Testing:** Search query performance tests, tenant isolation tests (ensuring Vendor A cannot see Vendor B's private inventory), fitment confidence calculation tests.
*   **Resources:** 2 Backend Engineers (TypeScript), 1 Search/Elastic Engineer.

#### **WP6: Appointments & Fleet Workflows (The "Transactions")**
*   **Scope:** Appointment state machine, pre-visit reports, fleet driver assignments, and fleet approval workflows.
*   **Independent Deployment:** Deployed as `appointment-service` and `fleet-service`.
*   **Testing:** State machine transition tests (e.g., cannot move to 'completed' without 'confirmed'), fleet approval routing tests, concurrency tests for booking slots.
*   **Resources:** 2 Backend Engineers (TypeScript).

#### **WP7: Trust, Reviews & Community (The "Reputation")**
*   **Scope:** Reviews, ratings, moderation queues, community posts, and Q&A.
*   **Independent Deployment:** Deployed as `trust-service` and `community-service`.
*   **Testing:** Review verification logic (e.g., ensuring review matches completed appointment), rating aggregation tests, moderation queue routing tests.
*   **Resources:** 2 Backend Engineers (TypeScript).

#### **WP8: MCP, AI & Governance (The "Intelligence")**
*   **Scope:** MCP Server, AI context assembly, PII redaction, prompt management, insight storage, and immutable audit logging.
*   **Independent Deployment:** Deployed as `mcp-gateway` and `ai-inference` pods.
*   **Testing:** Mock LLM tests for tool execution, policy enforcement tests (blocking unauthorized data access), audit log immutability tests, PII redaction accuracy tests.
*   **Resources:** 2 AI/Backend Engineers (TypeScript), 1 Data/Governance Specialist.

#### **WP9: Web Portals - Provider, Vendor, Fleet, Admin (The "Business UI")**
*   **Scope:** Next.js web applications for business users. Includes role-based routing, data tables, and full integration with the UI Dictionary (EN/FA).
*   **Independent Deployment:** Deployed as static/SSR web apps via Vercel or CDN.
*   **Testing:** End-to-End (E2E) tests via Playwright/Cypress, visual regression tests, RTL (Right-to-Left) layout tests for Persian, accessibility (a11y) tests.
*   **Resources:** 2 Frontend Engineers (TypeScript/React), 1 UI/UX Designer.

#### **WP10: Mobile App - Consumer (The "User UI")**
*   **Scope:** React Native app for iOS and Android. Includes offline capabilities, push notifications, camera integration for documents, and UI Dictionary integration.
*   **Independent Deployment:** Published via Apple App Store and Google Play Store.
*   **Testing:** Mobile UI tests via Detox/Appium, offline-sync tests, push notification delivery tests, RTL layout tests for Persian.
*   **Resources:** 2 Mobile Engineers (TypeScript/React Native), 1 UI/UX Designer.

---

### 4. Resource Allocation Summary

To execute this plan efficiently with minimal language context-switching, the core team structure should be:

| Role | Count | Primary Tech | Responsibility |
| :--- | :--- | :--- | :--- |
| **Full-Stack TypeScript Engineer** | 4 | TS, Node.js, React | Backend microservices, Web portals, API contracts. |
| **Mobile Engineer (React Native)** | 2 | TS, React Native | iOS & Android consumer app. |
| **AI / MCP Engineer** | 1 | TS, AI SDKs | MCP governance, prompt engineering, context assembly. |
| **DevOps / Cloud Engineer** | 1 | Terraform, K8s, AWS/GCP | Multi-region deployment, CI/CD, security, GDPR infra. |
| **UI/UX Designer** | 1 | Figma | Designing for both LTR (EN) and RTL (FA), component library. |
| **QA / Test Automation Engineer**| 1 | TS, Playwright, Detox | Writing independent test modules for each WP. |
| **Product / Project Manager** | 1 | - | Managing WP dependencies, GDPR compliance, localization. |

### 5. Critical Success Factors for this Plan

1.  **Strict API Contracts:** Because WPs are deployed independently, use **gRPC** or **OpenAPI (Swagger)** with TypeScript code generation. If WP4 (Vehicles) changes an API response, WP9 (Web UI) must automatically catch the breaking change during the build phase.
2.  **UI Dictionary CI/CD:** The `UI_langs.JSON` files must be version-controlled. If a developer adds a new UI string in English, the CI pipeline should fail if the Persian (`fa.json`) translation is missing, ensuring no broken UI for Persian users.
3.  **Database JSONB Indexing:** For multi-language search in PostgreSQL, ensure you create GIN indexes on the JSONB translation columns, otherwise, search performance will degrade as data grows.
4.  **RTL First Design:** Do not treat Persian as an "afterthought." The UI component library (Design System) must be built with RTL in mind from WP9/WP10 day one. Margins, paddings, and icons must be logically flipped, not just mirrored.