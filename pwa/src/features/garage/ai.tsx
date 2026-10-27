'use client';
// AI helpers of the garage (Docs/21 C-GARAGE-02/05 "AI suggestion" labels; BA-02, GD-13): maintenance tips for the
// car (ai.vehicle_suggestions, kind maintenance_suggestion) on the Overview and a summary of the service history
// (ai.service_history_insights) on the History tab. Both run on request — a 202 Job polled through jobs.get, then
// ai.insight_get — and are clearly labelled as AI with what they are based on. With the AI off (503 AI_UNAVAILABLE,
// the expected pilot state) the card says so and everything else keeps working; a flag that is off hides the card.
// A tip becomes a reminder only when the user adds it (human approval, SEC-AI-3).
import type {
  AiInsight,
  InsightPayload_maintenance_suggestion,
  InsightPayload_service_history_summary,
  Job,
  Vehicle,
} from '@carpal/api-contracts';
import { useState, type ReactNode } from 'react';
import { Badge } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import { StateView, stateFromProblem, type StateKind } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { useApiClient } from '@/lib/api/query';
import type { ApiClient } from '@/lib/api/client';
import { useFlag } from '@/lib/config/client';
import { addDaysIso, todayIso } from '@/lib/format/jalali';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { useRefresh } from './hooks';
import { useNodeNames } from './names';

type AiState = { s: 'idle' } | { s: 'running' } | { s: 'done'; insight: AiInsight } | { s: 'off'; kind: StateKind } | { s: 'failed' };

const JOB_TIMEOUT_MS = 60_000;

async function runInsight(api: ApiClient, start: () => Promise<Job>): Promise<AiInsight | null> {
  let job = await start();
  const started = Date.now();
  while ((job.status === 'queued' || job.status === 'running') && Date.now() - started < JOB_TIMEOUT_MS) {
    const res = await api.call('jobs.get', { path: { job_id: job.id } });
    job = res.data;
    if (job.status === 'queued' || job.status === 'running') await new Promise((r) => setTimeout(r, res.pollAfterMs ?? 1_000));
  }
  if (job.status !== 'succeeded' || job.result?.type !== 'ai_insight') return null;
  return api.api('ai.insight_get', { path: { insight_id: job.result.id } });
}

function useAi(start: (api: ApiClient) => Promise<Job>) {
  const api = useApiClient();
  const [state, setState] = useState<AiState>({ s: 'idle' });
  const run = async () => {
    setState({ s: 'running' });
    try {
      const insight = await runInsight(api, () => start(api));
      setState(insight ? { s: 'done', insight } : { s: 'failed' });
    } catch (err) {
      const kind = stateFromProblem(err);
      setState(kind === 'aiOff' || kind === 'featureOff' || kind === 'rateLimited' ? { s: 'off', kind } : { s: 'failed' });
    }
  };
  return { state, run };
}

function AiCard({
  title,
  basis,
  state,
  onRun,
  runLabel,
  children,
}: {
  title: string;
  basis: string;
  state: AiState;
  onRun: () => void;
  runLabel: string;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <section className="pwa-ai-card" aria-labelledby={`ai-${runLabel}`} data-ai-state={state.s}>
      <div className="pwa-ai-head">
        <h3 id={`ai-${runLabel}`} className="pwa-section-title">
          {title}
        </h3>
        <Badge tone="accent" icon="spark">
          {t('garage.ai.label')}
        </Badge>
      </div>
      {state.s === 'off' ? (
        <StateView kind={state.kind} t={t} text={state.kind === 'aiOff' ? t('garage.ai.offText') : undefined} compact headingLevel={3} />
      ) : null}
      {state.s === 'failed' ? <p className="pwa-text-caption">{t('garage.ai.failed')}</p> : null}
      {state.s === 'done' ? (
        <>
          {children}
          <p className="pwa-text-caption">{basis}</p>
        </>
      ) : null}
      {state.s !== 'done' && state.s !== 'off' ? (
        <div>
          <Button size="sm" variant="secondary" icon="spark" loading={state.s === 'running'} onClick={onRun}>
            {state.s === 'failed' ? t('common.actions.retry') : runLabel}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** Overview: maintenance tips for this car, each one addable as a reminder. */
export function VehicleAiTips({ vehicle: v }: { vehicle: Vehicle }) {
  const t = useT();
  const on = useFlag('ai.vehicle_helper.enabled');
  const { state, run } = useAi((api) =>
    api.api('ai.vehicle_suggestions', { path: { vehicle_id: v.id }, body: { kinds: ['maintenance_suggestion'] } }),
  );
  if (!on) return null;
  const payload = state.s === 'done' ? (state.insight.structured_payload as InsightPayload_maintenance_suggestion | null) : null;
  return (
    <AiCard
      title={t('garage.ai.tipsTitle')}
      basis={t('garage.ai.tipsBasis')}
      state={state}
      onRun={() => void run()}
      runLabel={t('garage.ai.tipsRun')}
    >
      {state.s === 'done' ? (
        <p className="pwa-text-body" dir="auto">
          {state.insight.summary}
        </p>
      ) : null}
      {payload?.checks?.length ? (
        <ul className="pwa-plain-list">
          {payload.checks.map((c, i) => (
            <AiCheck key={i} vehicleId={v.id} check={c} />
          ))}
        </ul>
      ) : null}
    </AiCard>
  );
}

function AiCheck({ vehicleId, check }: { vehicleId: string; check: InsightPayload_maintenance_suggestion['checks'][number] }) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useRefresh();
  const [state, setState] = useState<'idle' | 'busy' | 'added' | 'failed'>('idle');
  const due = addDaysIso(todayIso(f.timeZone), Math.max(1, check.due_in_days));
  const add = async () => {
    setState('busy');
    try {
      await api.api('reminders.create', {
        path: { vehicle_id: vehicleId },
        body: {
          reminder_type: check.reminder_type,
          title: check.title.slice(0, 120),
          reason: check.reason.slice(0, 500),
          due_by_date: due,
          priority: 'medium',
        },
      });
      await refresh('reminders.list', 'vehicles.get');
      setState('added');
      toast(t('garage.ai.reminderAdded'));
    } catch {
      setState('failed');
    }
  };
  return (
    <li className="pwa-row">
      <span className="flex-1" dir="auto">
        <span className="pwa-choice-title">{check.title}</span>
        <span className="pwa-text-caption">
          {check.reason} · {f.calendarDate(due)}
        </span>
      </span>
      {state === 'added' ? (
        <Badge tone="success" icon="check">
          {t('garage.ai.added')}
        </Badge>
      ) : (
        <Button size="sm" variant="ghost" icon="plus" loading={state === 'busy'} onClick={() => void add()}>
          {t('garage.ai.addReminder')}
        </Button>
      )}
    </li>
  );
}

/** History tab: what the AI sees in the history (recurring repairs, possible duplicates, next maintenance). */
export function HistoryAiSummary({ vehicle: v }: { vehicle: Vehicle }) {
  const t = useT();
  const f = useFormat();
  const on = useFlag('ai.service_history.enabled');
  const systems = useNodeNames('service_system');
  const { state, run } = useAi((api) => api.api('ai.service_history_insights', { path: { vehicle_id: v.id } }));
  if (!on) return null;
  const p = state.s === 'done' ? (state.insight.structured_payload as InsightPayload_service_history_summary | null) : null;
  return (
    <AiCard
      title={t('garage.ai.historyTitle')}
      basis={t('garage.ai.historyBasis')}
      state={state}
      onRun={() => void run()}
      runLabel={t('garage.ai.historyRun')}
    >
      {state.s === 'done' ? (
        <p className="pwa-text-body" dir="auto">
          {state.insight.summary}
        </p>
      ) : null}
      {p ? (
        <ul className="pwa-bullets">
          <li>{t('garage.ai.recordCount', { count: p.record_count })}</li>
          {p.last_service_date ? <li>{t('garage.ai.lastService', { date: f.calendarDate(p.last_service_date) })}</li> : null}
          {p.recurring_system_node_ids.length ? (
            <li>
              {t('garage.ai.recurring', {
                names: p.recurring_system_node_ids.map((id) => systems.name(id) ?? '—').join(f.locale === 'fa' ? '، ' : ', '),
              })}
            </li>
          ) : null}
          {p.duplicate_record_ids.length ? <li>{t('garage.ai.duplicates', { count: p.duplicate_record_ids.length })}</li> : null}
          {p.next_maintenance ? <li dir="auto">{t('garage.ai.next', { text: p.next_maintenance })}</li> : null}
        </ul>
      ) : null}
    </AiCard>
  );
}
