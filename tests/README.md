# Cross-cutting Tests

Unit and integration tests live next to each component. This folder holds tests that span multiple components.

| Folder | Contents |
| :--- | :--- |
| `contract/` | API contract tests between services and their consumers (web, PWA, mobile, MCP). |
| `e2e/` | End-to-end journeys from MVP plan section 10: specialist search, provider trust growth, vendor inventory, fleet breakdown. Run in EN and FA. |
| `performance/` | Load tests for search, matching, inventory import, and the AI paths. |
