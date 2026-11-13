// AC6.T1 tests of Exchange rates: the rate rules (decimal, Persian digits, the 20 % four-eyes threshold as the server
// applies it), and the screen: list, preview at the current and the new rate, a reason before anything is sent, the
// version as If-Match, applied / waiting for a second admin / changed meanwhile (Reload keeps the typed rate); axe.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeRate, PendingChange } from '@carpal/api-contracts';
import { axeViolations, problem, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { changeRatio, needsSecondApprover, parseRate } from './rate-logic';
import { RatesPage } from './rates-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const irr = (o: Partial<ExchangeRate> = {}): ExchangeRate => ({
  currency: 'IRR',
  per_usd: '1000000.0000',
  updated_at: '2026-11-01T08:00:00Z',
  updated_by_display: 'Ali Admin',
  version: 3,
  ...o,
});

const pending: PendingChange = {
  change_id: '0193a3c4-5d6e-7f80-9a1b-0000000000aa',
  op_id: 'admin.exchange_rate_update',
  summary: 'Set IRR per USD to 1500000',
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

beforeEach(() => resetNav('/rates'));
afterEach(() => vi.unstubAllGlobals());

describe('rate rules (AC6.T1)', () => {
  it('reads decimals with Persian digits and separators, and refuses others', () => {
    expect(parseRate('1050000')).toEqual({ value: '1050000' });
    expect(parseRate('۱٬۰۵۰٬۰۰۰٫۵')).toEqual({ value: '1050000.5' });
    expect(parseRate(' 1,050,000.1234 ')).toEqual({ value: '1050000.1234' });
    expect(parseRate('')).toEqual({ problem: 'empty' });
    expect(parseRate('1.23456')).toEqual({ problem: 'format' });
    expect(parseRate('12345678901')).toEqual({ problem: 'format' });
    expect(parseRate('-5')).toEqual({ problem: 'format' });
    expect(parseRate('0.0000')).toEqual({ problem: 'zero' });
    expect(parseRate('1000000', '1000000.0000')).toEqual({ problem: 'same' });
  });

  it('asks for a second admin above 20 %, like the server', () => {
    expect(needsSecondApprover('1000000.0000', '1200000')).toBe(false);
    expect(needsSecondApprover('1000000.0000', '1200001')).toBe(true);
    expect(needsSecondApprover('1000000.0000', '800000')).toBe(false);
    expect(needsSecondApprover('1000000.0000', '700000')).toBe(true);
    expect(changeRatio('1000000', '1050000')).toBeCloseTo(0.05);
  });
});

describe('Exchange rates page (AC6.T1)', () => {
  it('lists rates; a small change previews, needs a reason and is sent with the version', async () => {
    resetNav('/rates?currency=IRR');
    let current = irr();
    const { transport, calls } = scriptedTransport({
      'admin.exchange_rates_list': () => Response.json({ items: [current] }),
      'admin.exchange_rate_update': (_req, body) => {
        current = irr({ per_usd: String(body?.per_usd), version: 4, updated_by_display: 'Sara Staff' });
        return Response.json(current, { headers: { etag: '"v4"' } });
      },
    });
    renderConsole(<RatesPage />, { transport, roles: ['ADM'] });
    const editor = await screen.findByTestId('rate-editor');
    expect(within(editor).getByTestId('rate-current')).toHaveTextContent('1,000,000 IRR per US dollar');
    fireEvent.change(within(editor).getByLabelText('New rate (IRR per US dollar)'), { target: { value: '1050000' } });
    const preview = within(editor).getByTestId('rate-preview');
    expect(preview).toHaveTextContent('2,500,000 T');
    expect(preview).toHaveTextContent('2,625,000 T');
    expect(within(editor).getByTestId('rate-change')).toHaveTextContent('+5 %');
    expect(within(editor).queryByTestId('rate-four-eyes-warning')).toBeNull();
    fireEvent.click(within(editor).getByRole('button', { name: 'Save rate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change the IRR rate' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save rate' }));
    expect(within(dialog).getByText('Choose a reason.')).toBeInTheDocument();
    expect(calls.some((c) => c.opId === 'admin.exchange_rate_update')).toBe(false);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'planned_change' } });
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), { target: { value: 'Market rate 10 Nov' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save rate' }));
    expect(await screen.findByText('Saved. The apps show the new rate within five minutes.')).toBeInTheDocument();
    const put = calls.find((c) => c.opId === 'admin.exchange_rate_update')!;
    expect(put.method).toBe('PUT');
    expect(put.path).toBe('/v1/admin/exchange-rates/IRR');
    expect(put.headers.get('if-match')).toBe('"v3"');
    expect(put.body).toEqual({ per_usd: '1050000', reason: 'planned_change: Market rate 10 Nov' });
    // The list is read again and shows the new rate.
    await waitFor(() => expect(screen.getByTestId('rate-IRR')).toHaveTextContent('1,050,000'));
  });

  it('a change over 20 % warns and ends as a four-eyes change', async () => {
    resetNav('/rates?currency=IRR');
    const { transport } = scriptedTransport({
      'admin.exchange_rates_list': () => Response.json({ items: [irr()] }),
      'admin.exchange_rate_update': () => Response.json(pending, { status: 202 }),
    });
    renderConsole(<RatesPage />, { transport, roles: ['ADM'] });
    const editor = await screen.findByTestId('rate-editor');
    fireEvent.change(within(editor).getByLabelText('New rate (IRR per US dollar)'), { target: { value: '1500000' } });
    expect(within(editor).getByTestId('rate-four-eyes-warning')).toHaveTextContent('A second platform admin must approve');
    fireEvent.click(within(editor).getByRole('button', { name: 'Send for approval' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change the IRR rate' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'incident_response' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findByText('Waiting for a second staff member')).toBeInTheDocument();
    expect(screen.getByText(/Exchange rate change was filed/)).toBeInTheDocument();
  });

  it('someone else changed it meanwhile: explained, Reload reads it again and keeps the typed rate', async () => {
    resetNav('/rates?currency=IRR');
    let reads = 0;
    const { transport } = scriptedTransport({
      'admin.exchange_rates_list': () => {
        reads++;
        return Response.json({ items: [irr({ version: reads > 1 ? 5 : 3 })] });
      },
      'admin.exchange_rate_update': () => problem(412, 'VERSION_MISMATCH'),
    });
    renderConsole(<RatesPage />, { transport, roles: ['ADM'] });
    const editor = await screen.findByTestId('rate-editor');
    const input = within(editor).getByLabelText('New rate (IRR per US dollar)');
    fireEvent.change(input, { target: { value: '1010000' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save rate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change the IRR rate' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'correction' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save rate' }));
    expect(await screen.findByText(/Someone changed this record meanwhile/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(within(screen.getByTestId('rate-editor')).getByLabelText('New rate (IRR per US dollar)')).toHaveValue('1010000');
  });

  it('shows a problem with the typed rate', async () => {
    resetNav('/rates?currency=IRR');
    const { transport, calls } = scriptedTransport({ 'admin.exchange_rates_list': () => Response.json({ items: [irr()] }) });
    renderConsole(<RatesPage />, { transport, roles: ['ADM'] });
    const editor = await screen.findByTestId('rate-editor');
    fireEvent.click(within(editor).getByRole('button', { name: 'Save rate' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(within(editor).getByLabelText('New rate (IRR per US dollar)'), { target: { value: '1.234567' } });
    expect(within(editor).getByText(/at most 10 digits before the point and 4 after/)).toBeInTheDocument();
    expect(calls.filter((c) => c.opId === 'admin.exchange_rate_update')).toHaveLength(0);
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      resetNav('/rates?currency=IRR');
      const { transport } = scriptedTransport({
        'admin.exchange_rates_list': () => Response.json({ items: [irr(), irr({ currency: 'USD', per_usd: '1.0000' })] }),
      });
      renderConsole(<RatesPage />, { transport, roles: ['ADM'], locale });
      const editor = await screen.findByTestId('rate-editor');
      fireEvent.change(within(editor).getByRole('textbox'), { target: { value: '1500000' } });
      expect(await axeViolations()).toEqual([]);
    });
  }
});
