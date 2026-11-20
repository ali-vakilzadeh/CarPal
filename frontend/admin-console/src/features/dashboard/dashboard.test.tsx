// AC13.T6 DOM tests of the console home (A-DASH-01): the queue tiles from admin.work_summary (server SLA buckets, the
// recoveries tile from its list, unknown queues), My work, the metric widgets and System, a widget that fails on its
// own with Retry, role filtering (CRV sees only its work), and axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkQueueSummary } from '@carpal/api-contracts';
import { axeViolations, page, problem, renderConsole, scriptedTransport, type Handler } from '../../../tests/support/console-harness';
import { resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { Dashboard } from './dashboard';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const H = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * H).toISOString();
const soon = (h: number) => new Date(Date.now() + h * H).toISOString();
const uuid = (n: number) => `0193a3c4-5d6e-7f80-9a1b-${String(n).padStart(12, '0')}`;

function q(queue: string, o: Partial<WorkQueueSummary> = {}): WorkQueueSummary {
  return {
    queue: queue as WorkQueueSummary['queue'],
    open: 0,
    assigned_to_me: null,
    oldest_at: null,
    next_due_at: null,
    sla: null,
    breakdown: [],
    ...o,
  };
}
const summary =
  (items: WorkQueueSummary[]): Handler =>
  () =>
    Response.json({ generated_at: new Date().toISOString(), time_zone: 'Asia/Tehran', items });

const DASH: Record<string, Record<string, string>> = {
  growth: { 'events.user.registered': '12', 'events.provider.profile.published': '2' },
  activation: { 'events.vehicle.created': '7' },
  provider_value: { 'events.appointment.requested': '5', 'events.appointment.completed': '3' },
  reviews: { 'events.review.published': '4', 'events.review.approval.requested': '1' },
  trust: { 'events.review.published': '4', 'events.dispute.opened': '1' },
  moderation_load: {},
  ai_quality: {
    'events.ai.insight.generated': '30',
    'gauge.ai_feedback_accepted': '8',
    'gauge.ai_feedback_rejected': '2',
    'gauge.ai_hallucination_reports': '1',
  },
};
const dashboards: Handler = (req) => {
  const key = req.path.split('/').pop()!;
  const today = new Date().toISOString().slice(0, 10);
  const metrics = Object.entries(DASH[key] ?? {}).map(([metric_key, value]) => ({
    metric_key,
    value,
    unit: 'count',
    series: [{ date: today, value }],
  }));
  return Response.json({ key, from: today, to: today, metrics });
};
const health: Handler = () =>
  Response.json({
    generated_at: new Date().toISOString(),
    signals: [
      { key: 'import_failures', last_24h: 2, last_7d: 3, last_30d: 3, last_failure_at: ago(1) },
      { key: 'notification_delivery_failures', last_24h: 0, last_7d: 0, last_30d: 0, last_failure_at: null },
      { key: 'media_scan_failures', last_24h: 0, last_7d: 1, last_30d: 1, last_failure_at: ago(48) },
    ],
    sms_provider: 'mock',
    sms_simulated: true,
    mail_transport: 'file',
    geocoder: { provider: 'fixture', requests_today: null, requests_30d: null },
  });
const killSwitch: Handler = () =>
  page([
    {
      id: uuid(9),
      key: 'ai.automation.kill_switch',
      enabled: false,
      flag_type: 'kill_switch',
      targeting: null,
      environment: 'dev',
      description: null,
      updated_by_display: 'A',
      updated_at: ago(1),
      version: 1,
    },
  ]);

beforeEach(() => resetNav('/'));
afterEach(() => vi.unstubAllGlobals());

describe('Dashboard (AC13.T6)', () => {
  it('ADM: queue tiles from the work summary, recoveries from their list, My work, metric widgets and System', async () => {
    const { transport, calls } = scriptedTransport({
      'admin.work_summary': summary([
        q('four_eyes', { open: 2, oldest_at: ago(68), sla: { ok: 1, warn: 1, breach: 0, paused: 0 } }),
        q('verifications', { open: 3, assigned_to_me: 1, oldest_at: ago(80), sla: { ok: 1, warn: 0, breach: 2, paused: 0 } }),
        q('cases', {
          open: 4,
          assigned_to_me: 2,
          oldest_at: ago(5),
          sla: { ok: 4, warn: 0, breach: 0, paused: 0 },
          breakdown: [
            { key: 'reason:unsafe_advice', open: 1 },
            { key: 'severity:critical', open: 2 },
          ],
        }),
        q('support_tickets', { open: 1, oldest_at: ago(2), sla: { ok: 1, warn: 0, breach: 0, paused: 0 } }),
        q('brand_new_queue', { open: 9 }),
      ]),
      'admin.four_eyes_list': () =>
        page([
          {
            change_id: uuid(1),
            op_id: 'admin.mcp_client_update',
            summary: 'MCP client admin_copilot: allowed_tools (1)',
            requested_by_display: 'Reza Admin',
            requested_at: ago(2),
            reason: 'least_privilege: drop a tool',
            status: 'pending',
            expires_at: soon(4),
          },
        ]),
      'admin.staff_recoveries_list': () => page([]),
      'admin.analytics_dashboard': dashboards,
      'admin.system_health': health,
      'admin.flags_list': killSwitch,
    });
    renderConsole(<Dashboard />, { transport, roles: ['ADM'] });
    const queues = await screen.findByRole('region', { name: 'Queues' });
    await waitFor(() => expect(queues.querySelectorAll('[data-queue]')).toHaveLength(6));
    const tiles = [...queues.querySelectorAll<HTMLElement>('[data-queue]')];
    expect(tiles.map((t) => t.getAttribute('data-queue'))).toEqual([
      'approvals',
      'verification',
      'cases',
      'support',
      'brand_new_queue',
      'recoveries',
    ]);
    // Server buckets: two items past their target → red with "2 overdue".
    expect(tiles[1]).toHaveAttribute('data-sla', 'breach');
    expect(within(tiles[1]!).getByText('2 overdue')).toBeInTheDocument();
    expect(within(tiles[1]!).getByText('1 assigned to you')).toBeInTheDocument();
    expect(tiles[1]).toHaveAttribute('href', '/verification');
    // The support queue opens the support inbox (AC14.T5); an unknown key says so.
    expect(tiles[3]).toHaveAttribute('href', '/support');
    expect(tiles[4]).toHaveTextContent('Unknown (brand_new_queue)');
    await waitFor(() => expect(tiles[5]).toHaveAttribute('data-count', '0'));

    const mine = screen.getByRole('region', { name: 'My work' });
    await waitFor(() => expect(within(mine).getByTestId('mine-assigned')).toHaveTextContent('3'));
    expect(within(mine).getByTestId('mine-approvals')).toHaveTextContent('2');
    // warn 1 (four-eyes) + breach 2 (verification)
    expect(within(mine).getByTestId('mine-at-risk')).toHaveTextContent('3');
    expect(await within(mine).findByRole('link', { name: 'MCP client change' })).toHaveAttribute('href', `/approvals?change=${uuid(1)}`);
    // One page of the pending list only (the count comes from the summary).
    expect(calls.filter((c) => c.opId === 'admin.four_eyes_list')).toHaveLength(1);

    const safety = screen.getByRole('region', { name: 'Safety' });
    expect(within(safety).getByTestId('safety-unsafe')).toHaveTextContent('1');
    expect(within(safety).getByTestId('safety-critical')).toHaveTextContent('2');

    const growth = await screen.findByRole('region', { name: 'Growth' });
    await waitFor(() => expect(within(growth).getByTestId('growth-users')).toHaveTextContent('12'));
    expect(within(growth).getByText('Vehicles added').nextSibling).toHaveTextContent('7');

    const ai = screen.getByRole('region', { name: 'AI' });
    await waitFor(() => expect(within(ai).getByTestId('ai-kill')).toHaveAttribute('data-state', 'off'));
    expect(within(ai).getByText('Acceptance rate').nextSibling).toHaveTextContent('80 %');

    const system = await screen.findByRole('region', { name: 'System' });
    await waitFor(() => expect(within(system).getByTestId('system-sms')).toHaveTextContent('Simulated'));
    expect(within(system).getByTestId('system-mail')).toHaveTextContent("Written to the server's outbox file only");
    expect(system.querySelector('[data-signal="import_failures"]')).toHaveAttribute('data-failing', 'true');
    // Today is the default period: the metric widgets ask for one day.
    const first = calls.find((c) => c.opId === 'admin.analytics_dashboard')!;
    const sp = new URLSearchParams(first.search);
    expect(sp.get('from')).toBe(sp.get('to'));
  });

  it('CRV sees only My work and its queues (no metrics, no system)', async () => {
    const { transport, calls } = scriptedTransport({
      'admin.work_summary': summary([
        q('review_approvals', { open: 1, oldest_at: ago(3), sla: { ok: 1, warn: 0, breach: 0, paused: 0 } }),
        q('disputes'),
      ]),
    });
    renderConsole(<Dashboard />, { transport, roles: ['CRV'] });
    const queues = await screen.findByRole('region', { name: 'Queues' });
    await waitFor(() =>
      expect([...queues.querySelectorAll('[data-queue]')].map((t) => t.getAttribute('data-queue'))).toEqual(['reviewApproval', 'disputes']),
    );
    expect(screen.queryByTestId('work-approvals')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Growth' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'System' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Safety' })).toBeNull();
    expect(calls.map((c) => c.opId).filter((x) => x !== 'admin.work_summary')).toEqual([]);
  });

  it('a widget that fails says so with Retry while the others keep working', async () => {
    let fail = true;
    const { transport } = scriptedTransport({
      'admin.work_summary': summary([q('reports'), q('privacy_requests')]),
      'admin.analytics_dashboard': dashboards,
      // A 500 (a 503 would pause the operation for 30 s after three tries, SEC-RL-4).
      'admin.system_health': (req, body) => (fail ? problem(500, 'INTERNAL') : health(req, body)),
    });
    renderConsole(<Dashboard />, { transport, roles: ['SUP'] });
    const system = await screen.findByRole('region', { name: 'System' });
    const retry = await within(system).findByRole('button', { name: 'Try again' });
    expect(system).toHaveAttribute('data-state', 'error');
    await waitFor(() => expect(screen.getByRole('region', { name: 'Growth' })).toHaveAttribute('data-state', 'ready'));
    expect(screen.getByRole('region', { name: 'Queues' })).toHaveAttribute('data-state', 'ready');
    fail = false;
    fireEvent.click(retry);
    await waitFor(() => expect(system).toHaveAttribute('data-state', 'ready'));
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      const { transport } = scriptedTransport({
        'admin.work_summary': summary([
          q('four_eyes'),
          q('verifications', { open: 1, oldest_at: ago(3), sla: { ok: 1, warn: 0, breach: 0, paused: 0 } }),
          q('reports'),
          q('cases'),
        ]),
        'admin.four_eyes_list': () => page([]),
        'admin.analytics_dashboard': dashboards,
        'admin.system_health': health,
      });
      renderConsole(<Dashboard />, { transport, roles: ['MOD'], locale });
      await waitFor(() => expect(document.querySelectorAll('[data-widget][data-state="ready"]')).toHaveLength(7));
      expect(await axeViolations()).toEqual([]);
    });
  }
});
