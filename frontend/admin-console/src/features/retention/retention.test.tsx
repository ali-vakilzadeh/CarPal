// AC6.T5 tests of Data retention: the list (unknown actions read "Unknown"), the missing add and dry run said on
// screen, an edit validated and filed as a four-eyes change with the whole policy and a reason; axe in EN and FA.
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
};

beforeEach(() => resetNav('/retention'));
afterEach(() => vi.unstubAllGlobals());

describe('Data retention page (AC6.T5)', () => {
  it('lists policies and says what the contract does not offer', async () => {
    const { transport, calls } = scriptedTransport({
      'admin.retention_list': () =>
        page([policy(P1), policy(P2, { entity_type: 'Message', action: 'shred' as RetentionPolicy['action'], applies_to_status: null })]),
    });
    renderConsole(<RetentionPage />, { transport, roles: ['ADM'] });
    const table = await screen.findByRole('table', { name: 'Retention policies' });
    expect(await within(table).findByText('Unknown (shred)')).toBeInTheDocument();
    expect(within(table).getByText('Any status')).toBeInTheDocument();
    expect(screen.getByTestId('retention-gaps')).toHaveTextContent('Adding a policy and the dry run');
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

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      resetNav(`/retention?policy=${P1}`);
      const { transport } = scriptedTransport({ 'admin.retention_list': () => page([policy(P1), policy(P2, { status: 'inactive' })]) });
      renderConsole(<RetentionPage />, { transport, roles: ['ADM'], locale });
      await screen.findByTestId('policy-editor');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
