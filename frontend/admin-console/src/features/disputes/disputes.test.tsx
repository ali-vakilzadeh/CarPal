// AC7.T4 DOM tests of Disputes & appeals: the queue with status / type / assignment filters from the URL, the dispute
// read for its purpose with the disputed review and both sides' evidence, the outcome explained before the decision
// (an objection reads as what it does), an outcome message required to resolve, the irreversible tick, the decision
// sent with reason and notes, mediation, the different-staff rule explained from SELF_APPROVAL_FORBIDDEN, a decided
// dispute shown from the list; axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Review, StaffDispute, StaffReviewApprovalView } from '@carpal/api-contracts';
import { axeViolations, page, problem, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { nav, resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { DisputesPage } from './disputes-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const D1 = '0193a3c4-5d6e-7f80-9a1b-0000000000d1';
const D2 = '0193a3c4-5d6e-7f80-9a1b-0000000000d2';
const REV = '0193a3c4-5d6e-7f80-9a1b-0000000000c1';
const ORG = '0193a3c4-5d6e-7f80-9a1b-0000000000e1';
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const org = {
  id: ORG,
  name: 'Pars Suspension',
  organization_type: 'provider' as const,
  slug: 'pars',
  logo_url: null,
  status: 'active' as const,
  verification_status: 'verified' as const,
};

function dispute(id: string, o: Partial<StaffDispute> = {}): StaffDispute {
  return {
    id,
    created_at: ago(20),
    updated_at: ago(20),
    version: 1,
    target: { type: 'review', id: REV },
    dispute_type: 'review_approval_objection',
    reason: 'We have no record of this customer.',
    status: 'open',
    resolution: null,
    resolved_at: null,
    raised_by_display: 'Reza Owner',
    raised_by_organization: org,
    assigned_to_display: null,
    moderator_notes: null,
    ...o,
  };
}

function reviewView(): StaffReviewApprovalView {
  const review = {
    id: REV,
    created_at: ago(200),
    updated_at: ago(20),
    version: 3,
    subject_organization_id: ORG,
    subject_type: 'provider',
    overall_rating: 2,
    body: 'They fixed the noise but it came back after a week.',
    content_locale: 'en',
    status: 'pending_approval',
    confirmation_path: 'approval_based',
    verified_status: 'pending_approval',
    business_confirmation_status: 'rejected',
    reviewer_decision: 'pending',
    reviewer_reason_code: null,
    disputed_by_business: false,
    helpful_count: 0,
    report_status: 'reported',
    published_at: null,
    media: [],
    can_add_evidence: true,
    response: null,
  } as Review;
  return {
    review,
    author_display_name: 'Sara K.',
    subject: org,
    business_confirmation_source: 'business_answer',
    business_note: 'Not our customer',
    business_confirmation_due_at: ago(-50),
    author_history: { account_age_days: 300, published_reviews: 5, rejected_reviews: 0, verified_contact: true },
    evidence: [],
    fraud_signals: [],
    dispute_id: D1,
    first_decider_display: 'Cyrus Reviewer',
  };
}

beforeEach(() => resetNav('/disputes'));
afterEach(() => vi.unstubAllGlobals());

describe('Disputes & appeals (AC7.T4)', () => {
  it('lists open disputes with the filters of the URL and reads one with the disputed review', async () => {
    resetNav('/disputes?type=review_approval_objection&assigned=unassigned');
    const { transport, calls } = scriptedTransport({
      'admin.disputes_queue': () => page([dispute(D1), dispute(D2, { dispute_type: 'some_new_type' as StaffDispute['dispute_type'] })]),
      'admin.dispute_get': () => Response.json(dispute(D1)),
      'admin.review_approval_get': () => Response.json(reviewView()),
    });
    renderConsole(<DisputesPage />, { transport, roles: ['MOD'] });
    const table = await screen.findByRole('table', { name: 'Disputes' });
    expect(calls[0]!.search).toBe('?status=open&dispute_type=review_approval_objection&assigned_to_me=false&limit=50');
    expect(await within(table).findByRole('button', { name: 'Unknown (some_new_type)' })).toBeInTheDocument();
    fireEvent.click(within(table).getByRole('button', { name: 'Business objection to a review' }));
    expect(nav.search).toContain(`dispute=${D1}`);
    const item = await screen.findByTestId('dispute-item');
    expect(within(item).getByText('We have no record of this customer.')).toBeInTheDocument();
    const reviewBlock = await within(item).findByTestId('disputed-review');
    expect(within(reviewBlock).getByText('Not our customer')).toBeInTheDocument();
    expect(within(reviewBlock).getByTestId('first-decider')).toHaveTextContent('Cyrus Reviewer');
    await waitFor(() => expect(calls.find((c) => c.opId === 'admin.review_approval_get')).toBeTruthy());
    expect(calls.find((c) => c.opId === 'admin.dispute_get')!.headers.get('carpal-access-purpose')).toBe(`dispute:${D1}`);
    expect(calls.find((c) => c.opId === 'admin.review_approval_get')!.headers.get('carpal-access-purpose')).toBe(`dispute:${D1}`);
    expect(screen.getByTestId('different-staff-rule')).toHaveTextContent('you cannot decide a dispute you raised');
  });

  it('explains each outcome, needs an outcome message to resolve, and sends reason and notes', async () => {
    resetNav(`/disputes?dispute=${D1}`);
    let resolved = false;
    const { transport, calls } = scriptedTransport({
      'admin.disputes_queue': () => page(resolved ? [] : [dispute(D1)]),
      'admin.dispute_get': () => Response.json(dispute(D1)),
      'admin.review_approval_get': () => Response.json(reviewView()),
      'admin.dispute_resolve': () => {
        resolved = true;
        return Response.json(
          dispute(D1, {
            status: 'resolved_upheld',
            resolution: 'The author showed an invoice.',
            resolved_at: ago(0),
            moderator_notes: 'Invoice #77',
          }),
        );
      },
    });
    renderConsole(<DisputesPage />, { transport, roles: ['CRV'] });
    const form = await screen.findByTestId('dispute-decision');
    fireEvent.click(within(form).getByRole('button', { name: 'Record the decision' }));
    expect(within(form).getByText('Choose an outcome.')).toBeInTheDocument();
    fireEvent.click(within(form).getByLabelText('Publish the review (the objection is not accepted)'));
    expect(within(form).getByTestId('outcome-effect')).toHaveTextContent('published with the label “Disputed by the business”');
    fireEvent.click(within(form).getByRole('button', { name: 'Record the decision' }));
    expect(within(form).getByText(/Write the outcome message/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(within(form).getByLabelText('Outcome message (required)'), { target: { value: 'The author showed an invoice.' } });
    fireEvent.change(within(form).getByLabelText('Internal notes'), { target: { value: 'Invoice #77' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record the decision' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish the review (the objection is not accepted)' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'evidence_supports_claim' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record the decision' }));
    expect(within(dialog).getByText(/Tick the box|tick/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record the decision' }));
    expect(await screen.findByText('Upheld. The outcome is applied and both sides are told.')).toBeInTheDocument();
    expect(screen.getByTestId('dispute-closed')).toHaveTextContent('This dispute is closed: Upheld.');
    expect(screen.getByTestId('dispute-resolution')).toHaveTextContent('The author showed an invoice.');
    const call = calls.find((c) => c.opId === 'admin.dispute_resolve')!;
    expect(call.path).toBe(`/v1/admin/disputes/${D1}/resolution`);
    expect(call.headers.get('carpal-access-purpose')).toBe(`dispute:${D1}`);
    expect(call.body).toEqual({
      status: 'resolved_upheld',
      resolution: 'The author showed an invoice.',
      moderator_notes: 'Invoice #77',
      reason: 'evidence_supports_claim',
    });
  });

  it('explains the different-staff rule when the server refuses the decider', async () => {
    resetNav(`/disputes?dispute=${D1}`);
    const { transport } = scriptedTransport({
      'admin.disputes_queue': () => page([dispute(D1)]),
      'admin.dispute_get': () => Response.json(dispute(D1)),
      'admin.review_approval_get': () => Response.json(reviewView()),
      'admin.dispute_resolve': () => problem(403, 'SELF_APPROVAL_FORBIDDEN'),
    });
    renderConsole(<DisputesPage />, { transport, roles: ['CRV'] });
    const form = await screen.findByTestId('dispute-decision');
    fireEvent.click(within(form).getByLabelText('Start mediation'));
    fireEvent.click(within(form).getByRole('button', { name: 'Record the decision' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start mediation' });
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'both_sides_needed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record the decision' }));
    const refused = await screen.findByTestId('different-staff-refused');
    expect(refused).toHaveTextContent('A colleague must decide this');
    expect(refused).toHaveTextContent('You raised this dispute or made the decision under dispute');
  });

  it('starts mediation without an outcome message; then only uphold and reject remain', async () => {
    resetNav(`/disputes?dispute=${D1}`);
    let status: StaffDispute['status'] = 'open';
    const { transport, calls } = scriptedTransport({
      'admin.disputes_queue': () => page([dispute(D1, { status })]),
      'admin.dispute_get': () => Response.json(dispute(D1, { status })),
      'admin.review_approval_get': () => Response.json(reviewView()),
      'admin.dispute_resolve': () => {
        status = 'in_mediation';
        return Response.json(dispute(D1, { status }));
      },
    });
    renderConsole(<DisputesPage />, { transport, roles: ['MOD'] });
    const form = await screen.findByTestId('dispute-decision');
    fireEvent.click(within(form).getByLabelText('Start mediation'));
    fireEvent.click(within(form).getByRole('button', { name: 'Record the decision' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start mediation' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'both_sides_needed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record the decision' }));
    expect(await screen.findByText('Mediation started. Both sides are invited to add information.')).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.dispute_resolve')!.body).toEqual({ status: 'in_mediation', reason: 'both_sides_needed' });
  });

  it('a decided dispute is shown from the list without a purpose read', async () => {
    resetNav(`/disputes?status=resolved_rejected&dispute=${D2}`);
    const { transport, calls } = scriptedTransport({
      'admin.disputes_queue': () =>
        page([
          dispute(D2, {
            dispute_type: 'fake_review',
            status: 'resolved_rejected',
            resolution: 'The review is genuine.',
            resolved_at: ago(2),
          }),
        ]),
    });
    renderConsole(<DisputesPage />, { transport, roles: ['MOD'] });
    expect(await screen.findByTestId('dispute-closed')).toHaveTextContent('This dispute is closed: Rejected.');
    expect(screen.getByTestId('dispute-resolution')).toHaveTextContent('The review is genuine.');
    expect(calls.some((c) => c.opId === 'admin.dispute_get')).toBe(false);
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      resetNav(`/disputes?dispute=${D1}`);
      const { transport } = scriptedTransport({
        'admin.disputes_queue': () => page([dispute(D1)]),
        'admin.dispute_get': () => Response.json(dispute(D1)),
        'admin.review_approval_get': () => Response.json(reviewView()),
      });
      renderConsole(<DisputesPage />, { transport, roles: ['MOD'], locale });
      await screen.findByTestId('disputed-review');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
