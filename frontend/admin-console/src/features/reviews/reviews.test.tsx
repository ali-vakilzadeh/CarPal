// AC7.T1–T5 DOM tests of Reviews: the Path 2 queue by stage, the review read for its approval purpose, Confirm /
// Reject / Ask for evidence with a reason (A and R open them; the reason code goes out separately), Confirm blocked
// until the business step is done, the objection banner, a moderator without the reviewer role who cannot decide,
// evidence files through a short-lived link; review cases: the list of review cases, the case read for its purpose,
// remove with a reason, the move to Path 2 filed for a second moderator, closing with a resolution; axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModerationCase, PendingChange, Review, StaffReviewApprovalView } from '@carpal/api-contracts';
import { axeViolations, page, problem, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { nav, resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { ReviewsPage } from './reviews-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const R1 = '0193a3c4-5d6e-7f80-9a1b-0000000000c1';
const R2 = '0193a3c4-5d6e-7f80-9a1b-0000000000c2';
const C1 = '0193a3c4-5d6e-7f80-9a1b-0000000000d1';
const ORG = '0193a3c4-5d6e-7f80-9a1b-0000000000e1';
const MEDIA = '0193a3c4-5d6e-7f80-9a1b-0000000000f1';
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function review(id: string, o: Partial<Review> = {}): Review {
  return {
    id,
    created_at: ago(30),
    updated_at: ago(5),
    version: 2,
    subject_organization_id: ORG,
    subject_type: 'provider',
    overall_rating: 2,
    title: 'Noise came back',
    body: 'They fixed the noise but it came back after a week.',
    content_locale: 'en',
    status: 'pending_approval',
    confirmation_path: 'approval_based',
    verified_status: 'pending_approval',
    business_confirmation_status: 'confirmed',
    reviewer_decision: 'pending',
    reviewer_reason_code: null,
    disputed_by_business: false,
    helpful_count: 0,
    report_status: 'none',
    published_at: null,
    media: [],
    can_add_evidence: true,
    response: null,
    ...o,
  };
}

function view(id: string, o: Partial<Review> = {}, v: Partial<StaffReviewApprovalView> = {}): StaffReviewApprovalView {
  return {
    review: review(id, o),
    author_display_name: 'Sara K.',
    subject: {
      id: ORG,
      name: 'Pars Suspension',
      organization_type: 'provider',
      slug: 'pars',
      logo_url: null,
      status: 'active',
      verification_status: 'verified',
    },
    business_confirmation_source: 'business_answer',
    business_note: 'Yes, last Tuesday',
    business_confirmation_due_at: ago(-100),
    author_history: { account_age_days: 120, published_reviews: 3, rejected_reviews: 0, verified_contact: true },
    evidence: [],
    fraud_signals: [],
    dispute_id: null,
    first_decider_display: null,
    ...v,
  };
}

beforeEach(() => resetNav('/reviews'));
afterEach(() => vi.unstubAllGlobals());

describe('Reviews: awaiting approval (AC7.T1/T2/T5)', () => {
  it('lists the reviewer stage and reads the chosen review for its approval purpose', async () => {
    const { transport, calls } = scriptedTransport({
      'admin.review_approvals_queue': () => page([view(R1), view(R2, { title: undefined, body: 'Fine work on the brakes overall.' })]),
      'admin.review_approval_get': () => Response.json(view(R1)),
    });
    renderConsole(<ReviewsPage />, { transport, roles: ['CRV'] });
    expect(screen.queryByRole('link', { name: 'Review cases' })).toBeNull();
    const table = await screen.findByRole('table', { name: 'Reviews awaiting approval' });
    expect(calls[0]!.search).toBe('?stage=awaiting_reviewer&limit=50');
    fireEvent.click(await within(table).findByRole('button', { name: 'Noise came back' }));
    expect(nav.search).toContain(`review=${R1}`);
    const item = await screen.findByTestId('approval-item');
    expect(within(item).getByTestId('business-answer')).toHaveTextContent('Confirmed by the business');
    expect(within(item).getByText('Yes, last Tuesday')).toBeInTheDocument();
    expect(within(item).getByText('No files attached.')).toBeInTheDocument();
    const get = await waitFor(() => calls.find((c) => c.opId === 'admin.review_approval_get')!);
    expect(get.path).toBe(`/v1/admin/review-approvals/${R1}`);
    expect(get.headers.get('carpal-access-purpose')).toBe(`approval:${R1}`);
    expect(screen.getByTestId('rating-reminder')).toHaveTextContent('A low rating alone is never a reason');
  });

  it('A confirms with a reason; the code goes out as reason_code and the review leaves the queue', async () => {
    resetNav(`/reviews?review=${R1}`);
    let decided = false;
    const { transport, calls } = scriptedTransport({
      'admin.review_approvals_queue': () => page(decided ? [] : [view(R1)]),
      'admin.review_approval_get': () => Response.json(view(R1)),
      'admin.review_approval_decide': () => {
        decided = true;
        return Response.json(view(R1, { status: 'published', verified_status: 'approved_without_visit', reviewer_decision: 'approved' }));
      },
    });
    renderConsole(<ReviewsPage />, { transport, roles: ['CRV'] });
    await screen.findByTestId('approval-item');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled());
    fireEvent.keyDown(document.body, { key: 'a', code: 'KeyA' });
    const dialog = await screen.findByRole('dialog', { name: 'Confirm this review' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'customer_confirmed' } });
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), { target: { value: 'Invoice matches' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByTestId('decision-done')).toHaveTextContent('Approved by the business and CarPal');
    const decide = calls.find((c) => c.opId === 'admin.review_approval_decide')!;
    expect(decide.path).toBe(`/v1/admin/review-approvals/${R1}/decision`);
    expect(decide.headers.get('carpal-access-purpose')).toBe(`approval:${R1}`);
    expect(decide.body).toEqual({ decision: 'approved', reason_code: 'customer_confirmed', reason: 'customer_confirmed: Invoice matches' });
    await waitFor(() => expect(calls.filter((c) => c.opId === 'admin.review_approvals_queue').length).toBeGreaterThan(1));
  });

  it('R rejects only with a note; no reason code names a rating', async () => {
    resetNav(`/reviews?review=${R1}`);
    const { transport, calls } = scriptedTransport({
      'admin.review_approvals_queue': () => page([view(R1)]),
      'admin.review_approval_get': () => Response.json(view(R1)),
      'admin.review_approval_decide': () => Response.json(view(R1, { status: 'rejected', verified_status: 'rejected' })),
    });
    renderConsole(<ReviewsPage />, { transport, roles: ['CRV'] });
    await screen.findByTestId('approval-item');
    fireEvent.keyDown(document.body, { key: 'r', code: 'KeyR' });
    const dialog = await screen.findByRole('dialog', { name: 'Reject this review' });
    const codes = [...within(dialog).getByLabelText('Reason').querySelectorAll('option')].map((o) => o.value);
    expect(codes).toContain('not_a_customer');
    expect(codes.join(' ')).not.toMatch(/rating/);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'not_a_customer' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(within(dialog).getByText('Write a note: it is required for this action.')).toBeInTheDocument();
    expect(calls.some((c) => c.opId === 'admin.review_approval_decide')).toBe(false);
    fireEvent.change(within(dialog).getByLabelText('Note (required)'), { target: { value: 'No visit on record.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByTestId('decision-done')).toHaveTextContent('Rejected. The review is not published');
    expect(calls.find((c) => c.opId === 'admin.review_approval_decide')!.body).toMatchObject({
      decision: 'rejected',
      reason_code: 'not_a_customer',
    });
  });

  it('Confirm waits for the business; ask for evidence works meanwhile', async () => {
    resetNav(`/reviews?review=${R1}&stage=awaiting_business`);
    const pending = view(R1, { business_confirmation_status: 'pending' });
    const { transport, calls } = scriptedTransport({
      'admin.review_approvals_queue': () => page([pending]),
      'admin.review_approval_get': () => Response.json(pending),
      'admin.review_approval_decide': () =>
        Response.json(view(R1, { business_confirmation_status: 'pending', reviewer_decision: 'evidence_requested' })),
    });
    renderConsole(<ReviewsPage />, { transport, roles: ['CRV'] });
    await screen.findByTestId('approval-item');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(screen.getByTestId('confirm-block')).toHaveTextContent('The business has until its deadline');
    fireEvent.keyDown(document.body, { key: 'a', code: 'KeyA' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ask for evidence' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ask the author for evidence' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'invoice_needed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ask for evidence' }));
    expect(await screen.findByTestId('decision-done')).toHaveTextContent('Evidence requested');
    expect(calls.find((c) => c.opId === 'admin.review_approval_decide')!.body).toEqual({
      decision: 'evidence_requested',
      reason_code: 'invoice_needed',
      reason: 'invoice_needed',
    });
  });

  it('a business objection links to its dispute; the server rule is explained if Confirm is refused', async () => {
    const D = '0193a3c4-5d6e-7f80-9a1b-0000000000a9';
    resetNav(`/reviews?review=${R1}`);
    const objected = view(R1, { business_confirmation_status: 'rejected' }, { dispute_id: D, first_decider_display: 'Reza R.' });
    const { transport } = scriptedTransport({
      'admin.review_approvals_queue': () => page([objected]),
      'admin.review_approval_get': () => Response.json(objected),
    });
    renderConsole(<ReviewsPage />, { transport, roles: ['CRV'] });
    await screen.findByTestId('approval-item');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Open the objection dispute' })).toHaveAttribute(
      'href',
      `/disputes?dispute=${D}&purpose=dispute%3A${D}`,
    );
    expect(screen.getByTestId('first-decider')).toHaveTextContent('Reza R.');
  });

  it('a moderator without the reviewer role reads the queue but cannot decide', async () => {
    resetNav(`/reviews?review=${R1}`);
    const { transport } = scriptedTransport({
      'admin.review_approvals_queue': () => page([view(R1)]),
      'admin.review_approval_get': () => Response.json(view(R1)),
      'admin.cases_list': () => page([]),
    });
    renderConsole(<ReviewsPage />, { transport, roles: ['MOD'] });
    await screen.findByTestId('approval-item');
    expect(screen.getByTestId('cannot-decide')).toHaveTextContent('Only community reviewers decide');
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Review cases' })).toBeInTheDocument();
  });

  it('opens an evidence file through a short-lived link for the same purpose', async () => {
    resetNav(`/reviews?review=${R1}`);
    const withFile = view(
      R1,
      {},
      {
        evidence: [
          {
            attachment_id: 'att-1',
            media_asset_id: MEDIA,
            media_type: 'image',
            role: 'evidence',
            pair_group_key: null,
            display_order: 0,
            caption: 'Invoice',
            url: null,
            thumbnail_url: null,
            width: null,
            height: null,
          },
        ],
      },
    );
    const { transport, calls } = scriptedTransport({
      'admin.review_approvals_queue': () => page([withFile]),
      'admin.review_approval_get': () => Response.json(withFile),
      'admin.media_download_url': () => Response.json({ url: 'https://storage.example/x?sig=1', expires_at: ago(-0.1) }),
    });
    renderConsole(<ReviewsPage />, { transport, roles: ['CRV'] });
    const evidence = await screen.findByTestId('evidence');
    fireEvent.click(within(evidence).getByRole('button', { name: 'Get a link' }));
    expect(await within(evidence).findByRole('link', { name: 'Open the file' })).toHaveAttribute('href', 'https://storage.example/x?sig=1');
    const call = calls.find((c) => c.opId === 'admin.media_download_url')!;
    expect(call.path).toBe(`/v1/admin/media/${MEDIA}/download-url`);
    expect(call.body).toEqual({ variant: 'display' });
    expect(call.headers.get('carpal-access-purpose')).toBe(`approval:${R1}`);
  });

  it('a decided review is explained when it can no longer be read', async () => {
    resetNav(`/reviews?review=${R1}`);
    const { transport } = scriptedTransport({
      'admin.review_approvals_queue': () => page([]),
      'admin.review_approval_get': () => problem(404, 'NOT_FOUND'),
    });
    renderConsole(<ReviewsPage />, { transport, roles: ['CRV'] });
    expect(await screen.findByTestId('approval-unavailable')).toHaveTextContent('no longer waiting for approval');
  });
});

function modCase(o: Partial<ModerationCase> = {}): ModerationCase {
  return {
    id: C1,
    created_at: ago(3),
    updated_at: ago(3),
    version: 1,
    case_type: 'review',
    target: { type: 'review', id: R2 },
    source: 'user_report',
    reason: 'abusive',
    severity: 'medium',
    ai_risk_score: 71,
    ai_flag_insight_id: null,
    status: 'open',
    assigned_to_display: null,
    resolution: null,
    resolved_at: null,
    report_count: 2,
    ...o,
  };
}

const snapshot = (o: Record<string, unknown> = {}) => ({
  type: 'review',
  id: R2,
  subject_organization_id: ORG,
  subject_type: 'provider',
  overall_rating: 1,
  title: null,
  body: 'Worst shop, the owner is a crook.',
  status: 'published',
  confirmation_path: 'visit_based',
  verified_status: 'appointment_verified',
  created_at: ago(40),
  ...o,
});

describe('Reviews: review cases (AC7.T1/T3)', () => {
  it('lists review cases and reads the case for its purpose', async () => {
    resetNav('/reviews?tab=cases');
    const { transport, calls } = scriptedTransport({
      'admin.cases_list': () => page([modCase(), modCase({ id: R1, reason: 'brand_new_reason' as ModerationCase['reason'] })]),
      'admin.case_get': () => Response.json({ case: modCase(), actions: [], target_snapshot: snapshot() }),
    });
    renderConsole(<ReviewsPage />, { transport, roles: ['MOD'] });
    const table = await screen.findByRole('table', { name: 'Review cases' });
    expect(calls[0]!.search).toBe('?case_type=review&status=open&limit=50');
    expect(await within(table).findByRole('button', { name: 'Unknown (brand_new_reason)' })).toBeInTheDocument();
    fireEvent.click(within(table).getByRole('button', { name: 'Abusive' }));
    const item = await screen.findByTestId('case-item');
    expect(await within(item).findByText('Worst shop, the owner is a crook.')).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.case_get')!.headers.get('carpal-access-purpose')).toBe(`case:${C1}`);
    expect(within(item).getByText('AI')).toBeInTheDocument();
  });

  it('removes the review with a reason and note (case action for the purpose)', async () => {
    resetNav(`/reviews?tab=cases&case=${C1}`);
    const { transport, calls } = scriptedTransport({
      'admin.cases_list': () => page([modCase()]),
      'admin.case_get': () => Response.json({ case: modCase(), actions: [], target_snapshot: snapshot() }),
      'admin.case_action': () =>
        Response.json(
          {
            id: 'act-1',
            moderation_case_id: C1,
            action_type: 'remove',
            target: { type: 'review', id: R2 },
            reason: 'policy_violation: insult',
            actor_display: 'Mo D.',
            created_at: ago(0),
          },
          { status: 201 },
        ),
    });
    renderConsole(<ReviewsPage />, { transport, roles: ['MOD'] });
    const actions = await screen.findByTestId('case-actions');
    expect(within(actions).queryByRole('button', { name: 'Restore' })).toBeNull();
    fireEvent.click(within(actions).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove this review' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'policy_violation' } });
    fireEvent.change(within(dialog).getByLabelText('Note (required)'), { target: { value: 'insult' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(/Removed. The review is hidden from everyone/)).toBeInTheDocument();
    const call = calls.find((c) => c.opId === 'admin.case_action')!;
    expect(call.path).toBe(`/v1/admin/moderation/cases/${C1}/actions`);
    expect(call.headers.get('carpal-access-purpose')).toBe(`case:${C1}`);
    expect(call.body).toEqual({ action_type: 'remove', reason: 'policy_violation: insult' });
  });

  it('files the move to Path 2 for a second moderator', async () => {
    resetNav(`/reviews?tab=cases&case=${C1}`);
    const change: PendingChange = {
      change_id: '0193a3c4-5d6e-7f80-9a1b-0000000000bb',
      op_id: 'admin.review_move_to_approval_path',
      summary: `Move review ${R2} (appointment_verified) to the approval path`,
      requested_by_display: 'Mo D.',
      requested_at: ago(0),
      reason: 'visit_evidence_invalid: shop confirmed no visit',
      status: 'pending',
      expires_at: ago(-72),
      decided_by_display: null,
      decided_at: null,
      decision_reason: null,
      job_id: null,
    };
    const { transport, calls } = scriptedTransport({
      'admin.cases_list': () => page([modCase()]),
      'admin.case_get': () => Response.json({ case: modCase(), actions: [], target_snapshot: snapshot() }),
      'admin.review_move_to_approval_path': () => Response.json(change, { status: 202 }),
    });
    renderConsole(<ReviewsPage />, { transport, roles: ['MOD'] });
    fireEvent.click(await screen.findByRole('button', { name: 'Move to the approval path' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move this review to the approval path' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'visit_evidence_invalid' } });
    fireEvent.change(within(dialog).getByLabelText('Note (required)'), { target: { value: 'shop confirmed no visit' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to the approval path' }));
    expect(await screen.findByText('Waiting for a second staff member')).toBeInTheDocument();
    const call = calls.find((c) => c.opId === 'admin.review_move_to_approval_path')!;
    expect(call.path).toBe(`/v1/admin/reviews/${R2}/move-to-approval-path`);
    expect(call.body).toEqual({ reason: 'visit_evidence_invalid: shop confirmed no visit' });
  });

  it('closes the case only with a resolution', async () => {
    resetNav(`/reviews?tab=cases&case=${C1}`);
    const { transport, calls } = scriptedTransport({
      'admin.cases_list': () => page([modCase()]),
      'admin.case_get': () => Response.json({ case: modCase(), actions: [], target_snapshot: snapshot() }),
      'admin.case_close': () => Response.json(modCase({ status: 'dismissed', resolution: 'Fair criticism' })),
    });
    renderConsole(<ReviewsPage />, { transport, roles: ['MOD'] });
    const close = await screen.findByRole('button', { name: 'Close the case' });
    fireEvent.click(close);
    expect(screen.getByText('Write the resolution.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: 'Fair criticism' } });
    fireEvent.click(close);
    const dialog = await screen.findByRole('dialog', { name: 'Close this case' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'no_violation' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close the case' }));
    expect(await screen.findByText('This case is closed: Dismissed.')).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.case_close')!.body).toEqual({
      status: 'dismissed',
      resolution: 'Fair criticism',
      reason: 'no_violation',
    });
  });

  it('a case handled by someone else says so', async () => {
    resetNav(`/reviews?tab=cases&case=${C1}`);
    const { transport } = scriptedTransport({
      'admin.cases_list': () => page([modCase({ assigned_to_display: 'Nima M.', status: 'investigating' })]),
      'admin.case_get': () => problem(404, 'NOT_FOUND'),
    });
    renderConsole(<ReviewsPage />, { transport, roles: ['MOD'] });
    expect(await screen.findByTestId('case-unavailable')).toHaveTextContent('Being handled by Nima M.');
  });
});

describe('Reviews axe (AC7)', () => {
  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`approval item: no violations (${locale})`, async () => {
      resetNav(`/reviews?review=${R1}`);
      const { transport } = scriptedTransport({
        'admin.review_approvals_queue': () => page([view(R1)]),
        'admin.review_approval_get': () => Response.json(view(R1)),
      });
      renderConsole(<ReviewsPage />, { transport, roles: ['CRV', 'MOD'], locale });
      await screen.findByTestId('approval-item');
      expect(await axeViolations()).toEqual([]);
    });

    it(`review case: no violations (${locale})`, async () => {
      resetNav(`/reviews?tab=cases&case=${C1}`);
      const { transport } = scriptedTransport({
        'admin.cases_list': () => page([modCase()]),
        'admin.case_get': () => Response.json({ case: modCase(), actions: [], target_snapshot: snapshot() }),
      });
      renderConsole(<ReviewsPage />, { transport, roles: ['MOD'], locale });
      await screen.findByTestId('case-actions');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
