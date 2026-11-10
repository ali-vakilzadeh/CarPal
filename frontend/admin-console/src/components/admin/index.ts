// The admin interaction kit (AC5): every console screen is built from these, so the admin rules hold everywhere —
// a reason for every write (GD-11), purpose-bound reads (GD-10), four-eyes outcomes (SEC-ADM-6), masked personal data,
// paged tables (SEC-ADM-7), the three-panel case layout and the audit trail.
export {
  useAdminAction,
  rememberMyChange,
  actionIntentType,
  ReasonMissingError,
  MY_CHANGES_KEY,
  type ActionArgs,
  type ActionState,
} from './admin-action';
export {
  ReasonPanel,
  ReasonDialog,
  ConfirmDialog,
  type ReasonPanelProps,
  type ReasonDialogProps,
  type ConfirmDialogProps,
} from './reason-panel';
export { FourEyesBanner, ActionNotice, problemText } from './four-eyes-banner';
export { opLabel, FOUR_EYES_OPS } from './op-label';
export { PurposeGate, usePurpose, withPurpose, parsePurpose, purposeKind, type PurposeGateProps } from './purpose-gate';
export { MaskedField, maskValue, maskPhone, maskEmail, maskName, maskTail, type MaskKind, type MaskedFieldProps } from './masked-field';
export {
  DataTable,
  useUrlFilters,
  useCursorPaging,
  ADMIN_PAGE_MAX,
  type Column,
  type CellContext,
  type DataTableProps,
  type FilterDef,
  type FilterOption,
} from './data-table';
export {
  CaseLayout,
  EntityChip,
  Timeline,
  AiEvidenceBlock,
  SlaBadge,
  type CaseLayoutProps,
  type EntityChipProps,
  type EntityType,
  type TimelineItem,
  type AiEvidenceProps,
} from './case-layout';
export { AuditDrawer, type AuditDrawerProps } from './audit-drawer';
