// @carpal/business-ui (frontend/provider-dev-plan.json PRV-GD-08): components shared by the CarPal Workshop PWA and
// the provider Web UI. They take data, words and callbacks as props and import no BFF client, router or app shell;
// each app wraps them in its own pages. Styles: '@carpal/business-ui/styles.css' over the design-system tokens.
// Grows stage by stage: PW1 status chips, counter tile, empty and error states; PW3 request card, pre-visit report,
// answer sheets; PW4 job status and close form; PW5 review card, reply editor, approval card; PW6 comment thread;
// PW7 showcase composer steps.
export { cx } from './cx';
export { StatusChip, appointmentTone, showcaseTone, type ShowcaseState, type StatusChipProps, type StatusTone } from './status-chip';
export { CounterTile, type CounterTileProps, type LinkLike } from './counter-tile';
export { StateBlock, type StateBlockProps } from './state-block';
export { RequestCard, urgencyTone, type RequestCardProps } from './request-card';
export { PreVisitReport, type PreVisitData, type PreVisitReportProps, type PreVisitWords } from './pre-visit-report';
export { JobStatusBar, type JobAction, type JobStatusBarProps, type JobStep } from './job-status';
export { PartLines, emptyPartLine, type PartLine, type PartLinesProps, type PartLinesWords } from './part-lines';
