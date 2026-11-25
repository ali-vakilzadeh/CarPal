// AC14-2 DOM tests of the dispute additions (backend S20/S25a): the respondent and a moderation-action snapshot (the
// decider marked staff only), both message threads with a templated message to the respondent (purpose, reason, the
// reply-due day, sent as CarPal), Withdraw on the raiser's request with its resolution, a 202 outcome that waits for an
// administrator and a dispute with pending_change_id; replyDueIso; axe in EN and FA with the threads.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingChange, StaffDisputeDetail, StaffDisputeMessage } from '@carpal/api-contracts';
import { axeViolations, page, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { messageProblem, replyDueIso } from './dispute-parts';
import { DisputesPage } from './disputes-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const D1 = '0193a3c4-5d6e-7f80-9a1b-0000000000d1';
const ACT = '0193a3c4-5d6e-7f80-9a1b-0000000000a9';
const CASE = '0193a3c4-5d6e-7f80-9a1b-0000000000c9';
const PURPOSE = `dispute:${D1}`;
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function detail(o: Partial<StaffDisputeDetail> = {}): StaffDisputeDetail {
  return {
    id: D1,
    created_at: ago(20),
    updated_at: ago(20),
    version: 1,
    target: { type: 'moderation_action', id: ACT },
    dispute_type: 'moderation_appeal',
    reason: 'My post was not spam.',
    status: 'open',
    resolution: null,
    resolved_at: null,
    raised_by_display: 'Ali R.',
    raised_by_organization: null,
    assigned_to_display: null,
    moderator_notes: null,
    pending_change_id: null,
    target_snapshot: {
      type: 'moderation_action',
      id: ACT,
      available: true,
      action_type: 'remove',
      target: { type: 'post', id: 'p1' },
      reason: 'spam: repeated links',
      moderation_case_id: CASE,
      decided_by_display: 'Mina Moderator',
      created_at: ago(40),
    },
    respondent: { party: { type: 'organization', id: 'o1' }, display: 'Pars Auto', contacted: false },
    ...o,
  };
}

const message = (o: Partial<StaffDisputeMessage> = {}): StaffDisputeMessage => ({
  id: 'm1',
  side: 'raiser',
  author: 'staff',
  author_display: 'CarPal',
  template_key: 'request_information',
  body: 'Please tell us more.',
  media: [],
  reply_due_at: ago(-48),
  created_at: ago(5),
  staff_author_display: 'Sara Staff',
  ...o,
});

const pending: PendingChange = {
  change_id: '0193a3c4-5d6e-7f80-9a1b-0000000000ff',
  op_id: 'admin.dispute_resolve',
  summary: 'Uphold fake review dispute',
  requested_by_display: 'Sara Staff',
  requested_at: ago(0),
  reason: 'evidence_supports_claim',
  status: 'pending',
  expires_at: ago(-72),
  decided_by_display: null,
  decided_at: null,
  decision_reason: null,
  job_id: null,
};

function handlers(o: { detail?: () => StaffDisputeDetail; messages?: StaffDisputeMessage[] } = {}) {
  const posted: StaffDisputeMessage[] = [];
  const d = o.detail ?? (() => detail());
  return scriptedTransport({
    'admin.disputes_queue': () => {
      const { target_snapshot: _s, respondent: _r, ...row } = d();
      return page([row]);
    },
    'admin.dispute_get': () => Response.json(d()),
    'admin.dispute_messages_list': () =>
      Response.json({
        items: [
          ...(o.messages ?? [
            message(),
            message({
              id: 'm2',
              author: 'party',
              author_display: 'Ali R.',
              template_key: null,
              staff_author_display: null,
              body: 'It was a real offer.',
              reply_due_at: null,
            }),
          ]),
          ...posted,
        ],
      }),
    'admin.dispute_message_post': (_req, body) => {
      const m = message({
        id: `p${posted.length}`,
        side: body!.side as 'raiser' | 'respondent',
        body: String(body!.body),
        template_key: body!.template_key as StaffDisputeMessage['template_key'],
      });
      posted.push(m);
      return Response.json(m, { status: 201 });
    },
  });
}

beforeEach(() => resetNav(`/disputes?dispute=${D1}&purpose=${encodeURIComponent(PURPOSE)}`));

describe('Dispute additions (AC14-2)', () => {
  it('shows the respondent and the moderation action under appeal, with its decider for staff only', async () => {
    const { transport } = handlers();
    renderConsole(<DisputesPage />, { transport, roles: ['MOD'] });
    expect(await screen.findByTestId('dispute-respondent')).toHaveTextContent('Pars Auto (not written to yet');
    const target = screen.getByTestId('dispute-target');
    expect(target).toHaveTextContent('Remove');
    expect(target).toHaveTextContent('spam: repeated links');
    expect(within(target).getByTestId('snapshot-decider')).toHaveTextContent(
      'Mina Moderator (staff only; never shown to the person appealing)',
    );
  });

  it('both threads; a templated message to the respondent goes out with purpose, reason and a reply-due day', async () => {
    const { transport, calls } = handlers();
    renderConsole(<DisputesPage />, { transport, roles: ['CRV'] });
    const raiser = await screen.findByTestId('thread-raiser');
    expect(await within(raiser).findByText('Please tell us more.')).toBeInTheDocument();
    expect(within(raiser).getByText('It was a real offer.')).toBeInTheDocument();
    expect(raiser).toHaveTextContent('written by Sara Staff');
    const respondent = screen.getByTestId('thread-respondent');
    expect(within(respondent).getByText('No messages yet.')).toBeInTheDocument();
    const composer = within(respondent).getByTestId('composer-respondent');
    fireEvent.click(within(composer).getByRole('button', { name: 'Send the message' }));
    expect(within(composer).getByText('Write the message.')).toBeInTheDocument();
    fireEvent.change(within(composer).getByLabelText('Kind of message'), { target: { value: 'mediation_invitation' } });
    expect((within(composer).getByLabelText('Message') as HTMLTextAreaElement).value).toContain('reach an agreement');
    const day = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    fireEvent.change(within(composer).getByLabelText('Ask for an answer by (optional)'), { target: { value: day } });
    fireEvent.click(within(composer).getByRole('button', { name: 'Send the message' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send to the other party' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'more_information' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send the message' }));
    expect(await within(composer).findByText('Sent. The party is told.')).toBeInTheDocument();
    const post = calls.find((c) => c.opId === 'admin.dispute_message_post')!;
    expect(post.path).toBe(`/v1/admin/disputes/${D1}/messages`);
    expect(post.headers.get('carpal-access-purpose')).toBe(PURPOSE);
    expect(post.body).toEqual({
      side: 'respondent',
      template_key: 'mediation_invitation',
      body: expect.stringContaining('reach an agreement'),
      reply_due_at: `${day}T23:59:59.000Z`,
      reason: 'more_information',
    });
    await waitFor(() => expect(within(screen.getByTestId('thread-respondent')).queryByText('No messages yet.')).toBeNull());
  });

  it('Withdraw needs the resolution and is sent as withdrawn', async () => {
    let status: StaffDisputeDetail['status'] = 'open';
    const { transport, calls } = scriptedTransport({
      'admin.disputes_queue': () => page([{ ...detail({ status }), target_snapshot: undefined, respondent: undefined }]),
      'admin.dispute_get': () => Response.json(detail({ status })),
      'admin.dispute_messages_list': () => Response.json({ items: [] }),
      'admin.dispute_resolve': () => {
        status = 'withdrawn';
        return Response.json({ ...detail({ status: 'withdrawn', resolution: 'Asked by the raiser.' }) });
      },
    });
    renderConsole(<DisputesPage />, { transport, roles: ['MOD'] });
    const form = await screen.findByTestId('dispute-decision');
    fireEvent.click(within(form).getByLabelText('Withdraw (the person who raised it asked)'));
    expect(within(form).getByTestId('outcome-effect')).toHaveTextContent('closes without an outcome');
    fireEvent.click(within(form).getByRole('button', { name: 'Record the decision' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(within(form).getByLabelText(/Outcome message/), { target: { value: 'Asked by the raiser.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record the decision' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'raiser_request' } });
    fireEvent.click(within(dialog).getByLabelText('I understand, and I want to go ahead'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record the decision' }));
    await waitFor(() => expect(calls.some((c) => c.opId === 'admin.dispute_resolve')).toBe(true));
    expect(calls.find((c) => c.opId === 'admin.dispute_resolve')!.body).toEqual({
      status: 'withdrawn',
      resolution: 'Asked by the raiser.',
      reason: 'raiser_request',
    });
  });

  it('an outcome answered 202 waits for an administrator; a dispute with pending_change_id takes no outcome', async () => {
    let waiting = false;
    const { transport } = scriptedTransport({
      'admin.disputes_queue': () =>
        page([
          {
            ...detail({ dispute_type: 'fake_review', pending_change_id: waiting ? pending.change_id : null }),
            target_snapshot: undefined,
            respondent: undefined,
          },
        ]),
      'admin.dispute_get': () =>
        Response.json(detail({ dispute_type: 'fake_review', pending_change_id: waiting ? pending.change_id : null })),
      'admin.dispute_messages_list': () => Response.json({ items: [] }),
      'admin.dispute_resolve': () => {
        waiting = true;
        return Response.json(pending, { status: 202 });
      },
    });
    renderConsole(<DisputesPage />, { transport, roles: ['MOD'] });
    const form = await screen.findByTestId('dispute-decision');
    fireEvent.click(within(form).getByLabelText('Uphold'));
    fireEvent.change(within(form).getByLabelText(/Outcome message/), { target: { value: 'The review is fake.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record the decision' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'evidence_supports_claim' } });
    fireEvent.click(within(dialog).getByLabelText('I understand, and I want to go ahead'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record the decision' }));
    const waitingPanel = await screen.findByTestId('dispute-waiting-approval');
    expect(waitingPanel).toHaveTextContent('Waiting for an administrator');
    expect(within(waitingPanel).getAllByRole('link', { name: 'Open Pending approvals' })[0]).toHaveAttribute('href', '/approvals');
    expect(screen.queryByTestId('composer-raiser')).toBeNull();
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations with the threads (${locale})`, async () => {
      const { transport } = handlers();
      renderConsole(<DisputesPage />, { transport, roles: ['MOD'], locale });
      await screen.findByTestId('composer-respondent');
      await within(screen.getByTestId('thread-raiser')).findAllByTestId('dispute-message');
      expect(await axeViolations()).toEqual([]);
    });
  }
});

describe('dispute message rules (AC14-2)', () => {
  it('a reply-due day is from tomorrow to 30 days ahead; a message is 1-2000 characters', () => {
    const now = Date.parse('2026-11-25T08:00:00Z');
    expect(replyDueIso('2026-11-26', now)).toBe('2026-11-26T23:59:59.000Z');
    expect(replyDueIso('2026-12-24', now)).toBe('2026-12-24T23:59:59.000Z');
    expect(replyDueIso('2026-12-25', now)).toBeNull();
    expect(replyDueIso('2026-11-24', now)).toBeNull();
    expect(replyDueIso('soon', now)).toBeNull();
    expect(messageProblem(' ')).toBe('required');
    expect(messageProblem('x'.repeat(2001))).toBe('too_long');
    expect(messageProblem('ok')).toBeNull();
  });
});
