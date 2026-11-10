// AC5.T7/T8 DOM tests of My work: the approvals waiting for the caller (soonest expiry first, linked to Pending
// approvals), one tile per queue the roles may see with count, oldest age and SLA state, a lower-bound count for long
// queues, a failed queue with retry; axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axeViolations, page, problem, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { MyWork } from './my-work';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const H = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * H).toISOString();
const soon = (h: number) => new Date(Date.now() + h * H).toISOString();
const uuid = (n: number) => `0193a3c4-5d6e-7f80-9a1b-${String(n).padStart(12, '0')}`;

beforeEach(() => resetNav('/'));
afterEach(() => vi.unstubAllGlobals());

describe('My work (AC5.T7)', () => {
  it('ADM: approvals waiting (soonest first) and the ADM queues with counts and SLA', async () => {
    const { transport } = scriptedTransport({
      'admin.four_eyes_list': () =>
        page([
          {
            change_id: uuid(1),
            op_id: 'admin.flag_update',
            summary: 'ai.automation.kill_switch off',
            requested_by_display: 'Ali Admin',
            requested_at: ago(2),
            reason: 'planned_change',
            status: 'pending',
            expires_at: soon(70),
          },
          {
            change_id: uuid(2),
            op_id: 'admin.exchange_rate_update',
            summary: 'IRR 600000 → 900000',
            requested_by_display: 'Reza Admin',
            requested_at: ago(68),
            reason: 'correction',
            status: 'pending',
            expires_at: soon(4),
          },
        ]),
      'admin.verifications_queue': () =>
        page([
          { id: uuid(3), created_at: ago(80), verification_type: 'address', status: 'pending', organization: {}, location_check: null },
        ]),
      'admin.cases_list': (req) => (req.search.includes('status=open') ? page([]) : page([])),
      'admin.dsr_queue': (req) =>
        req.search.includes('status=received')
          ? page([{ id: uuid(4), requested_at: ago(24 * 5), due_at: soon(24 * 25), status: 'received', request_type: 'export' }])
          : page([]),
    });
    renderConsole(<MyWork />, { transport, roles: ['ADM'] });
    expect(screen.getByRole('heading', { level: 1, name: 'My work' })).toBeInTheDocument();
    const approvals = await screen.findByTestId('work-approvals');
    const links = await within(approvals).findAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Exchange rate change', 'Feature flag change']);
    expect(links[0]).toHaveAttribute('href', `/approvals?change=${uuid(2)}`);

    const tiles = screen.getAllByRole('link').filter((l) => l.hasAttribute('data-queue'));
    expect(tiles.map((t) => t.getAttribute('data-queue'))).toEqual(['approvals', 'verification', 'cases', 'privacy']);
    await waitFor(() => expect(tiles[1]).toHaveAttribute('data-count', '1'));
    // 80 h after submission is past 2 working days.
    expect(tiles[1]).toHaveAttribute('data-sla', 'breach');
    expect(within(tiles[1]!).getByText('1 overdue')).toBeInTheDocument();
    expect(tiles[1]).toHaveAttribute('href', '/verification');
    await waitFor(() => expect(tiles[2]).toHaveAttribute('data-count', '0'));
    expect(within(tiles[2]!).getByText('Nothing open.')).toBeInTheDocument();
    await waitFor(() => expect(tiles[3]).toHaveAttribute('data-sla', 'ok'));
    expect(tiles[0]).toHaveAttribute('data-sla', 'warn');
  });

  it('CRV sees only the review approvals and disputes queues; a long queue shows a lower bound', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: uuid(i), created_at: ago(1), status: 'open' }));
    const { transport, calls } = scriptedTransport({
      'admin.review_approvals_queue': () => page([]),
      'admin.disputes_queue': (req) => (req.search.includes('status=open') ? page(many, 'next') : page([])),
    });
    renderConsole(<MyWork />, { transport, roles: ['CRV'] });
    const tiles = (await screen.findAllByRole('link')).filter((l) => l.hasAttribute('data-queue'));
    expect(tiles.map((t) => t.getAttribute('data-queue'))).toEqual(['reviewApproval', 'disputes']);
    expect(screen.queryByTestId('work-approvals')).toBeNull();
    await waitFor(() => expect(tiles[1]).toHaveTextContent('200+'));
    expect(calls.filter((c) => c.opId === 'admin.disputes_queue' && c.search.includes('status=open'))).toHaveLength(2);
    expect(calls.find((c) => c.opId === 'admin.review_approvals_queue')!.search).toBe('?stage=awaiting_reviewer&limit=100');
  });

  it('a queue that fails says so and can be retried', async () => {
    let fail = true;
    const { transport } = scriptedTransport({
      // A 500 (a 503 would pause the operation for 30 s after three tries, SEC-RL-4).
      'admin.reports_list': () => (fail ? problem(500, 'INTERNAL') : page([])),
      'admin.dsr_queue': () => page([]),
    });
    renderConsole(<MyWork />, { transport, roles: ['SUP'] });
    const retry = await screen.findByRole('button', { name: 'Try again' });
    fail = false;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      const { transport } = scriptedTransport({
        'admin.four_eyes_list': () => page([]),
        'admin.verifications_queue': () => page([]),
        'admin.review_approvals_queue': () => page([]),
        'admin.reports_list': () => page([]),
        'admin.cases_list': () => page([]),
        'admin.disputes_queue': () => page([]),
      });
      renderConsole(<MyWork />, { transport, roles: ['MOD'], locale });
      await waitFor(() => expect(document.querySelectorAll('[data-queue][data-count="0"]')).toHaveLength(6));
      expect(await axeViolations()).toEqual([]);
    });
  }
});
