'use client';
// Plans and entitlements (AC6.T3/T4, Docs/23 A-PLAN-01, Docs/40 §10.1 and §23.2, MVP manual billing). The rule that
// plans and payment never change organic ranking (MVP Rule 2) is on screen. Plans: every plan with its limits and
// entitlements; an edit changes entitlements (or the plan's status) for every subscriber, so it waits for a second
// platform admin (4EYES) and the requester sees the four-eyes banner. History: the plan's audit trail (Shift+H; the
// contract has no plan history read, Docs/23 "History" tab). Assignments: the form that assigns a plan, starts a
// trial or sets overrides for one subscriber (assign-form.tsx); the contract has no list of assignments.
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { EntitlementKey, Plan } from '@carpal/api-contracts';
import { ActionNotice, AuditDrawer, CaseLayout, DataTable, ReasonDialog, useAdminAction, type Column } from '@/components/admin';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { TextField } from '@/components/ds/text-field';
import { useApiQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { AssignForm } from './assign-form';
import {
  audienceLabel,
  changedEntitlements,
  draftsOf,
  entitlementLabel,
  limitText,
  valueText,
  type EntDraft,
  type EntDrafts,
} from './plan-logic';
import { planLabel } from '@/lib/config/plans';

const LIST_KEY = ['admin.plans_list'] as const;

export function PlansPage() {
  const t = useT();
  const f = useFormat();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const list = useApiQuery('admin.plans_list', undefined);
  const plans = list.data?.items;
  const selected = plans?.find((p) => p.id === params.get('plan')) ?? null;
  const select = (plan: Plan) => {
    const p = new URLSearchParams(params);
    p.set('plan', plan.id);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };
  const n = (x: number) => f.number(x);

  const columns: Column<Plan>[] = [
    { id: 'plan', header: t('admin.plans.col.plan'), pinned: true, cell: (p) => planLabel(p.plan_key, t) },
    { id: 'audience', header: t('admin.plans.col.audience'), cell: (p) => audienceLabel(p.audience, t) },
    { id: 'vehicles', header: t('admin.plans.col.vehicles'), align: 'end', cell: (p) => limitText(p.max_vehicles, t, n) },
    { id: 'users', header: t('admin.plans.col.users'), align: 'end', cell: (p) => limitText(p.max_users, t, n) },
    {
      id: 'trial',
      header: t('admin.plans.col.trial'),
      align: 'end',
      cell: (p) => (p.trial_days ? t('admin.plans.days', { n: f.number(p.trial_days) }) : '—'),
    },
    { id: 'key', header: t('admin.plans.col.key'), defaultHidden: true, cell: (p) => <bdi dir="ltr">{p.plan_key}</bdi> },
  ];

  return (
    <div className="adm-page" data-testid="plans-page">
      <h1 className="adm-page-title">{t('admin.plans.title')}</h1>
      <div data-testid="ranking-rule">
        <Banner tone="info" icon="shield" title={t('admin.plans.rule.title')} text={t('admin.plans.rule.text')} />
      </div>
      <h2 className="adm-section-title">{t('admin.plans.plansTitle')}</h2>
      <CaseLayout
        labels={{ list: t('admin.plans.listLabel'), item: t('admin.plans.itemLabel'), decision: t('admin.plans.historyLabel') }}
        list={
          <DataTable
            id="plans"
            caption={t('admin.plans.listLabel')}
            columns={columns}
            rows={plans}
            rowKey={(p) => p.id}
            loading={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            emptyText={t('admin.plans.empty')}
            selectedKey={selected?.id ?? null}
            onSelect={select}
          />
        }
        item={selected ? <PlanEditor key={selected.id} plan={selected} /> : <p className="adm-muted">{t('admin.plans.pick')}</p>}
        decision={
          selected ? (
            <>
              <h2 className="adm-panel-title">{t('admin.plans.historyLabel')}</h2>
              <p className="adm-muted">{t('admin.plans.historyHint')}</p>
              <AuditDrawer entityType="plan" entityId={selected.id} label={planLabel(selected.plan_key, t)} />
            </>
          ) : (
            <p className="adm-muted">{t('admin.plans.pickFirst')}</p>
          )
        }
      />
      <h2 className="adm-section-title" id="assign">
        {t('admin.plans.assign.title')}
      </h2>
      <AssignForm plans={plans} />
    </div>
  );
}

function PlanEditor({ plan }: { plan: Plan }) {
  const t = useT();
  const f = useFormat();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<EntDrafts>(() => draftsOf(plan.entitlements));
  const [status, setStatus] = useState<'' | 'active' | 'inactive'>('');
  const [tried, setTried] = useState(false);
  const [dialog, setDialog] = useState(false);
  const action = useAdminAction('admin.plan_update', {
    target: plan.plan_key,
    onOutcome: () => void queryClient.invalidateQueries({ queryKey: LIST_KEY }),
  });
  const busy = action.state.status === 'busy';
  const result = changedEntitlements(plan, drafts);
  const changes = 'changes' in result ? result.changes : [];
  const invalid = 'invalid' in result ? result.invalid : [];
  const nothing = changes.length === 0 && status === '' && invalid.length === 0;
  const n = (x: number) => f.number(x);
  const set = (key: EntitlementKey, d: EntDraft) => setDrafts((all) => ({ ...all, [key]: d }));

  const submit = (reason: string) => {
    setDialog(false);
    void action.run({
      path: { plan_id: plan.id },
      body: { entitlements: changes, ...(status ? { status } : {}), reason },
      reason,
    });
  };

  return (
    <article data-testid="plan-editor" data-plan={plan.plan_key}>
      <h2 className="adm-panel-title">{planLabel(plan.plan_key, t)}</h2>
      <dl className="adm-facts">
        <div>
          <dt>{t('admin.plans.col.audience')}</dt>
          <dd>{audienceLabel(plan.audience, t)}</dd>
        </div>
        <div>
          <dt>{t('admin.plans.col.vehicles')}</dt>
          <dd>{limitText(plan.max_vehicles, t, n)}</dd>
        </div>
        <div>
          <dt>{t('admin.plans.col.users')}</dt>
          <dd>{limitText(plan.max_users, t, n)}</dd>
        </div>
        <div>
          <dt>{t('admin.plans.col.trial')}</dt>
          <dd>{plan.trial_days ? t('admin.plans.days', { n: f.number(plan.trial_days) }) : '—'}</dd>
        </div>
      </dl>
      <form
        className="adm-form"
        noValidate
        aria-labelledby="ent-title"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (nothing || invalid.length || busy) return;
          action.reset();
          setDialog(true);
        }}
      >
        <h3 id="ent-title" className="adm-subtitle">
          {t('admin.plans.entTitle')}
        </h3>
        <p className="adm-muted">{t('admin.plans.entIntro')}</p>
        <ul className="adm-ent-list">
          {plan.entitlements.map((e) => {
            const d = drafts[e.key];
            if (!d) return null;
            const label = entitlementLabel(e.key, t);
            return (
              <li key={e.key} data-ent={e.key}>
                {d.kind === 'bool' ? (
                  <Check checked={d.value} onChange={(ev) => set(e.key, { kind: 'bool', value: ev.target.checked })}>
                    {label}
                  </Check>
                ) : (
                  <EntitlementCount
                    label={label}
                    draft={d}
                    error={tried && invalid.includes(e.key)}
                    current={valueText(e.value, t, n)}
                    onChange={(next) => set(e.key, next)}
                  />
                )}
              </li>
            );
          })}
        </ul>
        <div className="cp-field">
          <label className="cp-field-label" htmlFor={`status-${plan.id}`}>
            {t('admin.plans.status.label')}
          </label>
          <div className="cp-field-box">
            <select
              id={`status-${plan.id}`}
              className="cp-field-input adm-select"
              value={status}
              aria-describedby={`status-${plan.id}-h`}
              onChange={(e) => setStatus(e.target.value as '' | 'active' | 'inactive')}
            >
              <option value="">{t('admin.plans.status.keep')}</option>
              <option value="active">{t('admin.plans.status.active')}</option>
              <option value="inactive">{t('admin.plans.status.inactive')}</option>
            </select>
          </div>
          <p id={`status-${plan.id}-h`} className="cp-field-hint">
            {t('admin.plans.status.hint')}
          </p>
        </div>
        <div className="adm-actions">
          <Button type="submit" variant="primary" disabled={nothing} loading={busy}>
            {t('admin.plans.saveForApproval')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={nothing}
            onClick={() => {
              setDrafts(draftsOf(plan.entitlements));
              setStatus('');
            }}
          >
            {t('admin.plans.undo')}
          </Button>
        </div>
        <p className="adm-muted">{t('admin.plans.fourEyesHint')}</p>
      </form>
      <ActionNotice state={action.state} />
      <ReasonDialog
        open={dialog}
        onClose={() => setDialog(false)}
        kind="setting_change"
        title={t('admin.plans.dialogTitle', { plan: planLabel(plan.plan_key, t) })}
        confirmLabel={t('admin.plans.saveForApproval')}
        summary={
          <>
            <ul className="adm-change-list">
              {changes.map((c) => (
                <li key={c.key}>
                  {t('admin.plans.changeLine', {
                    name: entitlementLabel(c.key, t),
                    from: valueText(plan.entitlements.find((e) => e.key === c.key)?.value ?? null, t, n),
                    to: valueText(c.value, t, n),
                  })}
                </li>
              ))}
              {status ? <li>{t('admin.plans.statusLine', { status: t(`admin.plans.status.${status}`) })}</li> : null}
            </ul>
            <p className="adm-muted">{t('admin.plans.fourEyesHint')}</p>
          </>
        }
        onSubmit={submit}
        name="plan"
      />
    </article>
  );
}

function EntitlementCount({
  label,
  draft,
  error,
  current,
  onChange,
}: {
  label: string;
  draft: Extract<EntDraft, { kind: 'int' }>;
  error: boolean;
  current: string;
  onChange: (d: EntDraft) => void;
}) {
  const t = useT();
  return (
    <div className="adm-count">
      <TextField
        label={label}
        hint={t('admin.plans.currentValue', { value: current })}
        error={error ? t('admin.plans.countInvalid') : undefined}
        value={draft.unlimited ? '' : draft.text}
        disabled={draft.unlimited}
        inputMode="numeric"
        dir="ltr"
        maxLength={10}
        autoComplete="off"
        onChange={(e) => onChange({ ...draft, text: e.target.value })}
      />
      <Check checked={draft.unlimited} onChange={(e) => onChange({ ...draft, unlimited: e.target.checked })}>
        {t('admin.plans.unlimitedFor', { name: label })}
      </Check>
    </div>
  );
}
