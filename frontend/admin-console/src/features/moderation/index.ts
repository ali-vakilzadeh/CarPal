export { ContentPage, InventoryPage } from './moderation-pages';
export { BadgePanel } from './badge-panel';
export { CaseWorkspace, type CaseExtraContext } from './case-workspace';
// The case vocabulary and rules, shared with Reviews (AC7 review cases) and My work (SLA timers).
export {
  CASE_RESOLUTION_MAX,
  CASE_SEVERITIES,
  CASE_SOURCES,
  CASE_STATUSES,
  CLOSE_STATUSES,
  enumLabel,
  MODERATION_REASONS,
  OPEN_CASE_STATUSES,
  reviewContentActions,
  type CloseStatus,
  type ContentAction,
} from './case-logic';
