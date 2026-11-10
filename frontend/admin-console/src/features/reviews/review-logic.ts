// Rules of the review screens (AC7, Docs/02 WP9 two confirmation paths, Docs/23 A-REV-01/02, A-DSP-01, Docs/40 §23.4).
// Kept apart from the screens so they are unit-tested: the Path 2 stage of a review (the same rule as the backend's
// queue filter), what a CarPal reviewer may decide now and why not, the review a moderation case shows (its target
// snapshot is untyped JSON in the contract, DI-21), which moderation actions apply to a review in its state, and
// what upholding or rejecting a dispute does to its target (the backend's dispute outcome).
import type {
  BusinessConfirmationStatus,
  DisputeType,
  Review,
  ReviewStatus,
  StaffDispute,
  StaffReviewApprovalView,
  VerifiedStatus,
} from '@carpal/api-contracts';
import type { MessageKey } from '@/lib/i18n/keys';
import type { ReasonKind } from '@/lib/config/reasons';
import { reviewContentActions, type ContentAction } from '@/features/moderation';

// The case vocabulary moved to the moderation rules (AC8); re-exported for the review and dispute screens.
export {
  CASE_RESOLUTION_MAX,
  CASE_SEVERITIES,
  CASE_SOURCES,
  CASE_STATUSES,
  CLOSE_STATUSES,
  enumLabel,
  MODERATION_REASONS,
  OPEN_CASE_STATUSES,
  type CloseStatus,
} from '@/features/moderation';

export const APPROVAL_STAGES = ['awaiting_reviewer', 'awaiting_business', 'evidence_requested'] as const;
export type ApprovalStage = (typeof APPROVAL_STAGES)[number];

export const BUSINESS_STATUSES: readonly BusinessConfirmationStatus[] = ['pending', 'confirmed', 'rejected', 'no_response'];
export const VERIFIED_STATUSES: readonly VerifiedStatus[] = [
  'appointment_verified',
  'inquiry_verified',
  'service_record_verified',
  'invoice_verified',
  'fleet_confirmed',
  'admin_verified',
  'pending_approval',
  'approved_without_visit',
  'rejected',
];
export const REVIEW_STATUSES: readonly ReviewStatus[] = [
  'draft',
  'pending_moderation',
  'pending_approval',
  'published',
  'rejected',
  'removed',
];
export const CONFIRMATION_PATHS = ['visit_based', 'approval_based'] as const;
export const BUSINESS_SOURCES = ['business_answer', 'business_invited', 'deadline_passed'] as const;

/** The Path 2 stage of a pending review (backend approvalStage, the admin.review_approvals_queue `stage` filter). */
export function approvalStage(r: Pick<Review, 'business_confirmation_status' | 'reviewer_decision'>): ApprovalStage {
  if (r.reviewer_decision === 'evidence_requested') return 'evidence_requested';
  if (r.business_confirmation_status === 'pending') return 'awaiting_business';
  return 'awaiting_reviewer';
}

/** Why "Confirm" is not possible now (null = it is): the business step comes first (Docs/40 INVALID_TRANSITION). */
export type ConfirmBlock = 'not_pending' | 'business_pending' | 'business_rejected';

export function confirmBlock(v: Pick<StaffReviewApprovalView, 'review'>): ConfirmBlock | null {
  if (v.review.status !== 'pending_approval') return 'not_pending';
  const b = v.review.business_confirmation_status;
  if (b === 'rejected') return 'business_rejected';
  if (b !== 'confirmed' && b !== 'no_response') return 'business_pending';
  return null;
}

/** A reviewer decision is still open (reject and ask for evidence work in every Path 2 stage). */
export const decidable = (v: Pick<StaffReviewApprovalView, 'review'>) => v.review.status === 'pending_approval';

/** The first words of a review for a list (title first, else the text). */
export function excerpt(r: { title?: string | null; body?: string | null }, max = 90): string {
  const text = (r.title?.trim() || r.body?.trim() || '').replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The review a moderation case of type review shows (admin.case_get target_snapshot; null when not a review). */
export interface ReviewSnapshot {
  id: string;
  subjectOrganizationId: string | null;
  rating: number | null;
  title: string | null;
  body: string;
  status: string;
  path: string | null;
  verifiedStatus: string | null;
  createdAt: string | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);

export function reviewSnapshot(snapshot: unknown): ReviewSnapshot | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const s = snapshot as Record<string, unknown>;
  if (s.type !== 'review' || typeof s.id !== 'string' || s.available === false) return null;
  return {
    id: s.id,
    subjectOrganizationId: str(s.subject_organization_id),
    rating: typeof s.overall_rating === 'number' ? s.overall_rating : null,
    title: str(s.title),
    body: str(s.body) ?? '',
    status: str(s.status) ?? 'unknown',
    path: str(s.confirmation_path),
    verifiedStatus: str(s.verified_status),
    createdAt: str(s.created_at),
  };
}

/**
 * The actions that apply to the review in its state (the backend's review target, the shared moderation rules of
 * AC8): "approve" publishes a Path 1 review the automatic checks held back; a review has no hidden state, so hide and
 * remove are one action (DI-22); restore brings a removed review back; a warning goes to the author.
 */
export function reviewActions(r: ReviewSnapshot | null): ContentAction[] {
  return r ? reviewContentActions(r.status, r.path) : ['warn_user'];
}

/** Path 1 → Path 2 (admin.review_move_to_approval_path): a visit-based review that is published or held back. */
export function canMoveToApprovalPath(r: ReviewSnapshot | null): boolean {
  return !!r && r.path === 'visit_based' && (r.status === 'published' || r.status === 'pending_moderation');
}

export const DISPUTE_TYPES: readonly DisputeType[] = [
  'review_approval_objection',
  'fake_review',
  'inaccurate_review',
  'mediation_request',
  'badge_challenge',
  'service_record_dispute',
  'moderation_appeal',
];
export const DISPUTE_STATUSES: readonly StaffDispute['status'][] = [
  'open',
  'in_mediation',
  'resolved_upheld',
  'resolved_rejected',
  'withdrawn',
];
export const OPEN_DISPUTE_STATUSES: readonly StaffDispute['status'][] = ['open', 'in_mediation'];
export const DISPUTE_TARGETS = ['review', 'service_record', 'badge', 'appointment', 'moderation_action'] as const;

export type DisputeOutcome = 'in_mediation' | 'resolved_upheld' | 'resolved_rejected';

export const OUTCOME_REASON: Record<DisputeOutcome, ReasonKind> = {
  in_mediation: 'mediation',
  resolved_upheld: 'dispute_uphold',
  resolved_rejected: 'dispute_reject',
};

/** The outcomes a staff member may choose now (withdrawing is the raiser's own step; Docs/40 has no staff withdraw). */
export function disputeOutcomes(d: Pick<StaffDispute, 'status'>): DisputeOutcome[] {
  if (d.status === 'open') return ['in_mediation', 'resolved_upheld', 'resolved_rejected'];
  if (d.status === 'in_mediation') return ['resolved_upheld', 'resolved_rejected'];
  return [];
}

/**
 * What an outcome does to the target (backend admin.dispute_resolve): the effect key for the decision panel. For an
 * objection of the business, "upheld" keeps the author's review: it is published with "Disputed by the business".
 */
export function outcomeEffect(type: string, outcome: DisputeOutcome): MessageKey {
  if (outcome === 'in_mediation') return 'admin.disputes.effect.mediation';
  const upheld = outcome === 'resolved_upheld';
  switch (type) {
    case 'review_approval_objection':
      return upheld ? 'admin.disputes.effect.objectionUpheld' : 'admin.disputes.effect.objectionRejected';
    case 'fake_review':
      return upheld ? 'admin.disputes.effect.fakeUpheld' : 'admin.disputes.effect.keepTarget';
    case 'badge_challenge':
      return upheld ? 'admin.disputes.effect.badgeUpheld' : 'admin.disputes.effect.keepTarget';
    case 'moderation_appeal':
      return upheld ? 'admin.disputes.effect.appealUpheld' : 'admin.disputes.effect.keepTarget';
    default:
      return upheld ? 'admin.disputes.effect.manualUpheld' : 'admin.disputes.effect.keepTarget';
  }
}

/** Resolution text limits (Docs/40 admin.dispute_resolve: resolution Text<2000>, required when resolved; notes Text<3000>). */
export const RESOLUTION_MAX = 2000;
export const NOTES_MAX = 3000;
