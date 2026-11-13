'use client';
// Assign plan / start trial / overrides (AC6.T4, Docs/23 A-PLAN-01 "Assignments", Docs/40 admin.subscription_assign,
// MVP manual billing). The subscriber is named by exact id: an organization found by name (admin.orgs_search, no
// personal data) or pasted, or a user id copied from a work item (finding a person needs a work item, GD-10). A link
// from another screen fills it in (?subscriber=organization:<id> or user:<id>, AC9/AC10). The plan list offers the
// plans the subscriber may take; a trial needs its end day; limits and entitlements can be overridden for this
// subscriber only. The assignment applies at once (no four-eyes in the contract), replaces the current subscription
// and is audited with the reason.
import { useSearchParams } from 'next/navigation';
import { useId, useState } from 'react';
import type { EntitlementKey, EntitlementValue, Plan, Subscription } from '@carpal/api-contracts';
import { ActionNotice, ReasonDialog, useAdminAction } from '@/components/admin';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { TextField } from '@/components/ds/text-field';
import type { AdminResponse } from '@/lib/api/generated';
import { useApiQuery } from '@/lib/api/query';
import { planLabel } from '@/lib/config/plans';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import {
  audienceLabel,
  audiencesOf,
  dayIn,
  draftOfValue,
  endOfDayIso,
  entitlementLabel,
  LIMIT_MAX,
  parseCount,
  parseId,
  parseSubscriberParam,
  valueOfDraft,
  valueText,
  type EntDraft,
} from './plan-logic';

type OrgHit = AdminResponse<'admin.orgs_search'>['items'][number];
type SubscriberType = 'organization' | 'user';

export function AssignForm({ plans }: { plans: readonly Plan[] | undefined }) {
  const t = useT();
  const f = useFormat();
  const uid = useId();
  const params = useSearchParams();
  const [initial] = useState(() => parseSubscriberParam(params.get('subscriber')));
  const [type, setType] = useState<SubscriberType>(initial?.type ?? 'organization');
  const [idText, setIdText] = useState(initial?.id ?? '');
  const [org, setOrg] = useState<OrgHit | null>(null);
  const [searchText, setSearchText] = useState('');
  const [searchName, setSearchName] = useState('');
  const [planKey, setPlanKey] = useState('');
  const [status, setStatus] = useState<'active' | 'trial'>('active');
  const [trialEnd, setTrialEnd] = useState('');
  const [expires, setExpires] = useState('');
  const [vehicleLimit, setVehicleLimit] = useState('');
  const [userLimit, setUserLimit] = useState('');
  const [overrides, setOverrides] = useState<Partial<Record<EntitlementKey, EntDraft>>>({});
  const [tried, setTried] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [result, setResult] = useState<Subscription | null>(null);

  const search = useApiQuery('admin.orgs_search', { body: { name: searchName, limit: 10 } }, { enabled: searchName.length >= 2 });
  const action = useAdminAction('admin.subscription_assign', {
    onOutcome: (o) => {
      if (o.kind === 'applied') setResult(o.data);
    },
  });
  const busy = action.state.status === 'busy';

  const tomorrow = dayIn(f.timeZone, 1);
  const subscriberId = org && type === 'organization' ? org.id : parseId(idText);
  const audiences = audiencesOf(type === 'user' ? { type } : { type, orgType: org?.organization_type });
  const choices = (plans ?? []).filter((p) => audiences.includes(p.audience));
  const plan = choices.find((p) => p.plan_key === planKey) ?? null;

  // Validation (problems show after the first attempt).
  const trialIso = status === 'trial' ? endOfDayIso(trialEnd, f.timeZone) : null;
  const expiresIso = expires ? endOfDayIso(expires, f.timeZone) : null;
  const vehicles = vehicleLimit.trim() ? parseCount(vehicleLimit, LIMIT_MAX) : undefined;
  const users = userLimit.trim() ? parseCount(userLimit, LIMIT_MAX) : undefined;
  const overrideList: EntitlementValue[] = [];
  const badOverrides: EntitlementKey[] = [];
  for (const e of plan?.entitlements ?? []) {
    const d = overrides[e.key];
    if (!d) continue;
    const v = valueOfDraft(d);
    if (v === undefined) badOverrides.push(e.key);
    else overrideList.push({ key: e.key, value: v });
  }
  const problems = {
    subscriber: !subscriberId,
    plan: !plan,
    trialEnd: status === 'trial' && (!trialIso || trialEnd < tomorrow),
    expires: !!expires && (!expiresIso || expires < tomorrow),
    vehicles: vehicles === null,
    users: users === null,
    overrides: badOverrides.length > 0,
  };
  const ready = !Object.values(problems).some(Boolean);
  const show = (k: keyof typeof problems) => tried && problems[k];

  const pickType = (next: SubscriberType) => {
    setType(next);
    setOrg(null);
    setPlanKey('');
    setOverrides({});
  };
  const pickPlan = (key: string) => {
    setPlanKey(key);
    setOverrides({});
    const p = choices.find((x) => x.plan_key === key);
    if (p?.trial_days && !trialEnd) setTrialEnd(dayIn(f.timeZone, p.trial_days));
  };
  const toggleOverride = (key: EntitlementKey, on: boolean, current: EntitlementValue['value']) =>
    setOverrides((all) => {
      const next = { ...all };
      if (on) next[key] = draftOfValue(current);
      else delete next[key];
      return next;
    });

  const submit = (reason: string) => {
    if (!subscriberId || !plan) return;
    setDialog(false);
    setResult(null);
    void action.run({
      body: {
        subscriber: { type, id: subscriberId },
        plan_key: plan.plan_key,
        status,
        ...(trialIso ? { trial_ends_at: trialIso } : {}),
        ...(expiresIso ? { expires_at: expiresIso } : {}),
        ...(typeof vehicles === 'number' ? { vehicle_limit_override: vehicles } : {}),
        ...(typeof users === 'number' ? { user_limit_override: users } : {}),
        ...(overrideList.length ? { entitlement_overrides: overrideList } : {}),
        reason,
      },
      reason,
    });
  };

  const failed = action.state.status === 'failed' ? action.state.problem : null;
  const n = (x: number) => f.number(x);
  const subscriberName = type === 'organization' && org ? org.name : subscriberId;

  return (
    <section className="adm-panel" aria-labelledby="assign" data-testid="assign-form">
      <p className="adm-measure">{t('admin.plans.assign.intro')}</p>
      <form
        className="adm-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!ready || busy) return;
          action.reset();
          setDialog(true);
        }}
      >
        <fieldset className="adm-choices adm-choices-row">
          <legend>{t('admin.plans.assign.subscriberType')}</legend>
          {(['organization', 'user'] as const).map((v) => (
            <div key={v} className="pwa-check">
              <input id={`${uid}-type-${v}`} type="radio" name={`${uid}-type`} checked={type === v} onChange={() => pickType(v)} />
              <div className="pwa-check-body">
                <label htmlFor={`${uid}-type-${v}`} className="pwa-check-label">
                  {t(`admin.plans.assign.types.${v}`)}
                </label>
              </div>
            </div>
          ))}
        </fieldset>

        {type === 'organization' ? (
          <div className="adm-org-search">
            <TextField
              label={t('admin.plans.assign.orgSearch')}
              hint={t('admin.plans.assign.orgSearchHint')}
              value={searchText}
              maxLength={120}
              autoComplete="off"
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  setSearchName(searchText.trim());
                }
              }}
            />
            <Button
              type="button"
              size="sm"
              icon="search"
              disabled={searchText.trim().length < 2}
              onClick={() => setSearchName(searchText.trim())}
            >
              {t('admin.plans.assign.find')}
            </Button>
            {searchName.length >= 2 ? (
              search.isPending ? (
                <p className="adm-muted" role="status">
                  {t('admin.kit.table.loading')}
                </p>
              ) : search.error ? (
                <Banner tone="danger" text={t('admin.plans.assign.searchFailed')} />
              ) : search.data?.items.length ? (
                <fieldset className="adm-choices">
                  <legend>{t('admin.plans.assign.results')}</legend>
                  {search.data.items.map((o) => (
                    <div key={o.id} className="pwa-check" data-org={o.id}>
                      <input
                        id={`${uid}-org-${o.id}`}
                        type="radio"
                        name={`${uid}-org`}
                        checked={org?.id === o.id}
                        onChange={() => {
                          setOrg(o);
                          setIdText(o.id);
                          setPlanKey('');
                          setOverrides({});
                        }}
                      />
                      <div className="pwa-check-body">
                        <label htmlFor={`${uid}-org-${o.id}`} className="pwa-check-label">
                          <Bidi>{o.name}</Bidi>
                        </label>
                        <p className="pwa-text-caption">
                          {t(`admin.plans.assign.orgTypes.${o.organization_type}` as MessageKey)} ·{' '}
                          {t('admin.plans.assign.currentPlan', { plan: o.plan_key ? planLabel(o.plan_key, t) : '—' })}
                        </p>
                      </div>
                    </div>
                  ))}
                </fieldset>
              ) : (
                <p className="adm-muted">{t('admin.plans.assign.noResults')}</p>
              )
            ) : null}
          </div>
        ) : null}

        <TextField
          label={type === 'organization' ? t('admin.plans.assign.orgId') : t('admin.plans.assign.userId')}
          hint={type === 'organization' ? t('admin.plans.assign.orgIdHint') : t('admin.plans.assign.userIdHint')}
          error={show('subscriber') ? t('admin.plans.assign.idInvalid') : undefined}
          value={idText}
          dir="ltr"
          autoComplete="off"
          maxLength={40}
          onChange={(e) => {
            setIdText(e.target.value);
            if (org && e.target.value.trim().toLowerCase() !== org.id) setOrg(null);
          }}
        />

        <div className={show('plan') ? 'cp-field is-error' : 'cp-field'}>
          <label className="cp-field-label" htmlFor={`${uid}-plan`}>
            {t('admin.plans.assign.plan')}
          </label>
          <div className="cp-field-box">
            <select
              id={`${uid}-plan`}
              className="cp-field-input adm-select"
              value={plan ? planKey : ''}
              aria-invalid={show('plan') ? true : undefined}
              aria-describedby={`${uid}-plan-h`}
              onChange={(e) => pickPlan(e.target.value)}
            >
              <option value="">{t('admin.plans.assign.choosePlan')}</option>
              {choices.map((p) => (
                <option key={p.id} value={p.plan_key}>
                  {planLabel(p.plan_key, t)} ({audienceLabel(p.audience, t)})
                </option>
              ))}
            </select>
          </div>
          <p id={`${uid}-plan-h`} className="cp-field-hint">
            {show('plan') ? t('admin.plans.assign.planRequired') : t('admin.plans.assign.planHint')}
          </p>
        </div>

        <fieldset className="adm-choices adm-choices-row">
          <legend>{t('admin.plans.assign.status')}</legend>
          {(['active', 'trial'] as const).map((v) => (
            <div key={v} className="pwa-check">
              <input
                id={`${uid}-status-${v}`}
                type="radio"
                name={`${uid}-status`}
                checked={status === v}
                onChange={() => {
                  setStatus(v);
                  if (v === 'trial' && !trialEnd) setTrialEnd(dayIn(f.timeZone, plan?.trial_days ?? 14));
                }}
              />
              <div className="pwa-check-body">
                <label htmlFor={`${uid}-status-${v}`} className="pwa-check-label">
                  {t(`admin.plans.assign.statuses.${v}`)}
                </label>
              </div>
            </div>
          ))}
        </fieldset>

        {status === 'trial' ? (
          <TextField
            type="date"
            label={t('admin.plans.assign.trialEnd')}
            hint={
              trialIso
                ? t('admin.plans.assign.endsOn', { day: f.calendarDate(trialEnd, 'dateLong') })
                : t('admin.plans.assign.trialEndHint')
            }
            error={show('trialEnd') ? t('admin.plans.assign.dayInvalid') : undefined}
            value={trialEnd}
            min={tomorrow}
            required
            onChange={(e) => setTrialEnd(e.target.value)}
          />
        ) : null}
        <TextField
          type="date"
          label={t('admin.plans.assign.expires')}
          hint={
            expiresIso ? t('admin.plans.assign.endsOn', { day: f.calendarDate(expires, 'dateLong') }) : t('admin.plans.assign.expiresHint')
          }
          error={show('expires') ? t('admin.plans.assign.dayInvalid') : undefined}
          value={expires}
          min={tomorrow}
          onChange={(e) => setExpires(e.target.value)}
        />

        <div className="adm-form-row">
          <TextField
            label={t('admin.plans.assign.vehicleLimit')}
            hint={plan ? t('admin.plans.currentValue', { value: valueText(plan.max_vehicles, t, n) }) : t('admin.plans.assign.limitHint')}
            error={show('vehicles') ? t('admin.plans.countInvalid') : undefined}
            value={vehicleLimit}
            inputMode="numeric"
            dir="ltr"
            maxLength={8}
            autoComplete="off"
            onChange={(e) => setVehicleLimit(e.target.value)}
          />
          <TextField
            label={t('admin.plans.assign.userLimit')}
            hint={plan ? t('admin.plans.currentValue', { value: valueText(plan.max_users, t, n) }) : t('admin.plans.assign.limitHint')}
            error={show('users') ? t('admin.plans.countInvalid') : undefined}
            value={userLimit}
            inputMode="numeric"
            dir="ltr"
            maxLength={8}
            autoComplete="off"
            onChange={(e) => setUserLimit(e.target.value)}
          />
        </div>

        {plan ? (
          <fieldset className="adm-choices">
            <legend>{t('admin.plans.assign.overrides')}</legend>
            <p className="adm-muted">{t('admin.plans.assign.overridesHint')}</p>
            <ul className="adm-ent-list">
              {plan.entitlements.map((e) => {
                const d = overrides[e.key];
                const label = entitlementLabel(e.key, t);
                return (
                  <li key={e.key} data-override={e.key}>
                    <Check
                      checked={!!d}
                      onChange={(ev) => toggleOverride(e.key, ev.target.checked, e.value)}
                      hint={t('admin.plans.currentValue', { value: valueText(e.value, t, n) })}
                    >
                      {t('admin.plans.assign.overrideOf', { name: label })}
                    </Check>
                    {d?.kind === 'bool' ? (
                      <Check
                        checked={d.value}
                        onChange={(ev) => setOverrides((all) => ({ ...all, [e.key]: { kind: 'bool', value: ev.target.checked } }))}
                      >
                        {t('admin.plans.assign.allowed', { name: label })}
                      </Check>
                    ) : d?.kind === 'int' ? (
                      <div className="adm-count">
                        <TextField
                          label={t('admin.plans.assign.newValue', { name: label })}
                          error={tried && badOverrides.includes(e.key) ? t('admin.plans.countInvalid') : undefined}
                          value={d.unlimited ? '' : d.text}
                          disabled={d.unlimited}
                          inputMode="numeric"
                          dir="ltr"
                          maxLength={10}
                          autoComplete="off"
                          onChange={(ev) => setOverrides((all) => ({ ...all, [e.key]: { ...d, text: ev.target.value } }))}
                        />
                        <Check
                          checked={d.unlimited}
                          onChange={(ev) => setOverrides((all) => ({ ...all, [e.key]: { ...d, unlimited: ev.target.checked } }))}
                        >
                          {t('admin.plans.unlimitedFor', { name: label })}
                        </Check>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        ) : null}

        <div className="adm-actions">
          <Button type="submit" variant="primary" icon="check" loading={busy}>
            {status === 'trial' ? t('admin.plans.assign.startTrial') : t('admin.plans.assign.assign')}
          </Button>
        </div>
        {tried && !ready ? (
          <p className="adm-error" role="alert">
            {t('admin.plans.assign.fixFirst')}
          </p>
        ) : null}
      </form>
      {failed?.field('/subscriber/id') ? <Banner tone="danger" text={t('admin.plans.assign.subscriberNotFound')} /> : null}
      {failed?.field('/plan_key') ? <Banner tone="danger" text={t('admin.plans.assign.planNotForSubscriber')} /> : null}
      <ActionNotice state={action.state} applied={t('admin.plans.assign.applied')} />
      {result ? <AssignResult sub={result} /> : null}
      <ReasonDialog
        open={dialog}
        onClose={() => setDialog(false)}
        kind="setting_change"
        title={status === 'trial' ? t('admin.plans.assign.trialTitle') : t('admin.plans.assign.assignTitle')}
        confirmLabel={status === 'trial' ? t('admin.plans.assign.startTrial') : t('admin.plans.assign.assign')}
        summary={
          plan ? (
            <>
              <p>
                {t('admin.plans.assign.summary', {
                  plan: planLabel(plan.plan_key, t),
                  type: t(`admin.plans.assign.types.${type}`),
                })}{' '}
                <Bidi ltr={!org}>{subscriberName ?? ''}</Bidi>
              </p>
              {status === 'trial' && trialIso ? (
                <p>{t('admin.plans.assign.endsOn', { day: f.calendarDate(trialEnd, 'dateLong') })}</p>
              ) : null}
              <p className="adm-muted">{t('admin.plans.assign.replaces')}</p>
            </>
          ) : null
        }
        onSubmit={submit}
        name="assign"
      />
    </section>
  );
}

function AssignResult({ sub }: { sub: Subscription }) {
  const t = useT();
  const f = useFormat();
  const n = (x: number) => f.number(x);
  return (
    <div className="adm-confirm-summary" data-testid="assign-result">
      <p className="adm-panel-title">
        {planLabel(sub.plan.plan_key, t)} — {t(`admin.plans.subStatus.${sub.status}` as MessageKey)}
      </p>
      <dl className="adm-facts">
        {sub.trial_ends_at ? (
          <div>
            <dt>{t('admin.plans.assign.trialEnd')}</dt>
            <dd>{f.date(sub.trial_ends_at, 'dateTime')}</dd>
          </div>
        ) : null}
        {sub.expires_at ? (
          <div>
            <dt>{t('admin.plans.assign.expires')}</dt>
            <dd>{f.date(sub.expires_at, 'dateTime')}</dd>
          </div>
        ) : null}
        {sub.effective_entitlements.map((e) => (
          <div key={e.key}>
            <dt>{entitlementLabel(e.key, t)}</dt>
            <dd>{valueText(e.value, t, n)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
