// Review view models (P11): pure helpers shared by the review page (W-REV-01/03), the link pages (/l/ri, /l/cn) and
// My Activity — the sub-rating sets per subject, the backend's automatic hold rule (W4 autoCheck), the privacy check
// of the text (plates, phone numbers, emails, links), the author statuses, the eligibility → form mode decision,
// the create/update bodies, error messages, URLs and what the browser keeps between pages. No React here.
import type {
  ConfirmationPath,
  Eligibility,
  Review,
  ReviewCreate,
  ReviewUpdate,
  SubRatingDimension,
  TaxonomyNode,
} from '@carpal/api-contracts';
import { ENUMS } from '@carpal/api-contracts';
import { ApiProblem } from '@/lib/api/problem';
import type { MessageKey } from '@/lib/i18n/keys';

export type SubjectType = 'provider' | 'vendor';

/** 52 ReviewSubRating: the dimensions of each subject type (backend domain/reviews.ts). */
export const PROVIDER_DIMENSIONS = ['work_quality', 'communication', 'timeliness', 'price_accuracy', 'cleanliness'] as const;
export const VENDOR_DIMENSIONS = ['part_accuracy', 'availability_accuracy', 'price_fairness', 'service_speed', 'communication'] as const;

export function dimensionsOf(subject: SubjectType): readonly SubRatingDimension[] {
  return subject === 'vendor' ? VENDOR_DIMENSIONS : PROVIDER_DIMENSIONS;
}

export const BODY_MIN = 10;
export const BODY_MAX = 5000;
export const TITLE_MIN = 3;
export const TITLE_MAX = 120;
export const MAX_TAGS = 10;
export const MAX_PHOTOS = 10;

/** Characters as the backend counts them (code points, trimmed). */
export function textLength(s: string): number {
  return [...s.trim()].length;
}

// ---------------------------------------------------------------------------------------------- moderation

const LINK = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|ir|net|org|io|app|me)\b/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const DIGITS = /[0-9۰-۹٠-٩]/g;

/**
 * True when the backend's automatic checks hold a Path 1 review for a moderator (backend trust domain/reviews.ts
 * autoCheck on title + body: a link, an email address or a phone number). The page warns before sending, and the
 * confirmation says "Being checked by our team" instead of "usually within minutes". model.test.ts compares this
 * copy with the backend's (drift check, like the community rule).
 */
export function reviewHeld(title: string | null | undefined, body: string): boolean {
  const text = `${title ?? ''}\n${body}`;
  if (LINK.test(text) || EMAIL.test(text)) return true;
  return (text.match(DIGITS) ?? []).length >= 8 && /[0-9۰-۹٠-٩][\d۰-۹٠-٩\s\-()+]{6,}/.test(text);
}

// ---------------------------------------------------------------------------------------------- privacy check

export type PrivacyKind = 'plate' | 'phone' | 'email' | 'link';

export interface PrivacyFinding {
  kind: PrivacyKind;
  /** The matched text, exactly as typed. */
  match: string;
  start: number;
  end: number;
  /** 1-based line of the match ("Looks like a licence plate in line 2"). */
  line: number;
}

const D = '[0-9۰-۹٠-٩]';
// Iranian plates: 2 digits, a letter, 3 digits, then the 2-digit region code ("22 ب 345 - 67", "12B34511"); and a
// number right after the word "plate"/"پلاک" (its group is the finding, not the word).
const LETTER = String.raw`[ء-یa-zA-Z]`;
const PLATE_IR = new RegExp(String.raw`${D}{2}\s*${LETTER}\s*${D}{3}(?:\s*[-–|]?\s*(?:ایران\s*)?${D}{2})?`, 'gu');
const PLATE_WORD = new RegExp(String.raw`(?:plate|پلاک)\s*(?:no\.?|number|شماره)?\s*:?\s*(${D}[0-9۰-۹٠-٩\s-]{2,10}${D})`, 'giu');
const PHONE = new RegExp(`\\+?${D}[${'0-9۰-۹٠-٩'}\\s\\-()]{6,}${D}`, 'gu');
const EMAIL_G = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const LINK_G = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|ir|net|org|io|app|me)\b/gi;

function digitCount(s: string): number {
  return (s.match(DIGITS) ?? []).length;
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') n++;
  return n;
}

/**
 * What the privacy check points out in a review text (C-REV-01 "This looks like a licence plate. Remove it?"): plates,
 * phone numbers (8+ digits), email addresses and links, in text order, without overlaps. Full names are not detected
 * (no reliable rule; the display note says the full name is never shown). A heuristic: the user keeps or removes.
 */
export function privacyFindings(text: string): PrivacyFinding[] {
  const found: PrivacyFinding[] = [];
  const add = (kind: PrivacyKind, re: RegExp, accept: (m: string) => boolean = () => true) => {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      // A pattern with a group reports the group (the plate number, not the word before it).
      const whole = m[1] ?? m[0];
      const match = whole.trim();
      if (!match || !accept(match)) continue;
      const start = m.index + m[0].lastIndexOf(whole) + whole.indexOf(match);
      const end = start + match.length;
      if (found.some((f) => start < f.end && end > f.start)) continue;
      found.push({ kind, match, start, end, line: lineOf(text, start) });
    }
  };
  add('email', EMAIL_G);
  add('link', LINK_G);
  add('plate', PLATE_WORD, (m) => digitCount(m) >= 3);
  add('plate', PLATE_IR);
  add('phone', PHONE, (m) => digitCount(m) >= 8);
  return found.sort((a, b) => a.start - b.start);
}

/** The text without one finding (and the extra space it leaves). */
export function removeFinding(text: string, f: Pick<PrivacyFinding, 'start' | 'end'>): string {
  const before = text.slice(0, f.start).replace(/[ \t]+$/, '');
  const after = text.slice(f.end).replace(/^[ \t]+/, '');
  if (!before || !after || /\n$/.test(before) || /^[\n.,،!?؟;:)]/.test(after)) return `${before}${after}`;
  return `${before} ${after}`;
}

/** Stable identity of a finding the user chose to keep (the text may move as they type). */
export function findingKey(f: Pick<PrivacyFinding, 'kind' | 'match'>): string {
  return `${f.kind}:${f.match}`;
}

// ---------------------------------------------------------------------------------------------- statuses

/**
 * What the author sees (C-PROF-06 Reviews, C-REV-02): checking (Path 1 automatic checks or a moderator), waiting
 * (Path 2: the business, then a CarPal reviewer), evidence (a reviewer asked for proof, or the business objected),
 * published, rejected, removed (by CarPal, with a reason) and withdrawn (by the author: removed without a reason).
 */
export type AuthorStatus = 'draft' | 'checking' | 'waiting' | 'evidence' | 'published' | 'rejected' | 'removed' | 'withdrawn';

export function authorStatus(
  r: Pick<Review, 'status' | 'reviewer_decision' | 'business_confirmation_status' | 'reviewer_reason_code'>,
): AuthorStatus {
  switch (r.status) {
    case 'draft':
      return 'draft';
    case 'pending_moderation':
      return 'checking';
    case 'pending_approval':
      return r.reviewer_decision === 'evidence_requested' || r.business_confirmation_status === 'rejected' ? 'evidence' : 'waiting';
    case 'published':
      return 'published';
    case 'rejected':
      return 'rejected';
    default:
      return r.reviewer_reason_code ? 'removed' : 'withdrawn';
  }
}

export const STATUS_TONE: Record<AuthorStatus, 'neutral' | 'signal' | 'accent' | 'success' | 'danger'> = {
  draft: 'neutral',
  checking: 'neutral',
  waiting: 'signal',
  evidence: 'signal',
  published: 'success',
  rejected: 'danger',
  removed: 'danger',
  withdrawn: 'neutral',
};

/** reviews.mine_update works only before publication (409 INVALID_TRANSITION(published)). */
export function isEditable(r: Pick<Review, 'status'>): boolean {
  return r.status === 'draft' || r.status === 'pending_moderation' || r.status === 'pending_approval';
}

/** An outcome the author may ask CarPal to look at again (disputes.create mediation_request on the review). */
export function canAppeal(r: Pick<Review, 'status' | 'reviewer_decision' | 'business_confirmation_status' | 'reviewer_reason_code'>) {
  const s = authorStatus(r);
  return s === 'rejected' || s === 'removed';
}

/** The dictionary key of a reviewer's reason code (a ModerationReason), or null for other codes. */
export function reasonKey(code: string | null | undefined): MessageKey | null {
  return code && (ENUMS.ModerationReason as readonly string[]).includes(code) ? (`shell.report.reason.${code}` as MessageKey) : null;
}

export function canWithdraw(r: Pick<Review, 'status'>): boolean {
  return r.status !== 'removed' && r.status !== 'rejected';
}

// ---------------------------------------------------------------------------------------------- eligibility

export type Candidate = Eligibility['candidate_visits'][number];

export interface VisitContext {
  appointment?: string;
  inquiry?: string;
  record?: string;
}

export type FormMode =
  | { kind: 'form'; path: ConfirmationPath; candidate: Candidate | null; late: boolean }
  | { kind: 'blocked'; reason: NonNullable<Eligibility['reason_code']> };

/** The context a page link names (?appointment / ?inquiry / ?record), as a candidate visit id. */
export function requestedVisitId(v: VisitContext): string | null {
  return v.appointment ?? v.inquiry ?? v.record ?? null;
}

/**
 * The form the eligibility allows (52 §21): the visit the link names (or else the first visit inside its 7-day
 * window, else the most recent one) frames the review; inside the window it is Path 1 ("Verified visit"),
 * outside Path 2 with the visit attached ("late"); no visit → Path 2. An invitation grant fixes the path.
 */
export function formMode(e: Eligibility, requested: string | null, grantPath?: ConfirmationPath | null): FormMode {
  // An invitation frames its own visit, so "already reviewed without a visit" does not stop it; the other reasons do.
  if (!e.allowed && !(grantPath && e.reason_code === 'already_reviewed'))
    return { kind: 'blocked', reason: e.reason_code && e.reason_code !== 'ok' ? e.reason_code : 'subject_not_published' };
  const visits = e.candidate_visits;
  const candidate =
    (requested ? visits.find((c) => c.id === requested) : undefined) ??
    (requested ? undefined : (visits.find((c) => c.within_invitation_window) ?? visits[0])) ??
    null;
  if (grantPath) return { kind: 'form', path: grantPath, candidate, late: false };
  if (candidate)
    return {
      kind: 'form',
      path: candidate.within_invitation_window ? 'visit_based' : 'approval_based',
      candidate,
      late: !candidate.within_invitation_window,
    };
  return { kind: 'form', path: 'approval_based', candidate: null, late: false };
}

/** The ReviewCreate context member of a candidate visit. */
export function contextOf(c: Candidate | null): Partial<ReviewCreate> {
  if (!c) return {};
  if (c.type === 'appointment') return { context_appointment_id: c.id };
  if (c.type === 'stock_inquiry') return { context_stock_inquiry_id: c.id };
  return { context_service_record_id: c.id };
}

// ---------------------------------------------------------------------------------------------- the form

export interface ReviewDraft {
  overall: number;
  ratings: Partial<Record<SubRatingDimension, number>>;
  wouldReturn: boolean | null;
  title: string;
  body: string;
  tags: string[];
}

export const EMPTY_DRAFT: ReviewDraft = { overall: 0, ratings: {}, wouldReturn: null, title: '', body: '', tags: [] };

export function draftOf(r: Review): ReviewDraft {
  return {
    overall: r.overall_rating,
    ratings: Object.fromEntries((r.sub_ratings ?? []).map((s) => [s.dimension, s.rating])),
    wouldReturn: r.would_return ?? null,
    title: r.title ?? '',
    body: r.body,
    tags: r.tag_node_ids ?? [],
  };
}

export type DraftProblem = 'overall' | 'bodyShort' | 'bodyLong' | 'title';

export function draftProblems(d: ReviewDraft): DraftProblem[] {
  const out: DraftProblem[] = [];
  if (d.overall < 1 || d.overall > 5) out.push('overall');
  const n = textLength(d.body);
  if (n < BODY_MIN) out.push('bodyShort');
  if (n > BODY_MAX) out.push('bodyLong');
  const tl = textLength(d.title);
  if (tl > 0 && (tl < TITLE_MIN || tl > TITLE_MAX)) out.push('title');
  return out;
}

function subRatings(d: ReviewDraft, subject: SubjectType) {
  return dimensionsOf(subject)
    .filter((dim) => (d.ratings[dim] ?? 0) >= 1)
    .map((dim) => ({ dimension: dim, rating: d.ratings[dim]! }));
}

export function createBody(o: {
  draft: ReviewDraft;
  subject: SubjectType;
  orgId: string;
  candidate: Candidate | null;
  grant?: string | null;
  locale: 'en' | 'fa';
  mediaIds: string[];
}): ReviewCreate {
  const d = o.draft;
  const title = d.title.trim();
  return {
    subject_organization_id: o.orgId,
    subject_type: o.subject,
    // With a grant the invitation names the visit; a second context would contradict it.
    ...(o.grant ? { invitation_grant: o.grant } : contextOf(o.candidate)),
    overall_rating: d.overall,
    ...(o.subject === 'provider' && d.wouldReturn !== null ? { would_return: d.wouldReturn } : {}),
    ...(title ? { title } : {}),
    body: d.body.trim(),
    content_locale: o.locale,
    ...(subRatings(d, o.subject).length ? { sub_ratings: subRatings(d, o.subject) } : {}),
    ...(d.tags.length ? { tag_node_ids: d.tags.slice(0, MAX_TAGS) } : {}),
    ...(o.mediaIds.length ? { media_ids: o.mediaIds.slice(0, MAX_PHOTOS) } : {}),
  };
}

/** The changed members of an edit (reviews.mine_update restarts the checks). */
export function updateBody(before: ReviewDraft, d: ReviewDraft, subject: SubjectType): ReviewUpdate {
  const out: ReviewUpdate = {};
  if (d.overall !== before.overall) out.overall_rating = d.overall;
  if (d.body.trim() !== before.body.trim()) out.body = d.body.trim();
  if (d.title.trim() !== before.title.trim() && textLength(d.title) > 0) out.title = d.title.trim();
  if (subject === 'provider' && d.wouldReturn !== before.wouldReturn && d.wouldReturn !== null) out.would_return = d.wouldReturn;
  const ratings = subRatings(d, subject);
  if (JSON.stringify(ratings) !== JSON.stringify(subRatings(before, subject))) out.sub_ratings = ratings;
  if ([...d.tags].sort().join() !== [...before.tags].sort().join()) out.tag_node_ids = d.tags.slice(0, MAX_TAGS);
  return out;
}

/** Review tags for a subject (review_tag attributes.applies_to: provider | vendor | both). */
export function tagsFor(nodes: readonly TaxonomyNode[], subject: SubjectType): TaxonomyNode[] {
  return nodes.filter((n) => {
    const applies = (n.attributes as { applies_to?: string } | null)?.applies_to;
    return !applies || applies === 'both' || applies === subject;
  });
}

// ---------------------------------------------------------------------------------------------- errors

export type SubmitOutcome =
  | { kind: 'contact' }
  | { kind: 'notAllowed'; key: MessageKey }
  | { kind: 'duplicate' }
  | { kind: 'grantExpired' }
  | { kind: 'linkUsed' }
  | { kind: 'changed' }
  | { kind: 'published' }
  | { kind: 'invalid' }
  | { kind: 'rateLimited' }
  | { kind: 'offline' }
  | { kind: 'failed' };

export function submitOutcome(err: unknown): SubmitOutcome {
  if (!(err instanceof ApiProblem)) return { kind: 'failed' };
  switch (err.code) {
    case 'VERIFIED_CONTACT_REQUIRED':
      return { kind: 'contact' };
    case 'REVIEW_NOT_ALLOWED': {
      const d = typeof err.body.detail === 'string' ? err.body.detail : '';
      const key: MessageKey = d.includes('velocity')
        ? 'reviews.blocked.velocity_limit'
        : d.includes('member')
          ? 'reviews.blocked.member_of_subject'
          : d.includes('taken place')
            ? 'reviews.errors.notYet'
            : 'reviews.errors.notAllowed';
      return { kind: 'notAllowed', key };
    }
    case 'DUPLICATE':
      return { kind: 'duplicate' };
    case 'LINK_EXPIRED':
      return { kind: 'grantExpired' };
    case 'LINK_USED':
      return { kind: 'linkUsed' };
    case 'VERSION_MISMATCH':
      return { kind: 'changed' };
    case 'INVALID_TRANSITION':
      return { kind: 'published' };
    case 'VALIDATION_FAILED':
    case 'REFERENCE_NOT_FOUND':
      return { kind: 'invalid' };
    case 'RATE_LIMITED':
    case 'PAUSED':
      return { kind: 'rateLimited' };
    case 'NETWORK':
      return { kind: 'offline' };
    default:
      return err.status === 429 ? { kind: 'rateLimited' } : { kind: 'failed' };
  }
}

/** Link-page outcome of an ri/cn call (SEC-LT-4/5: 410 expired or used, 403 another account). */
export type LinkProblem = 'expired' | 'used' | 'mismatch' | 'code' | 'rateLimited' | 'failed';

export function linkProblem(err: unknown): LinkProblem {
  if (!(err instanceof ApiProblem)) return 'failed';
  if (err.code === 'LINK_USED') return 'used';
  if (err.code === 'LINK_EXPIRED' || err.status === 410) return 'expired';
  if (err.code === 'LINK_RECIPIENT_MISMATCH') return 'mismatch';
  if (err.code === 'CODE_INVALID') return 'code';
  if (err.status === 429 || err.code === 'RATE_LIMITED' || err.code === 'PAUSED') return 'rateLimited';
  return 'failed';
}

// ---------------------------------------------------------------------------------------------- URLs

export interface ReviewHrefOptions extends VisitContext {
  as?: SubjectType;
  invite?: boolean;
  edit?: string;
}

/** /<locale>/review/<slug>[?as&appointment&inquiry&record&invite&edit] (ids only, never text or tokens; GD-14). */
export function reviewHref(locale: string, slug: string, o: ReviewHrefOptions = {}): string {
  const q = new URLSearchParams();
  if (o.as === 'vendor') q.set('as', 'vendor');
  if (o.appointment) q.set('appointment', o.appointment);
  if (o.inquiry) q.set('inquiry', o.inquiry);
  if (o.record) q.set('record', o.record);
  if (o.invite) q.set('invite', '1');
  if (o.edit) q.set('edit', o.edit);
  const s = q.toString();
  return `/${locale}/review/${encodeURIComponent(slug)}${s ? `?${s}` : ''}`;
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReviewPageQuery extends VisitContext {
  as: SubjectType | null;
  invite: boolean;
  edit: string | null;
}

/** The review page's query; malformed ids are dropped. */
export function parseReviewQuery(p: URLSearchParams | Record<string, string | string[] | undefined>): ReviewPageQuery {
  const get = (k: string): string | undefined => {
    const v = p instanceof URLSearchParams ? p.get(k) : p[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s ?? undefined;
  };
  const id = (k: string) => {
    const v = get(k);
    return v && ID_RE.test(v) ? v : undefined;
  };
  const as = get('as');
  return {
    as: as === 'vendor' || as === 'provider' ? as : null,
    ...(id('appointment') ? { appointment: id('appointment') } : {}),
    ...(id('inquiry') ? { inquiry: id('inquiry') } : {}),
    ...(id('record') ? { record: id('record') } : {}),
    invite: get('invite') === '1',
    edit: id('edit') ?? null,
  };
}

/** The subject a profile is reviewed as: the page's choice when the organization has that role, else its main role. */
export function subjectOf(roles: readonly string[], asked: SubjectType | null): SubjectType | null {
  if (asked && roles.includes(asked)) return asked;
  if (roles.includes('provider')) return 'provider';
  if (roles.includes('vendor')) return 'vendor';
  return null;
}

/** The review page link for an in-app invitation (review_invitations.mine_list). */
export function invitationHref(
  locale: string,
  inv: { subject: { slug: string | null; organization_type: string }; visit: { type: string; id: string } },
): string | null {
  if (!inv.subject.slug) return null;
  const v = inv.visit;
  const vendor = v.type === 'stock_inquiry';
  return reviewHref(locale, inv.subject.slug, {
    ...(vendor ? { as: 'vendor' as const } : {}),
    ...(v.type === 'appointment' ? { appointment: v.id } : {}),
    ...(v.type === 'stock_inquiry' ? { inquiry: v.id } : {}),
    ...(v.type === 'service_record' ? { record: v.id } : {}),
  });
}
