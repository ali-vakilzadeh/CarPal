# Shared Packages

TypeScript code shared by the backend, web, PWA, and mobile apps. It keeps the stack to a single language and catches breaking API changes at build time.

| Folder | Contents |
| :--- | :--- |
| `types/` | Domain types and enums (roles, appointment statuses, taxonomy node types, etc.). |
| `api-contracts/` | OpenAPI specs and generated TypeScript clients for each service. |
| `design-system/` | RTL-first UI tokens and components for web (Tailwind) and React Native. Uses logical spacing and correct icon flipping. |
| `i18n/` | UI dictionary: `locales/en.json`, `locales/fa.json`, plus the CI check that fails on missing FA keys. Also date, number, and currency formatting, including the Jalali calendar and Persian digits. |
