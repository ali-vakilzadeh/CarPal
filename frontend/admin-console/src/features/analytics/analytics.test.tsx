// AC13.T5 tests of Analytics: the period rules (the viewer's day, presets, typed days at most 366), the daily series
// (counts fill gaps with 0, gauges leave them unknown), clean axis ticks; the page renders every dashboard key with
// real numbers or a clear empty state, a chart reads by keyboard and has its table, and axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axeViolations, renderConsole, scriptedTransport, type Handler } from '../../../tests/support/console-harness';
import { resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { checkRange, dailySeries, dayIn, DASHBOARD_KEYS, metricLabel, niceTicks, presetRange } from './analytics-logic';
import { AnalyticsPage } from './analytics-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

describe('analytics rules', () => {
  it("days are the viewer's: 21:00 UTC is already the next day in Tehran", () => {
    const at = Date.parse('2026-11-19T21:00:00Z');
    expect(dayIn(at, 'Asia/Tehran')).toBe('2026-11-20');
    expect(dayIn(at, 'UTC')).toBe('2026-11-19');
    expect(presetRange('today', at, 'Asia/Tehran')).toEqual({ from: '2026-11-20', to: '2026-11-20' });
    expect(presetRange('7', at, 'Asia/Tehran')).toEqual({ from: '2026-11-14', to: '2026-11-20' });
  });

  it('typed days: both needed, in order, at most 366 days', () => {
    expect(checkRange('2026-11-01', '2026-11-20')).toBeNull();
    expect(checkRange('', '2026-11-20')).toBe('format');
    expect(checkRange('2026-11-21', '2026-11-20')).toBe('order');
    expect(checkRange('2025-01-01', '2026-11-20')).toBe('tooLong');
  });

  it('counts fill missing days with 0; gauges leave them unknown', () => {
    const range = { from: '2026-11-18', to: '2026-11-20' };
    expect(
      dailySeries({ metric_key: 'events.search.started', value: '5', unit: 'count', series: [{ date: '2026-11-19', value: '5' }] }, range),
    ).toEqual([
      { date: '2026-11-18', value: 0 },
      { date: '2026-11-19', value: 5 },
      { date: '2026-11-20', value: 0 },
    ]);
    expect(
      dailySeries({ metric_key: 'gauge.users_active', value: '9', unit: 'count', series: [{ date: '2026-11-19', value: '9' }] }, range).map(
        (p) => p.value,
      ),
    ).toEqual([null, 9, null]);
  });

  it('clean ticks and unknown metric names', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(1234)).toEqual([0, 500, 1000, 1500]);
    const t = ((k: string, o?: Record<string, unknown>) => (o ? `${k}:${String(o.value)}` : k)) as never;
    expect(metricLabel('events.x.new', t)).toBe('admin.kit.unknown:events.x.new');
  });
});

const TODAY = new Date().toISOString().slice(0, 10);
const answer: Handler = (req) => {
  const key = req.path.split('/').pop()!;
  const sp = new URLSearchParams(req.search);
  // activation has numbers; fleet_value has none (empty state); the rest one count each.
  const metrics =
    key === 'activation'
      ? [
          { metric_key: 'events.user.registered', value: '14', unit: 'count', series: [{ date: TODAY, value: '14' }] },
          { metric_key: 'events.vehicle.created', value: '0', unit: 'count', series: [] },
          { metric_key: 'gauge.users_active', value: '120', unit: 'count', series: [{ date: TODAY, value: '120' }] },
        ]
      : key === 'fleet_value'
        ? [
            { metric_key: 'events.fleet.approval.requested', value: '0', unit: 'count', series: [] },
            { metric_key: 'gauge.fleets_active', value: '0', unit: 'count', series: [] },
          ]
        : [{ metric_key: 'events.search.started', value: '3', unit: 'count', series: [{ date: TODAY, value: '3' }] }];
  return Response.json({ key, from: sp.get('from'), to: sp.get('to'), metrics });
};

beforeEach(() => resetNav('/analytics'));
afterEach(() => vi.unstubAllGlobals());

describe('Analytics page (AC13.T5)', () => {
  it('every dashboard key opens with its numbers or a clear empty state', async () => {
    const { transport, calls } = scriptedTransport({ 'admin.analytics_dashboard': answer });
    renderConsole(<AnalyticsPage />, { transport, roles: ['SUP'] });
    const nav = screen.getByRole('navigation', { name: 'Dashboards' });
    expect(within(nav).getAllByRole('link')).toHaveLength(DASHBOARD_KEYS.length);
    const view = await screen.findByTestId('dashboard-view');
    await waitFor(() => expect(view).toHaveAttribute('data-state', 'ready'));
    expect(view).toHaveAttribute('data-dashboard', 'activation');
    // Counts add up; a gauge shows its latest day; a count of 0 is an empty chart, not a zero bar.
    const users = view.querySelector('[data-metric="events.user.registered"]')!;
    expect(users).toHaveTextContent('Total 14');
    expect(view.querySelector('[data-metric="gauge.users_active"]')).toHaveTextContent('120 as of');
    expect(view.querySelector('[data-metric="events.vehicle.created"]')).toHaveAttribute('data-state', 'empty');
    // 30 days by default, ending today on the viewer's clock.
    const sp = new URLSearchParams(calls[0]!.search);
    expect(sp.get('to')).toBe(dayIn(Date.now(), 'Asia/Tehran'));

    // Every key of the contract: numbers or the empty note, never an error.
    for (const key of DASHBOARD_KEYS) {
      fireEvent.click(nav.querySelector(`[data-dashboard="${key}"]`)!);
      await waitFor(() => expect(screen.getByTestId('dashboard-view')).toHaveAttribute('data-dashboard', key));
      await waitFor(() => expect(screen.getByTestId('dashboard-view')).toHaveAttribute('data-state', 'ready'));
      expect(nav.querySelector(`[data-dashboard="${key}"]`)).toHaveAttribute('aria-current', 'page');
    }
    expect(new Set(calls.map((c) => c.path.split('/').pop())).size).toBe(DASHBOARD_KEYS.length);
  });

  it('a dashboard without data says so', async () => {
    resetNav('/analytics?dashboard=fleet_value');
    const { transport } = scriptedTransport({ 'admin.analytics_dashboard': answer });
    renderConsole(<AnalyticsPage />, { transport, roles: ['ADM'] });
    expect(await screen.findByText(/No data in this period yet/)).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-view')).toHaveAttribute('data-dashboard', 'fleet_value');
  });

  it('a chart reads by keyboard and keeps its numbers in a table', async () => {
    resetNav('/analytics?range=7');
    const { transport, calls } = scriptedTransport({ 'admin.analytics_dashboard': answer });
    renderConsole(<AnalyticsPage />, { transport, roles: ['ADM'] });
    const chart = await screen.findByRole('img', { name: /New users, daily from/ });
    fireEvent.focus(chart);
    // The last day first; the tooltip names the value.
    await waitFor(() => expect(chart.querySelector('.adm-chart-tip')).toHaveTextContent('14'));
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(chart.querySelector('.adm-chart-tip')).toHaveTextContent('0');
    const figure = chart.closest('figure')!;
    expect(within(figure).getAllByRole('row')).toHaveLength(8);
    const sp = new URLSearchParams(calls[0]!.search);
    expect(sp.get('from')).not.toBe(sp.get('to'));
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      const { transport } = scriptedTransport({ 'admin.analytics_dashboard': answer });
      renderConsole(<AnalyticsPage />, { transport, roles: ['MOD'], locale });
      await waitFor(() => expect(screen.getByTestId('dashboard-view')).toHaveAttribute('data-state', 'ready'));
      expect(await axeViolations()).toEqual([]);
    });
  }
});
