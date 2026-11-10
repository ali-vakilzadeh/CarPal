export { ReviewsPage } from './reviews-page';
// Shared with Disputes & appeals (a disputed review shows the same parts and rules).
export {
  DISPUTE_STATUSES,
  DISPUTE_TARGETS,
  DISPUTE_TYPES,
  disputeOutcomes,
  enumLabel,
  NOTES_MAX,
  OPEN_DISPUTE_STATUSES,
  OUTCOME_REASON,
  outcomeEffect,
  RESOLUTION_MAX,
  type DisputeOutcome,
} from './review-logic';
export { AuthorContext, BusinessStep, EvidenceList, ReviewBlock } from './review-parts';
