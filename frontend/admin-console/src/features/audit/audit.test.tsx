// AC13.T1 tests of the audit log: the window rules (the viewer's days, at most 93), nothing searched before Search,
// the filters sent exactly as typed, a bad id refused, the append-only notice, entries with actor type, reason and
// entity; axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '@carpal/api-contracts';
import { axeViolations, page, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { nav, resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { AuditPage } from './audit-page';
import { checkWindow, dayStart, instantsOf, windowFromParams } from './search-window';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const FLAG = '0193a3c4-5d6e-7f80-9a1b-00000000f1a9';
const USER = '0193a3c4-5d6e-7f80-9a1b-00000000a11c';

const entry = (o: Partial<AuditEntry> = {}): AuditEntry => ({
  id: '0193a3c4-5d6e-7f80-9a1b-0000000000e1',
  actor_type: 'platform_staff',
  actor_display: 'Sara Admin',
  organization_id: null,
  action: 'admin.flag_updated',
  entity_type: 'feature_flag',
  entity_id: FLAG,
  previous_state_summary: 'off',
  new_state_summary: 'on',
  reason: 'incident_response: unsafe text',
  request_id: 'req-1',
  created_at: '2026-11-19T08:00:00Z',
  ...o,
});

beforeEach(() => resetNav('/audit'));
afterEach(() => vi.unstubAllGlobals());

describe('search window (AC13.T1)', () => {
  it("typed days run from the first day's start to the end of the last, on the viewer's clock", () => {
    expect(new Date(dayStart('2026-11-20', 'Asia/Tehran')).toISOString()).toBe('2026-11-19T20:30:00.000Z');
    expect(instantsOf({ kind: 'days', from: '2026-11-19', to: '2026-11-20' }, 0, 'Asia/Tehran')).toEqual({
      from: '2026-11-18T20:30:00.000Z',
      to: '2026-11-20T20:30:00.000Z',
    });
    expect(instantsOf({ kind: 'preset', preset: '1' }, Date.parse('2026-11-20T00:00:00Z'), 'UTC')).toEqual({
      from: '2026-11-19T00:00:00.000Z',
      to: '2026-11-20T00:00:00.000Z',
    });
  });

  it('at most 93 days; a window comes only from a submitted URL', () => {
    // 20 Aug to 20 Nov with both days included is 93 days: allowed; one day more is not.
    expect(checkWindow('2026-08-19', '2026-11-20')).toBe('tooLong');
    expect(checkWindow('2026-08-20', '2026-11-20')).toBeNull();
    expect(windowFromParams(new URLSearchParams(''))).toBeNull();
    expect(windowFromParams(new URLSearchParams('window=30'))).toEqual({ kind: 'preset', preset: '30' });
    expect(windowFromParams(new URLSearchParams('window=12'))).toBeNull();
  });
});

describe('Audit log page (AC13.T1)', () => {
  it('searches only on Search, with exact filters; entries show actor type, change, reason and entity', async () => {
    const { transport, calls } = scriptedTransport({
      'admin.audit_search': () =>
        page([
          entry(),
          entry({
            id: '0193a3c4-5d6e-7f80-9a1b-0000000000e2',
            actor_type: 'system',
            actor_display: 'CarPal',
            entity_type: 'user_account',
            entity_id: USER,
            reason: null,
            previous_state_summary: null,
            new_state_summary: null,
            action: 'user.status_changed',
          }),
        ]),
    });
    renderConsole(<AuditPage />, { transport, roles: ['ADM'] });
    expect(screen.getByText(/append-only/)).toBeInTheDocument();
    expect(screen.getByTestId('audit-idle')).toBeInTheDocument();
    const form = screen.getByTestId('audit-search');
    fireEvent.change(within(form).getByLabelText('Entity type'), { target: { value: 'feature_flag' } });
    fireEvent.change(within(form).getByLabelText('Entity ID'), { target: { value: 'not-an-id' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Search' }));
    expect(within(form).getByText(/Enter a full ID/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    fireEvent.change(within(form).getByLabelText('Entity ID'), { target: { value: FLAG } });
    fireEvent.change(within(form).getByLabelText('Time'), { target: { value: '30' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Search' }));
    // The search is in the URL (Back repeats it).
    expect(nav.pushed.at(-1)).toMatch(
      /^\/audit\?entity_type=feature_flag&entity_id=0193a3c4-5d6e-7f80-9a1b-00000000f1a9&window=30&at=\d+$/,
    );
    const results = await screen.findByTestId('audit-results');
    await waitFor(() => expect(results.querySelectorAll('tbody tr')).toHaveLength(2));
    const body = calls[0]!.body as Record<string, string | number>;
    expect(body).toMatchObject({ entity_type: 'feature_flag', entity_id: FLAG, limit: 50 });
    expect(body).not.toHaveProperty('action');
    expect(Date.parse(String(body.to)) - Date.parse(String(body.from))).toBe(30 * 86_400_000);
    const [first, second] = [...results.querySelectorAll('tbody tr')];
    expect(first).toHaveTextContent('Sara Admin (staff)');
    expect(first).toHaveTextContent('admin.flag_updated');
    expect(first).toHaveTextContent('off');
    expect(first).toHaveTextContent('Incident response');
    expect(second).toHaveTextContent('CarPal (system)');
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      resetNav(`/audit?entity_type=feature_flag&window=7&at=${Date.now()}`);
      const { transport } = scriptedTransport({ 'admin.audit_search': () => page([entry()]) });
      renderConsole(<AuditPage />, { transport, roles: ['ADM'], locale });
      const results = await screen.findByTestId('audit-results');
      await waitFor(() => expect(results.querySelectorAll('tbody tr')).toHaveLength(1));
      expect(await axeViolations()).toEqual([]);
    });
  }
});
