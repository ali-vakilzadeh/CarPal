// AC5.T4/T8 DOM tests of Pending approvals: the list (status filter in the URL), the change and the decision; approve
// and reject need a reason (A/R open them); the decision is sent with the reason; SELF_APPROVAL_FORBIDDEN and an
// expired change are explained; a step-up saves the decision and the replay sends it once; staff who cannot decide
// see no buttons; "your requests" lists your own changes with their outcome (BR-21); axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingChange } from '@carpal/api-contracts';
import { axeViolations, page, problem, renderConsole, scriptedTransport, staffView } from '../../../tests/support/console-harness';
import { nav, resetNav } from '../../../tests/support/navigation-mock';
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
    decided_by_display: null,
    decided_at: null,
    decision_reason: null,
    job_id: null,
    ...o,
  };
}

beforeEach(() => resetNav('/approvals'));
afterEach(() => vi.unstubAllGlobals());

describe('Pending approvals (AC5.T4)', () => {
  it('lists pending changes and shows the selected one with the requester’s reason', async () => {
    const { transport, calls } = scriptedTransport({
      'admin.four_eyes_list': (req) =>
        req.search.includes('mine=true') ? page([]) : page([change(A), change(B, { op_id: 'admin.some_future_op' })]),
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
      'admin.four_eyes_list': (req) => (req.search.includes('mine=true') ? page([]) : page(decided ? [] : [change(A)])),
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

  it('an approved merge shows its background job until it ends (AC12.T3)', async () => {
    resetNav(`/approvals?change=${A}`);
    const JOB = '0193a3c4-5d6e-7f80-9a1b-000000000099';
    let reads = 0;
    const { transport } = scriptedTransport({
      'admin.four_eyes_list': (req) => (req.search.includes('mine=true') ? page([]) : page([change(A, { op_id: 'admin.taxonomy_merge' })])),
      'admin.four_eyes_decide': () => Response.json(change(A, { op_id: 'admin.taxonomy_merge', status: 'approved', job_id: JOB })),
      'admin.job_get': () => {
        reads += 1;
        const done = reads > 1;
        const now = new Date().toISOString();
        return Response.json({
          id: JOB,
          kind: 'taxonomy_merge',
          status: done ? 'succeeded' : 'running',
          progress: done ? 100 : 30,
          expires_at: now,
          created_at: now,
          updated_at: now,
        });
      },
    });
    renderConsole(<ApprovalsPage />, { transport, roles: ['ADM'] });
    await screen.findByTestId('approval-detail');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve this change' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'checked_and_correct' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    const job = await screen.findByText('The background job is running (30 %).');
    expect(job).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('The background job finished.')).toBeInTheDocument(), { timeout: 8000 });
  }, 15000);

  it('reject needs a note (R opens it)', async () => {
    resetNav(`/approvals?change=${A}`);
    const { transport, calls } = scriptedTransport({
      'admin.four_eyes_list': (req) => (req.search.includes('mine=true') ? page([]) : page([change(A)])),
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
      'admin.four_eyes_list': (req) => (req.search.includes('mine=true') ? page([]) : page([change(A)])),
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
      'admin.four_eyes_list': (req) => (req.search.includes('mine=true') ? page([]) : page([change(A)])),
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
    const { transport } = scriptedTransport({
      'admin.four_eyes_list': (req) => (req.search.includes('mine=true') ? page([]) : page([change(A)])),
    });
    renderConsole(<ApprovalsPage />, { transport, roles: ['MOD'] });
    expect(await screen.findByTestId('approval-not-listed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('decided changes show their status and no buttons; the status filter is in the URL', async () => {
    resetNav(`/approvals?status=approved&change=${A}`);
    const { transport, calls } = scriptedTransport({
      'admin.four_eyes_list': (req) => (req.search.includes('mine=true') ? page([]) : page([change(A, { status: 'approved' })])),
    });
    renderConsole(<ApprovalsPage />, { transport, roles: ['ADM'] });
    expect(await screen.findByText('Already decided: Approved.')).toBeInTheDocument();
    expect(calls[0]!.search).toBe('?status=approved&limit=50');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('lists your own requests from the server, waiting or decided with who, when and why (BR-21)', async () => {
    const { transport, calls } = scriptedTransport({
      'admin.four_eyes_list': (req) =>
        req.search.includes('mine=true')
          ? page([
              change(B),
              change(A, {
                status: 'rejected',
                decided_by_display: 'Sara Staff',
                decided_at: ago(1),
                decision_reason: 'values_incorrect: 60 days is too long',
              }),
            ])
          : page([]),
    });
    renderConsole(<ApprovalsPage />, { transport, roles: ['ADM'] });
    expect(await screen.findByText('Nothing waits for your approval.')).toBeInTheDocument();
    const mine = screen.getByTestId('my-requests');
    expect(await within(mine).findByText('Waiting for a second staff member')).toBeInTheDocument();
    const decided = within(mine).getByTestId('my-decided');
    expect(decided).toHaveAttribute('data-status', 'rejected');
    expect(decided).toHaveTextContent('Data retention change: Rejected');
    expect(decided).toHaveTextContent(/Decided by Sara Staff on/);
    expect(decided).toHaveTextContent('60 days is too long');
    expect(calls.map((c) => c.search)).toContain('?mine=true&limit=20');
  });

  it('says so when you have no requests', async () => {
    const { transport } = scriptedTransport({ 'admin.four_eyes_list': () => page([]) });
    renderConsole(<ApprovalsPage />, { transport, roles: ['ADM'] });
    expect(await within(screen.getByTestId('my-requests')).findByText(/You have not requested a change/)).toBeInTheDocument();
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      resetNav(`/approvals?change=${A}`);
      const { transport } = scriptedTransport({
        'admin.four_eyes_list': (req) => (req.search.includes('mine=true') ? page([]) : page([change(A), change(B)])),
      });
      renderConsole(<ApprovalsPage />, { transport, roles: ['ADM'], locale });
      await screen.findByTestId('approval-detail');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
