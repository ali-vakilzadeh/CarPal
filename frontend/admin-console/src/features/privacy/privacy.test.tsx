// AC10.T4/T5 DOM tests of Privacy requests: the queue (most urgent first, the overdue view), a request opened for its
// purpose (dsr:<id>) with its steps — identity check, rejection with the user's text, the export built in the
// background and followed with admin.job_get, the deletion by four-eyes (ADM only) — the request not on the page,
// and axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axeViolations, page, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { nav, resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import type { DsrRow } from './dsr-logic';
import { PrivacyPage } from './privacy-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const R1 = '0193a3c4-5d6e-7f80-9a1b-0000000000a1';
const R2 = '0193a3c4-5d6e-7f80-9a1b-0000000000a2';
const U1 = '0193a3c4-5d6e-7f80-9a1b-0000000000b1';
const J1 = '0193a3c4-5d6e-7f80-9a1b-0000000000c1';
const days = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

function dsr(id: string, o: Partial<DsrRow> = {}): DsrRow {
  return {
    id,
    user_id: U1,
    created_at: days(-3),
    updated_at: days(-3),
    version: 1,
    request_type: 'export',
    details: 'Please send me everything you hold about me.',
    status: 'received',
    requested_at: days(-3),
    due_at: days(27),
    rejection_reason: null,
    completed_at: null,
    export_available: false,
    ...o,
  };
}

const reason = (dialog: HTMLElement, code: string, note?: string) => {
  fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: code } });
  if (note !== undefined) fireEvent.change(within(dialog).getByLabelText(/^Note/), { target: { value: note } });
};

beforeEach(() => resetNav('/privacy'));
afterEach(() => vi.unstubAllGlobals());

describe('Privacy requests (AC10.T4/T5)', () => {
  it('lists requests most urgent first and filters the overdue view', async () => {
    const { transport, calls } = scriptedTransport({
      'admin.dsr_queue': () =>
        page([
          dsr(R1, { due_at: days(20) }),
          dsr(R2, { request_type: 'deletion', due_at: days(-1) }),
          dsr('0193a3c4-5d6e-7f80-9a1b-0000000000a3', { status: 'completed', due_at: days(-5) }),
        ]),
    });
    renderConsole(<PrivacyPage />, { transport, roles: ['SUP'] });
    const table = await screen.findByRole('table', { name: 'Privacy requests' });
    // The overdue deletion first, the closed request last.
    await within(table).findByText('Account deletion');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Account deletion');
    expect(rows.at(-1)).toHaveTextContent('Completed');
    expect(calls[0]!.search).toBe('?limit=50');
    fireEvent.change(screen.getByLabelText('View'), { target: { value: 'overdue' } });
    await waitFor(() => expect(calls.at(-1)!.search).toMatch(/^\?due_before=\d{4}-\d{2}-\d{2}&limit=50$/));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2));
  });

  it('opens a request for its purpose and starts the identity check with a reason', async () => {
    resetNav(`/privacy?request=${R1}`);
    const { transport, calls } = scriptedTransport({
      'admin.dsr_queue': () => page([dsr(R1)]),
      'admin.dsr_update': () => Response.json(dsr(R1, { status: 'verifying_identity', version: 2 })),
    });
    renderConsole(<PrivacyPage />, { transport, roles: ['SUP'] });
    const detail = await screen.findByTestId('dsr-detail');
    expect(within(detail).getByText('Please send me everything you hold about me.')).toBeInTheDocument();
    expect(within(detail).getByTestId('dsr-user-link')).toHaveAttribute('href', `/users/${U1}?purpose=${encodeURIComponent(`dsr:${R1}`)}`);
    // Staff never download the export (DQ-12).
    expect(within(detail).getByTestId('dsr-type-note')).toHaveTextContent('Staff never download it');
    fireEvent.click(screen.getByRole('button', { name: 'Start the identity check' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start the identity check' });
    reason(dialog, 'identity_checked');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start the identity check' }));
    expect(await screen.findByText('The identity check has started.')).toBeInTheDocument();
    const call = calls.find((c) => c.opId === 'admin.dsr_update')!;
    expect(call.headers.get('carpal-access-purpose')).toBe(`dsr:${R1}`);
    expect(call.body).toEqual({ status: 'verifying_identity', reason: 'identity_checked' });
    expect(screen.getByTestId('dsr-status')).toHaveTextContent('Checking identity');
    expect(screen.getByRole('button', { name: 'Identity verified: start processing' })).toBeInTheDocument();
  });

  it('a link to a request past the loaded page walks the queue with the same filters (D-125)', async () => {
    resetNav(`/privacy?type=export&status=received&request=${R1}`);
    const { transport, calls } = scriptedTransport({
      'admin.dsr_queue': (req) => {
        const q = new URLSearchParams(req.search);
        if (q.get('limit') === '50') return page([dsr(R2)], 'c1');
        return q.get('cursor') ? page([dsr(R1)]) : page([dsr(R2)], 'c2');
      },
    });
    renderConsole(<PrivacyPage />, { transport, roles: ['SUP'] });
    const detail = await screen.findByTestId('dsr-detail');
    expect(detail).toHaveAttribute('data-request', R1);
    const walk = calls.filter((c) => new URLSearchParams(c.search).get('limit') === '100');
    expect(walk).toHaveLength(2);
    expect(new URLSearchParams(walk[1]!.search).get('cursor')).toBe('c2');
    expect(new URLSearchParams(walk[0]!.search).get('status')).toBe('received');
    expect(new URLSearchParams(walk[0]!.search).get('request_type')).toBe('export');
  });

  it('a rejection needs the text the user reads, and sends it', async () => {
    resetNav(`/privacy?request=${R1}`);
    const { transport, calls } = scriptedTransport({
      'admin.dsr_queue': () => page([dsr(R1, { status: 'verifying_identity' })]),
      'admin.dsr_update': () => Response.json(dsr(R1, { status: 'rejected', rejection_reason: 'We could not confirm it was you.' })),
    });
    renderConsole(<PrivacyPage />, { transport, roles: ['SUP'] });
    await screen.findByTestId('dsr-detail');
    fireEvent.click(screen.getByRole('button', { name: 'Reject the request' }));
    expect(screen.getByText('Write the reason the user will read.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(screen.getByLabelText('Reason the user will read'), { target: { value: 'We could not confirm it was you.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject the request' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject the request' });
    reason(dialog, 'identity_not_verified', 'no answer to the email check');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject the request' }));
    expect(await screen.findByText('The request is rejected. The user is told why.')).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.dsr_update')!.body).toEqual({
      status: 'rejected',
      rejection_reason: 'We could not confirm it was you.',
      reason: 'identity_not_verified: no answer to the email check',
    });
  });

  it('builds the export in the background and follows the job until it is ready (BR-20)', async () => {
    resetNav(`/privacy?request=${R1}`);
    let polls = 0;
    const job = (status: string) => ({
      id: J1,
      created_at: days(0),
      updated_at: days(0),
      version: 1,
      kind: 'data_export',
      status,
      progress: status === 'succeeded' ? 100 : 40,
      expires_at: days(7),
    });
    const { transport, calls } = scriptedTransport({
      'admin.dsr_queue': () => page([dsr(R1, { status: 'in_progress' })]),
      'admin.dsr_export': () => Response.json(job('queued'), { status: 202 }),
      'admin.job_get': () => Response.json(job(++polls > 1 ? 'succeeded' : 'running')),
    });
    renderConsole(<PrivacyPage />, { transport, roles: ['SUP'] });
    const box = await screen.findByTestId('dsr-export');
    expect(screen.getByText(/Mark the request completed only after the export file is built/)).toBeInTheDocument();
    fireEvent.click(within(box).getByRole('button', { name: 'Build the export file' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export file' });
    reason(dialog, 'user_request');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Build the export file' }));
    expect(await within(box).findByText('The export is being built (40 %).')).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.dsr_export')!.headers.get('carpal-access-purpose')).toBe(`dsr:${R1}`);
    expect(calls.find((c) => c.opId === 'admin.job_get')!.path).toBe(`/v1/admin/jobs/${J1}`);
    expect(await within(box).findByText(/The export file is ready/, {}, { timeout: 6_000 })).toBeInTheDocument();
    expect(within(box).getByRole('button', { name: 'Build it again' })).toBeEnabled();
  });

  it('a deletion runs only after a second administrator approves (four-eyes, ADM)', async () => {
    resetNav(`/privacy?request=${R2}`);
    const { transport, calls } = scriptedTransport({
      'admin.dsr_queue': () => page([dsr(R2, { request_type: 'deletion', status: 'in_progress' })]),
      'admin.dsr_execute_deletion': () =>
        Response.json(
          {
            change_id: J1,
            op_id: 'admin.dsr_execute_deletion',
            summary: `Delete the account and personal data of user ${U1}`,
            requested_by_display: 'Sara Staff',
            requested_at: days(0),
            reason: 'identity_verified: checked by phone',
            status: 'pending',
            expires_at: days(3),
            decided_by_display: null,
            decided_at: null,
            decision_reason: null,
            job_id: null,
          },
          { status: 202 },
        ),
    });
    renderConsole(<PrivacyPage />, { transport, roles: ['ADM'] });
    const box = await screen.findByTestId('dsr-deletion');
    // A deletion is never completed by hand.
    expect(screen.queryByRole('button', { name: 'Mark completed' })).toBeNull();
    expect(within(box).getByText(/cannot show a preview/)).toBeInTheDocument();
    fireEvent.click(within(box).getByRole('button', { name: 'Run the deletion' }));
    const dialog = await screen.findByRole('dialog', { name: 'Run the deletion' });
    reason(dialog, 'identity_verified', 'checked by phone');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run the deletion' }));
    expect(within(dialog).getByText('Tick the box to confirm.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText('I understand, and I want to go ahead'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run the deletion' }));
    expect(await within(box).findByText('Waiting for a second staff member')).toBeInTheDocument();
    const call = calls.find((c) => c.opId === 'admin.dsr_execute_deletion')!;
    expect(call.headers.get('carpal-access-purpose')).toBe(`dsr:${R2}`);
    expect(call.body).toEqual({ reason: 'identity_verified: checked by phone' });
  });

  it('support staff see that only an admin runs a deletion', async () => {
    resetNav(`/privacy?request=${R2}`);
    const { transport } = scriptedTransport({
      'admin.dsr_queue': () => page([dsr(R2, { request_type: 'deletion', status: 'in_progress' })]),
    });
    renderConsole(<PrivacyPage />, { transport, roles: ['SUP'] });
    const box = await screen.findByTestId('dsr-deletion');
    expect(within(box).queryByRole('button', { name: 'Run the deletion' })).toBeNull();
    expect(within(box).getByText('Only a platform admin can run a deletion.')).toBeInTheDocument();
  });

  it('a request that is not on the current page says so (no read by id, BR-38)', async () => {
    resetNav(`/privacy?request=${R2}`);
    const { transport } = scriptedTransport({ 'admin.dsr_queue': () => page([dsr(R1)]) });
    renderConsole(<PrivacyPage />, { transport, roles: ['SUP'] });
    expect(await screen.findByTestId('dsr-not-listed')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Data export/ }));
    expect(nav.search).toBe(`request=${R1}&purpose=${encodeURIComponent(`dsr:${R1}`)}`);
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      resetNav(`/privacy?request=${R1}`);
      const { transport } = scriptedTransport({ 'admin.dsr_queue': () => page([dsr(R1, { status: 'in_progress' }), dsr(R2)]) });
      renderConsole(<PrivacyPage />, { transport, roles: ['ADM'], locale });
      await screen.findByTestId('dsr-detail');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
