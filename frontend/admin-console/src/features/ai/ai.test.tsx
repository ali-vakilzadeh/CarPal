// AC13.T4 tests of AI oversight: the oversight numbers and alerts from the ai_quality dashboard, the kill switch state
// for administrators only, and the read-only insight list (the last 7 days on open, a deep link to one insight by
// organization and day, its detail); axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureFlag } from '@carpal/api-contracts';
import { axeViolations, page, renderConsole, scriptedTransport, type Handler } from '../../../tests/support/console-harness';
import { resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { aiAlerts, aiNumbers, type InsightRow } from './ai-logic';
import { AiPage } from './ai-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const TODAY = new Date().toISOString().slice(0, 10);
const ORG = '0193a3c4-5d6e-7f80-9a1b-0000000000a1';
const m = (metric_key: string, value: string, withRow = true) => ({
  metric_key,
  value,
  unit: 'count',
  series: withRow ? [{ date: TODAY, value }] : [],
});

const aiQuality: Handler = (req) => {
  const sp = new URLSearchParams(req.search);
  return Response.json({
    key: 'ai_quality',
    from: sp.get('from'),
    to: sp.get('to'),
    metrics: [
      m('events.ai.insight.generated', '40'),
      m('events.search.started', '9'),
      m('gauge.ai_suggestions_pending', '5'),
      m('gauge.ai_feedback_accepted', '3'),
      m('gauge.ai_feedback_rejected', '9'),
      m('gauge.ai_hallucination_reports', '2'),
    ],
  });
};

const kill = (enabled: boolean): FeatureFlag => ({
  id: '0193a3c4-5d6e-7f80-9a1b-0000000000f9',
  key: 'ai.automation.kill_switch',
  description: null,
  flag_type: 'kill_switch',
  enabled,
  targeting: null,
  environment: 'dev',
  updated_by_display: 'Sara Admin',
  updated_at: new Date().toISOString(),
  version: 2,
});

const insight = (o: Partial<InsightRow> = {}): InsightRow => ({
  id: '0193a3c4-5d6e-7f80-9a1b-0000000001b0',
  insight_type: 'triage_summary',
  subject: { type: 'vehicle', id: '0193a3c4-5d6e-7f80-9a1b-0000000000ve' },
  locale: 'fa',
  confidence_score: 72,
  summary: 'Front suspension noise; inspect within a week.',
  structured_payload: { urgency: 'medium' } as never,
  evidence_references: [{ type: 'service_record', id: '0193a3c4-5d6e-7f80-9a1b-0000000000sr' }],
  safety_flags: ['safety_critical'],
  visibility: 'owner_only',
  human_approval_status: 'not_required',
  model_version: 'stub-1',
  created_at: new Date().toISOString(),
  expires_at: null,
  organization_id: ORG,
  ...o,
});

beforeEach(() => resetNav('/ai'));
afterEach(() => vi.unstubAllGlobals());

describe('AI oversight rules (AC13.T4)', () => {
  it('acceptance from the feedback gauges; alerts for hallucinations and a low acceptance rate', () => {
    const n = aiNumbers([
      m('events.ai.insight.generated', '40'),
      m('gauge.ai_feedback_accepted', '3'),
      m('gauge.ai_feedback_rejected', '9'),
      m('gauge.ai_hallucination_reports', '2'),
    ]);
    expect(n).toMatchObject({ generated: 40, accepted: 3, rejected: 9, acceptance: 0.25, hallucinations: 2, pending: null });
    expect(aiAlerts(n)).toEqual([
      { kind: 'hallucinations', n: 2 },
      { kind: 'acceptance', rate: 0.25 },
    ]);
    // Too few answers to judge the rate; no gauge rows → unknown, not 0.
    expect(aiAlerts(aiNumbers([m('gauge.ai_feedback_accepted', '1'), m('gauge.ai_feedback_rejected', '3')]))).toEqual([]);
    expect(aiNumbers([m('gauge.ai_feedback_accepted', '0', false)]).accepted).toBeNull();
  });
});

describe('AI oversight page (AC13.T4)', () => {
  it('ADM: kill switch state, alerts with examples, numbers and charts', async () => {
    const { transport } = scriptedTransport({ 'admin.analytics_dashboard': aiQuality, 'admin.flags_list': () => page([kill(true)]) });
    renderConsole(<AiPage />, { transport, roles: ['ADM'] });
    const overview = await screen.findByTestId('ai-overview');
    await waitFor(() => expect(within(overview).getByTestId('ai-kill')).toHaveAttribute('data-state', 'on'));
    expect(within(overview).getByTestId('ai-kill')).toHaveTextContent('AI automation OFF');
    const alerts = await within(overview).findByTestId('ai-alerts');
    expect(within(alerts).getByText('2 hallucination reports')).toBeInTheDocument();
    expect(within(alerts).getByText(/Acceptance rate 25 %/)).toBeInTheDocument();
    expect(within(alerts).getAllByRole('link', { name: 'See examples' })[0]).toHaveAttribute(
      'href',
      '/ai?tab=insights&feedback=hallucination_report&window=30',
    );
    expect(overview.querySelectorAll('figure.adm-chart')).toHaveLength(6);
  });

  it('MOD: no flags read; the kill switch note instead', async () => {
    const { transport, calls } = scriptedTransport({ 'admin.analytics_dashboard': aiQuality });
    renderConsole(<AiPage />, { transport, roles: ['MOD'] });
    expect(await screen.findByText('The kill switch state is visible to platform admins.')).toBeInTheDocument();
    await screen.findByTestId('ai-stats');
    expect(calls.some((c) => c.opId === 'admin.flags_list')).toBe(false);
  });

  it('insights: the last 7 days on open; a deep link opens one insight read-only', async () => {
    const { transport, calls } = scriptedTransport({ 'admin.ai_insights_search': () => page([insight()]) });
    resetNav(`/ai?tab=insights&insight=${insight().id}&from=${TODAY}&to=${TODAY}&org=${ORG}`);
    renderConsole(<AiPage />, { transport, roles: ['MOD'] });
    const detail = await screen.findByTestId('ai-insight');
    expect(detail).toHaveTextContent('Front suspension noise');
    expect(detail).toHaveTextContent('Safety critical');
    expect(within(detail).getByText('Structured output')).toBeInTheDocument();
    // Moderators cannot read the MCP log: no link.
    expect(within(detail).queryByRole('link', { name: 'MCP access log of that day' })).toBeNull();
    const body = calls[0]!.body as Record<string, string>;
    expect(body.organization_id).toBe(ORG);
    expect(Date.parse(body.to!) - Date.parse(body.from!)).toBe(86_400_000);
    expect(screen.getByText(/arrive with the AI build/, { selector: '.adm-muted' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark/ })).toBeNull();

    resetNav('/ai?tab=insights');
    await waitFor(() => expect(calls).toHaveLength(2));
    const open = calls[1]!.body as Record<string, string>;
    expect(Date.parse(open.to!) - Date.parse(open.from!)).toBe(7 * 86_400_000);
    expect(open).not.toHaveProperty('organization_id');
    fireEvent.change(screen.getByLabelText('User feedback'), { target: { value: 'hallucination_report' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]!.body).toMatchObject({ has_feedback: 'hallucination_report' });
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      const { transport } = scriptedTransport({
        'admin.analytics_dashboard': aiQuality,
        'admin.flags_list': () => page([kill(false)]),
        'admin.ai_insights_search': () => page([insight()]),
      });
      renderConsole(<AiPage />, { transport, roles: ['ADM'], locale });
      await screen.findByTestId('ai-stats');
      expect(await axeViolations()).toEqual([]);
      resetNav(`/ai?tab=insights&insight=${insight().id}`);
      await screen.findByTestId('ai-insight');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
