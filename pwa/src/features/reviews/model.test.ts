// P11 (units): the review view models — the backend's automatic hold rule (drift check against backend
// modules/trust/domain/reviews.ts autoCheck), the privacy check, the eligibility → form decision, the create and
// update bodies, author statuses, errors of the link pages and the page URLs.
import type { Eligibility, Review } from '@carpal/api-contracts';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiProblem } from '@/lib/api/problem';
import {
  authorStatus,
  canAppeal,
  createBody,
  EMPTY_DRAFT,
  draftProblems,
  formMode,
  invitationHref,
  isEditable,
  linkProblem,
  parseReviewQuery,
  privacyFindings,
  reasonKey,
  removeFinding,
  reviewHeld,
  reviewHref,
  subjectOf,
  submitOutcome,
  tagsFor,
  updateBody,
} from './model';

const backendRules = join(__dirname, '../../../../backend/modules/trust/domain/reviews.ts');
const ID = (n: number) => `0195f3b1-6a2b-7c3d-8e4f-${String(n).padStart(12, '0')}`;

const samples = [
  'Great work, fixed the clunk the same day.',
  'Call me on 0912 345 6789',
  'تماس: ۰۹۱۲۳۴۵۶۷۸۹',
  'see www.example.com',
  'mail a@b.co for details',
  'Paid 2,500,000 toman, fair price',
  'Plate 22 B 345 67',
  'carpal.ir is great',
  'It took 2 hours and cost 45 dollars',
];

describe('reviewHeld', () => {
  it('matches the backend autoCheck exactly', async () => {
    const backend = (await import(/* @vite-ignore */ pathToFileURL(backendRules).href)) as {
      autoCheck: (text: string) => { pass: boolean };
    };
    for (const s of samples) expect(reviewHeld('', s), s).toBe(!backend.autoCheck(`\n${s}`).pass);
    expect(reviewHeld('Call 09123456789', 'fine')).toBe(!backend.autoCheck('Call 09123456789\nfine').pass);
  });
});

describe('privacy check', () => {
  it('finds plates, phones, emails and links with their line', () => {
    const text = 'Reza fixed it.\nMy plate 22 B 345 was visible.\nCall 0912 345 6789 or a@b.co, www.x.com';
    const f = privacyFindings(text);
    expect(f.map((x) => x.kind)).toEqual(['plate', 'phone', 'email', 'link']);
    expect(f[0]).toMatchObject({ line: 2 });
    expect(f[1]!.match).toBe('0912 345 6789');
  });

  it('finds Persian plates and digits', () => {
    const f = privacyFindings('پلاک ۲۲ ب ۳۴۵ ایران ۶۷ بود');
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe('plate');
    expect(privacyFindings('شماره ۰۹۱۲۳۴۵۶۷۸۹')[0]!.kind).toBe('phone');
  });

  it('leaves prices and short numbers alone', () => {
    expect(privacyFindings('It cost 450 dollars and took 2 hours on 12 May.')).toEqual([]);
  });

  it('removes a finding and its extra space', () => {
    const text = 'My plate 22 B 345 was visible.';
    const [f] = privacyFindings(text);
    expect(removeFinding(text, f!)).toBe('My plate was visible.');
    expect(removeFinding('Call 09123456789.', privacyFindings('Call 09123456789.')[0]!)).toBe('Call.');
  });
});

const eligibility = (o: Partial<Eligibility> = {}): Eligibility => ({
  allowed: true,
  path: 'visit_based',
  reason_code: 'ok',
  candidate_visits: [],
  ...o,
});

describe('formMode', () => {
  it('uses the named visit, else the first inside its window', () => {
    const visits = [
      { type: 'appointment' as const, id: ID(1), date: '2026-09-01', within_invitation_window: false },
      { type: 'appointment' as const, id: ID(2), date: '2026-10-28', within_invitation_window: true },
    ];
    expect(formMode(eligibility({ candidate_visits: visits }), null)).toMatchObject({
      kind: 'form',
      path: 'visit_based',
      candidate: { id: ID(2) },
    });
    expect(formMode(eligibility({ candidate_visits: visits }), ID(1))).toMatchObject({
      kind: 'form',
      path: 'approval_based',
      late: true,
      candidate: { id: ID(1) },
    });
    // A named visit that is not a candidate frames nothing: Path 2.
    expect(formMode(eligibility({ candidate_visits: visits }), ID(9))).toMatchObject({ path: 'approval_based', candidate: null });
  });

  it('has no visit → Path 2; blocked reasons stop the form, an invitation passes already_reviewed', () => {
    expect(formMode(eligibility({ path: 'approval_based' }), null)).toMatchObject({
      kind: 'form',
      path: 'approval_based',
      candidate: null,
    });
    expect(formMode(eligibility({ allowed: false, path: null, reason_code: 'velocity_limit' }), null)).toEqual({
      kind: 'blocked',
      reason: 'velocity_limit',
    });
    expect(formMode(eligibility({ allowed: false, path: null, reason_code: 'already_reviewed' }), null, 'approval_based')).toMatchObject({
      kind: 'form',
      path: 'approval_based',
    });
    expect(formMode(eligibility({ allowed: false, path: null, reason_code: 'member_of_subject' }), null, 'visit_based')).toMatchObject({
      kind: 'blocked',
    });
  });
});

describe('bodies', () => {
  const draft = {
    ...EMPTY_DRAFT,
    overall: 5,
    ratings: { work_quality: 5, cleanliness: 0, part_accuracy: 4 },
    wouldReturn: true,
    title: '  ',
    body: '  The clunk was the control arm.  ',
    tags: [ID(7)],
  };

  it('builds ReviewCreate with the visit context, only the subject’s dimensions and no would_return for sellers', () => {
    const body = createBody({
      draft,
      subject: 'provider',
      orgId: ID(3),
      candidate: { type: 'appointment', id: ID(1), date: '2026-10-28', within_invitation_window: true },
      locale: 'en',
      mediaIds: [ID(5)],
    });
    expect(body).toEqual({
      subject_organization_id: ID(3),
      subject_type: 'provider',
      context_appointment_id: ID(1),
      overall_rating: 5,
      would_return: true,
      body: 'The clunk was the control arm.',
      content_locale: 'en',
      sub_ratings: [{ dimension: 'work_quality', rating: 5 }],
      tag_node_ids: [ID(7)],
      media_ids: [ID(5)],
    });
    const vendor = createBody({
      draft,
      subject: 'vendor',
      orgId: ID(3),
      candidate: null,
      grant: 'g'.repeat(40),
      locale: 'fa',
      mediaIds: [],
    });
    expect(vendor).toMatchObject({ invitation_grant: 'g'.repeat(40), sub_ratings: [{ dimension: 'part_accuracy', rating: 4 }] });
    expect(vendor).not.toHaveProperty('would_return');
    expect(vendor).not.toHaveProperty('context_appointment_id');
  });

  it('sends only the changed members of an edit', () => {
    const before = { ...draft, title: '', body: 'The clunk was the control arm.' };
    expect(updateBody(before, { ...before, overall: 4 }, 'provider')).toEqual({ overall_rating: 4 });
    expect(updateBody(before, { ...before, tags: [] }, 'provider')).toEqual({ tag_node_ids: [] });
    expect(updateBody(before, before, 'provider')).toEqual({});
  });

  it('validates the stars, the text length and the title', () => {
    expect(draftProblems(EMPTY_DRAFT)).toEqual(['overall', 'bodyShort']);
    expect(draftProblems({ ...EMPTY_DRAFT, overall: 3, body: 'Ten chars!', title: 'ab' })).toEqual(['title']);
  });

  it('filters tags by applies_to', () => {
    const node = (id: number, applies: string) => ({ id: ID(id), attributes: { applies_to: applies } }) as never;
    expect(tagsFor([node(1, 'both'), node(2, 'vendor'), node(3, 'provider')], 'provider').map((n) => n.id)).toEqual([ID(1), ID(3)]);
  });
});

describe('statuses', () => {
  const r = (o: Partial<Review>) =>
    ({ status: 'published', reviewer_decision: null, business_confirmation_status: null, reviewer_reason_code: null, ...o }) as Review;
  it('maps the server statuses to what the author sees', () => {
    expect(authorStatus(r({ status: 'pending_moderation' }))).toBe('checking');
    expect(authorStatus(r({ status: 'pending_approval', business_confirmation_status: 'pending' }))).toBe('waiting');
    expect(authorStatus(r({ status: 'pending_approval', business_confirmation_status: 'rejected' }))).toBe('evidence');
    expect(authorStatus(r({ status: 'pending_approval', reviewer_decision: 'evidence_requested' }))).toBe('evidence');
    expect(authorStatus(r({ status: 'removed' }))).toBe('withdrawn');
    expect(authorStatus(r({ status: 'removed', reviewer_reason_code: 'spam' }))).toBe('removed');
    expect(canAppeal(r({ status: 'rejected' }))).toBe(true);
    expect(canAppeal(r({ status: 'removed' }))).toBe(false);
    expect(isEditable(r({ status: 'pending_approval' }))).toBe(true);
    expect(isEditable(r({ status: 'published' }))).toBe(false);
    expect(reasonKey('spam')).toBe('shell.report.reason.spam');
    expect(reasonKey('custom_code')).toBeNull();
  });
});

describe('errors', () => {
  it('names the link problems (SEC-LT-4/5)', () => {
    expect(linkProblem(new ApiProblem(410, { code: 'LINK_USED' }))).toBe('used');
    expect(linkProblem(new ApiProblem(410, { code: 'LINK_EXPIRED' }))).toBe('expired');
    expect(linkProblem(new ApiProblem(403, { code: 'LINK_RECIPIENT_MISMATCH' }))).toBe('mismatch');
    expect(linkProblem(new ApiProblem(422, { code: 'CODE_INVALID' }))).toBe('code');
    expect(linkProblem(new Error('x'))).toBe('failed');
  });

  it('explains review submission errors', () => {
    expect(submitOutcome(new ApiProblem(403, { code: 'REVIEW_NOT_ALLOWED', detail: 'velocity_limit' }))).toEqual({
      kind: 'notAllowed',
      key: 'reviews.blocked.velocity_limit',
    });
    expect(submitOutcome(new ApiProblem(409, { code: 'DUPLICATE' })).kind).toBe('duplicate');
    expect(submitOutcome(new ApiProblem(403, { code: 'VERIFIED_CONTACT_REQUIRED' })).kind).toBe('contact');
    expect(submitOutcome(new ApiProblem(410, { code: 'LINK_EXPIRED' })).kind).toBe('grantExpired');
  });
});

describe('urls', () => {
  it('carries ids only and drops malformed ones', () => {
    expect(reviewHref('fa', 'reza-auto', { appointment: ID(1) })).toBe(`/fa/review/reza-auto?appointment=${ID(1)}`);
    expect(reviewHref('en', 'mina parts', { as: 'vendor', invite: true })).toBe('/en/review/mina%20parts?as=vendor&invite=1');
    expect(parseReviewQuery(new URLSearchParams(`as=vendor&inquiry=${ID(2)}&appointment=x&invite=1`))).toEqual({
      as: 'vendor',
      inquiry: ID(2),
      invite: true,
      edit: null,
    });
    expect(parseReviewQuery({ edit: ID(4), as: 'admin' })).toEqual({ as: null, invite: false, edit: ID(4) });
  });

  it('chooses the subject and the invitation link', () => {
    expect(subjectOf(['provider', 'vendor'], 'vendor')).toBe('vendor');
    expect(subjectOf(['vendor'], 'provider')).toBe('vendor');
    expect(subjectOf([], null)).toBeNull();
    expect(
      invitationHref('en', { subject: { slug: 'mina', organization_type: 'vendor' }, visit: { type: 'stock_inquiry', id: ID(3) } }),
    ).toBe(`/en/review/mina?as=vendor&inquiry=${ID(3)}`);
    expect(
      invitationHref('en', { subject: { slug: null, organization_type: 'provider' }, visit: { type: 'appointment', id: ID(3) } }),
    ).toBeNull();
  });
});
