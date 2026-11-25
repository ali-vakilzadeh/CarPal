// AC6.T5 tests of Data retention: the list (unknown actions read "Unknown"), Add a policy and the dry run (AC14-2), an edit validated and filed as a four-eyes change with the whole policy and a reason; axe in EN and FA.
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingChange, RetentionPolicy } from '@carpal/api-contracts';
import { axeViolations, page, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { RetentionPage } from './retention-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const P1 = '0193a3c4-5d6e-7f80-9a1b-0000000000a1';
const P2 = '0193a3c4-5d6e-7f80-9a1b-0000000000a2';

const policy = (id: string, o: Partial<RetentionPolicy> = {}): RetentionPolicy => ({
  id,
  entity_type: 'Review',
  applies_to_status: 'removed',
  retention_days: 90,
  action: 'delete',
  legal_basis: 'Moderation records, 52 §14',
  status: 'active',
  ...o,
});

const pending: PendingChange = {
  change_id: '0193a3c4-5d6e-7f80-9a1b-0000000000bb',
  op_id: 'admin.retention_update',
  summary: 'Retention Review: 90 d delete → 180 d anonymize (active)',
  requested_by_display: 'Sara Staff',
  requested_at: new Date().toISOString(),
  reason: 'planned_change',
  status: 'pending',
  expires_at: new Date(Date.now() + 72 * 3_600_000).toISOString(),
  decided_by_display: null,
  decided_at: null,
  decision_reason: null,
  job_id: null,
};

beforeEach(() => resetNav('/retention'));
afterEach(() => vi.unstubAllGlobals());

describe('Data retention page (AC6.T5)', () => {
  it('lists policies and offers Add a policy to administrators', async () => {
    const { transport, calls } = scriptedTransport({
      'admin.retention_list': () =>
        page([policy(P1), policy(P2, { entity_type: 'Message', action: 'shred' as RetentionPolicy['action'], applies_to_status: null })]),
    });
    renderConsole(<RetentionPage />, { transport, roles: ['ADM'] });
    const table = await screen.findByRole('table', { name: 'Retention policies' });
    expect(await within(table).findByText('Unknown (shred)')).toBeInTheDocument();
    expect(within(table).getByText('Any status')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a policy' })).toBeInTheDocument();
    expect(calls[0]!.search).toBe('?limit=100');
  });

  it('an edit is checked, needs a reason and is filed for a second admin with the whole policy', async () => {
    resetNav(`/retention?policy=${P1}`);
    const { transport, calls } = scriptedTransport({
      'admin.retention_list': () => page([policy(P1)]),
      'admin.retention_update': () => Response.json(pending, { status: 202 }),
    });
    renderConsole(<RetentionPage />, { transport, roles: ['ADM'] });
    const editor = await screen.findByTestId('policy-editor');
    const save = within(editor).getByRole('button', { name: 'Send for approval' });
    expect(save).toBeDisabled();
    fireEvent.change(within(editor).getByLabelText('Kept for'), { target: { value: '40000' } });
    fireEvent.click(save);
    expect(within(editor).getByText('Enter a whole number of days from 1 to 36,500.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(within(editor).getByLabelText('Kept for'), { target: { value: '۱۸۰' } });
    fireEvent.change(within(editor).getByLabelText('Afterwards'), { target: { value: 'anonymize' } });
    fireEvent.click(save);
    const dialog = await screen.findByRole('dialog', { name: 'Change retention of Review' });
    expect(within(dialog).getByText('90 days, then Delete → 180 days, then Anonymize (Active).')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'planned_change' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await within(editor).findByText('Waiting for a second staff member')).toBeInTheDocument();
    const put = calls.find((c) => c.opId === 'admin.retention_update')!;
    expect(put.method).toBe('PUT');
    expect(put.path).toBe(`/v1/admin/retention-policies/${P1}`);
    expect(put.body).toEqual({
      entity_type: 'Review',
      applies_to_status: 'removed',
      retention_days: 180,
      action: 'anonymize',
      legal_basis: 'Moderation records, 52 §14',
      status: 'active',
      reason: 'planned_change',
    });
  });

  it('Add a policy (AC14-2): the record type is checked, then filed for a second admin; a duplicate is explained', async () => {
    resetNav('/retention?policy=new');
    let dup = false;
    const { transport, calls } = scriptedTransport({
      'admin.retention_list': () => page([policy(P1)]),
      'admin.retention_create': () =>
        dup
          ? Response.json(
              { code: 'DUPLICATE', title: 'DUPLICATE', request_id: 'r' },
              { status: 409, headers: { 'content-type': 'application/problem+json' } },
            )
          : Response.json({ ...pending, op_id: 'admin.retention_create' }, { status: 202 }),
    });
    renderConsole(<RetentionPage />, { transport, roles: ['ADM'] });
    const form = await screen.findByTestId('policy-new');
    fireEvent.change(within(form).getByLabelText('Record type'), { target: { value: 'notification' } });
    fireEvent.change(within(form).getByLabelText('Kept for'), { target: { value: '30' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Send for approval' }));
    expect(within(form).getByText('Start with a capital letter; letters and digits only (2 to 64).')).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Record type'), { target: { value: 'Notification' } });
    fireEvent.change(within(form).getByLabelText('Afterwards'), { target: { value: 'anonymize' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Send for approval' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a retention policy for Notification' });
    expect(within(dialog).getByText('Notification: kept for 30 days, then Anonymize (Active).')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'planned_change' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await within(form).findByText('Waiting for a second staff member')).toBeInTheDocument();
    const post = calls.find((c) => c.opId === 'admin.retention_create')!;
    expect(post.method).toBe('POST');
    expect(post.body).toEqual({
      entity_type: 'Notification',
      applies_to_status: null,
      retention_days: 30,
      action: 'anonymize',
      legal_basis: null,
      status: 'active',
      reason: 'planned_change',
    });
    dup = true;
    fireEvent.click(within(form).getByRole('button', { name: 'Send for approval' }));
    const again = await screen.findByRole('dialog', { name: 'Add a retention policy for Notification' });
    fireEvent.change(within(again).getByLabelText('Reason'), { target: { value: 'planned_change' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Send for approval' }));
    expect(
      await within(form).findByText('There is already a policy, or a request for one, for this record type and status.'),
    ).toBeInTheDocument();
  });

  it('Add a policy is not offered without admin.retention_create', async () => {
    resetNav('/retention?policy=new');
    const { transport } = scriptedTransport({ 'admin.retention_list': () => page([policy(P1)]) });
    renderConsole(<RetentionPage />, { transport, roles: ['MOD'] });
    await screen.findByRole('table', { name: 'Retention policies' });
    expect(screen.queryByRole('button', { name: 'Add a policy' })).toBeNull();
    expect(screen.queryByTestId('policy-new')).toBeNull();
  });

  it('Dry run (AC14-2): the policy as it is, then the edited period; every outcome is explained', async () => {
    resetNav(`/retention?policy=${P1}`);
    const answers: Record<string, unknown>[] = [
      {
        policy_id: P1,
        entity_type: 'Review',
        applies_to_status: 'removed',
        retention_days: 90,
        action: 'delete',
        status: 'active',
        cutoff: '2026-08-27T00:00:00Z',
        outcome: 'counted',
        affected: 1234,
        by_status: [{ status: 'removed', count: 1234 }],
      },
      {
        policy_id: P1,
        entity_type: 'Review',
        applies_to_status: 'removed',
        retention_days: 30,
        action: 'delete',
        status: 'active',
        cutoff: '2026-10-26T00:00:00Z',
        outcome: 'no_handler',
        affected: null,
        by_status: null,
      },
    ];
    const { transport, calls } = scriptedTransport({
      'admin.retention_list': () => page([policy(P1)]),
      'admin.retention_dry_run': () => Response.json(answers.shift()),
    });
    renderConsole(<RetentionPage />, { transport, roles: ['ADM'] });
    const dry = await screen.findByTestId('retention-dry-run');
    fireEvent.click(within(dry).getByRole('button', { name: 'Count what the next run would do' }));
    expect(await within(dry).findByTestId('dry-run-affected')).toHaveTextContent('1,234 records would be deleted.');
    expect(within(dry).getByRole('table', { name: 'Records due, by status' })).toHaveTextContent('removed');
    expect(calls.find((c) => c.opId === 'admin.retention_dry_run')!.body).toEqual({});
    fireEvent.change(within(screen.getByTestId('policy-editor')).getByLabelText('Kept for'), { target: { value: '30' } });
    fireEvent.click(within(dry).getByRole('button', { name: 'Count with the edited period and status' }));
    expect(await within(dry).findByTestId('dry-run-outcome')).toHaveTextContent('No part of CarPal applies this record type yet');
    const last = calls.filter((c) => c.opId === 'admin.retention_dry_run').at(-1)!;
    expect(last.path).toBe(`/v1/admin/retention-policies/${P1}/dry-run`);
    expect(last.body).toEqual({ retention_days: 30 });
    expect(last.headers.get('carpal-reason')).toBeNull();
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      resetNav(`/retention?policy=${P1}`);
      const { transport } = scriptedTransport({ 'admin.retention_list': () => page([policy(P1), policy(P2, { status: 'inactive' })]) });
      renderConsole(<RetentionPage />, { transport, roles: ['ADM'], locale });
      await screen.findByTestId('policy-editor');
      expect(await axeViolations()).toEqual([]);
    });

    it(`axe: no violations on the new policy form (${locale})`, async () => {
      resetNav('/retention?policy=new');
      const { transport } = scriptedTransport({ 'admin.retention_list': () => page([policy(P1)]) });
      renderConsole(<RetentionPage />, { transport, roles: ['ADM'], locale });
      await screen.findByTestId('policy-new');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
