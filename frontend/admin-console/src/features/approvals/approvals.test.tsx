// AC5.T4/T8 DOM tests of Pending approvals: the list (status filter in the URL), the change and the decision; approve
// and reject need a reason (A/R open them); the decision is sent with the reason; SELF_APPROVAL_FORBIDDEN and an
// expired change are explained; a step-up saves the decision and the replay sends it once; staff who cannot decide
// see no buttons; "your requests" lists changes filed in this tab; axe in EN and FA.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingChange } from '@carpal/api-contracts';
import { axeViolations, page, problem, renderConsole, scriptedTransport, staffView } from '../../../tests/support/console-harness';
import { nav, resetNav } from '../../../tests/support/navigation-mock';
import { MY_CHANGES_KEY } from '@/components/admin';
import type { Locale } from '@/lib/i18n/locales';
import { ApprovalsPage } from './approvals-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const A = '0193a3c4-5d6e-7f80-9a1b-000000000001';
const B = '0193a3c4-5d6e-7f80-9a1b-000000000002';
const soon = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function change(id: string, o: Partial<PendingChange> = {}): PendingChange {
  return {
    change_id: id,
    op_id: 'admin.retention_update',
    summary: `Retention policy ${id.slice(-1)}: 30 d → 60 d`,
    requested_by_display: 'Ali Admin',
    requested_at: ago(2),
    reason: 'planned_change: yearly review',
    status: 'pending',
    expires_at: soon(70),
    ...o,
  };
}

beforeEach(() => resetNav('/approvals'));
afterEach(() => vi.unstubAllGlobals());

describe('Pending approvals (AC5.T4)', () => {
  it('lists pending changes and shows the selected one with the requester’s reason', async () => {
    const { transport, calls } = scriptedTransport({
      'admin.four_eyes_list': () => page([change(A), change(B, { op_id: 'admin.some_future_op' })]),
    });
    renderConsole(<ApprovalsPage />, { transport, roles: ['ADM'] });
    const table = await screen.findByRole('table', { name: 'Changes' });
    expect(await within(table).findByRole('button', { name: 'Data retention change' })).toBeInTheDocument();
    expect(calls[0]!.search).toBe('?status=pending&limit=50');
    expect(within(table).getByRole('button', { name: 'Unknown (admin.some_future_op)' })).toBeInTheDocument();
    expect(screen.getByTestId('approvals-own-hint')).toHaveTextContent('Changes you requested yourself never appear here');
    fireEvent.click(within(table).getByRole('button', { name: 'Data retention change' }));
    expect(nav.search).toBe(`change=${A}`);
    const detail = await screen.findByTestId('approval-detail');
    expect(within(detail).getByText('Planned change')).toBeInTheDocument();
    expect(within(detail).getByText('yearly review')).toBeInTheDocument();
  });

  it('approve needs a reason; the decision goes out with it and the list is read again', async () => {
    resetNav(`/approvals?change=${A}`);
    let decided = false;
    const { transport, calls } = scriptedTransport({
      'admin.four_eyes_list': () => page(decided ? [] : [change(A)]),
      'admin.four_eyes_decide': () => {
        decided = true;
        return Response.json(change(A, { status: 'approved' }));
      },
    });
    renderConsole(<ApprovalsPage />, { transport, roles: ['ADM'] });
    await screen.findByTestId('approval-detail');
    fireEvent.keyDown(document.body, { key: 'a', code: 'KeyA' });
    const dialog = await screen.findByRole('dialog', { name: 'Approve this change' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(within(dialog).getByText('Choose a reason.')).toBeInTheDocument();
    expect(calls.some((c) => c.opId === 'admin.four_eyes_decide')).toBe(false);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'checked_and_correct' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved. The change is applied.')).toBeInTheDocument();
    const decide = calls.find((c) => c.opId === 'admin.four_eyes_decide')!;
    expect(decide.path).toBe(`/v1/admin/four-eyes/${A}/decision`);
    expect(decide.body).toEqual({ decision: 'approve', reason: 'checked_and_correct' });
    await waitFor(() => expect(calls.filter((c) => c.opId === 'admin.four_eyes_list').length).toBeGreaterThan(1));
    await waitFor(() => expect(nav.search).not.toContain('change='));
  });

  it('reject needs a note (R opens it)', async () => {
    resetNav(`/approvals?change=${A}`);
    const { transport, calls } = scriptedTransport({
      'admin.four_eyes_list': () => page([change(A)]),
      'admin.four_eyes_decide': () => Response.json(change(A, { status: 'rejected' })),
    });
    renderConsole(<ApprovalsPage />, { transport, roles: ['ADM'] });
    await screen.findByTestId('approval-detail');
    fireEvent.keyDown(document.body, { key: 'r', code: 'KeyR' });
    const dialog = await screen.findByRole('dialog', { name: 'Reject this change' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'not_justified' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(within(dialog).getByText('Write a note: it is required for this action.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Note (required)'), { target: { value: 'No ticket for this.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Rejected. The change will not be applied.')).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.four_eyes_decide')!.body).toEqual({
      decision: 'reject',
      reason: 'not_justified: No ticket for this.',
    });
  });

  it('explains SELF_APPROVAL_FORBIDDEN and an expired change', async () => {
    resetNav(`/approvals?change=${A}`);
    let answer = problem(403, 'SELF_APPROVAL_FORBIDDEN');
    const { transport } = scriptedTransport({
      'admin.four_eyes_list': () => page([change(A)]),
      'admin.four_eyes_decide': () => answer.clone(),
    });
    renderConsole(<ApprovalsPage />, { transport, roles: ['ADM'] });
    await screen.findByTestId('approval-detail');
    const decide = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
      const dialog = await screen.findByRole('dialog', { name: 'Approve this change' });
      fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'checked_and_correct' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    };
    await decide();
    expect(await screen.findByText('Someone else must decide this')).toBeInTheDocument();
    expect(screen.getByText(/You requested this change yourself/)).toBeInTheDocument();
    answer = problem(409, 'INVALID_TRANSITION');
    await decide();
    expect(await screen.findByText(/it expired or someone already decided it/)).toBeInTheDocument();
  });

  it('a step-up saves the decision; back from the security key the replay sends it once', async () => {
    resetNav(`/approvals?change=${A}`);
    const sends: unknown[] = [];
    const { transport } = scriptedTransport({
      'admin.four_eyes_list': () => page([change(A)]),
      'admin.four_eyes_decide': (_req, body) => {
        sends.push(body);
        return Response.json(change(A, { status: 'approved' }));
      },
    });
    // jsdom's page is http://localhost/: the saved action returns to this page (same path).
    const intent = { id: 'i-9', type: 'act.admin.four_eyes_decide', target: null, return_to: `/?change=${A}` };
    const session = staffView(['ADM'], { intents: [intent] });
    const consumed: string[] = [];
    renderConsole(<ApprovalsPage />, {
      transport,
      session,
      consume: (id) => {
        consumed.push(id);
        return consumed.length === 1
          ? {
              ...intent,
              draft: {
                args: { path: { change_id: A }, body: { decision: 'approve', reason: 'incident_response' }, reason: 'incident_response' },
              },
            }
          : null;
      },
    });
    expect(await screen.findByText('Your decision is recorded.')).toBeInTheDocument();
    expect(sends).toEqual([{ decision: 'approve', reason: 'incident_response' }]);
    expect(consumed).toEqual(['i-9']);
  });

  it('a moderator without the change in the list, and staff who cannot decide, see no buttons', async () => {
    resetNav(`/approvals?change=${B}`);
    const { transport } = scriptedTransport({ 'admin.four_eyes_list': () => page([change(A)]) });
    renderConsole(<ApprovalsPage />, { transport, roles: ['MOD'] });
    expect(await screen.findByTestId('approval-not-listed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('decided changes show their status and no buttons; the status filter is in the URL', async () => {
    resetNav(`/approvals?status=approved&change=${A}`);
    const { transport, calls } = scriptedTransport({ 'admin.four_eyes_list': () => page([change(A, { status: 'approved' })]) });
    renderConsole(<ApprovalsPage />, { transport, roles: ['ADM'] });
    expect(await screen.findByText('Already decided: Approved.')).toBeInTheDocument();
    expect(calls[0]!.search).toBe('?status=approved&limit=50');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('lists the changes this staff member requested in this tab as waiting for someone else', async () => {
    const { transport } = scriptedTransport({ 'admin.four_eyes_list': () => page([]) });
    const { queryClient } = renderConsole(<ApprovalsPage />, { transport, roles: ['ADM'] });
    expect(await screen.findByText('Nothing waits for your approval.')).toBeInTheDocument();
    expect(screen.getByTestId('my-requests')).toHaveTextContent('You have not requested a change in this tab.');
    act(() => queryClient.setQueryData(MY_CHANGES_KEY, [change(B, { requested_by_display: 'Sara Staff' })]));
    const mine = screen.getByTestId('my-requests');
    expect(await within(mine).findByText('Waiting for a second staff member')).toBeInTheDocument();
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      resetNav(`/approvals?change=${A}`);
      const { transport } = scriptedTransport({ 'admin.four_eyes_list': () => page([change(A), change(B)]) });
      renderConsole(<ApprovalsPage />, { transport, roles: ['ADM'], locale });
      await screen.findByTestId('approval-detail');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
