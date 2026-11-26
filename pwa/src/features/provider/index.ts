// CarPal Workshop / «کارپال تعمیرگاه» (frontend/provider-dev-plan.json, deliverable D2): the provider route group
// /<locale>/provider of the consumer PWA. PW1: shell (business context and switch, tab bar, menu, Open in Web UI),
// Today, business notifications, the entry page and placeholders of the later tabs. PW2: the compact onboarding. PW3:
// appointment requests (list, detail, answer sheets).
export { WorkshopProvider, useWorkshop, useActiveBusiness, useProviderBusinesses } from './context';
export { WorkshopFrame, WorkshopGate, OpenInWebUi } from './shell';
export { WorkshopToday } from './today';
export { WorkshopNotifications } from './notifications';
export { WorkshopEntry, WorkshopSoon } from './entry';
export { WorkshopOnboarding } from './onboarding';
export { WorkshopRequests } from './requests';
export { WorkshopRequestDetail } from './request-detail';
export * from './model';
