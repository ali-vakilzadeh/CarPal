'use client';
// Data retention policies (AC6.T5, Docs/23 A-RET-01, Docs/40 §23.5): each policy says how long records of a kind are
// kept and what happens after (delete, anonymize, archive), with its legal basis. An edit (including deactivating a
// policy) waits for a second platform admin (4EYES); the requester sees the four-eyes banner. AC14-2 (backend S21,
// BR-25): Add a policy (admin.retention_create, four-eyes: the approver creates it; one policy per record type and
// status, pending requests included: DUPLICATE) and the Dry run (admin.retention_dry_run: what the next daily run would
// delete or anonymize under the policy, or under the edited period and status before they are sent; counts only).
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useState } from 'react';
import type { RetentionDryRun, RetentionPolicy } from '@carpal/api-contracts';
import {
  ActionNotice,
  AuditDrawer,
  CaseLayout,
  DataTable,
  ReasonDialog,
  useAdminAction,
  useCursorPaging,
  type Column,
} from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { useApiClient, useApiQuery, useSession } from '@/lib/api/query';
import type { ApiProblem } from '@/lib/api/problem';
import { canCall } from '@/lib/roles';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { toLatinDigits } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import type { MessageKey, Translate } from '@/lib/i18n/keys';

const PAGE_SIZE = 100;
const LIST_KEY = ['admin.retention_list'] as const;
const ACTIONS = ['delete', 'anonymize', 'archive'] as const;
const STATUSES = ['active', 'inactive'] as const;

export function actionLabel(a: string, t: Translate): string {
  return (ACTIONS as readonly string[]).includes(a)
    ? t(`admin.retention.actions.${a}` as MessageKey)
    : t('admin.kit.unknown', { value: a });
}
function statusLabel(s: string, t: Translate): string {
  return (STATUSES as readonly string[]).includes(s)
    ? t(`admin.retention.statuses.${s}` as MessageKey)
    : t('admin.kit.unknown', { value: s });
}

type Draft = { days: string; action: RetentionPolicy['action']; appliesTo: string; legalBasis: string; status: RetentionPolicy['status'] };

const draftOf = (p: RetentionPolicy): Draft => ({
  days: String(p.retention_days),
  action: p.action,
  appliesTo: p.applies_to_status ?? '',
  legalBasis: p.legal_basis ?? '',
  status: p.status,
});

export type DraftProblem = 'entity' | 'days' | 'appliesTo' | 'legalBasis';

/** A record type as Docs/52 names it (e.g. Notification, ReviewInvitation). */
export const isEntityType = (v: string) => /^[A-Z][A-Za-z0-9]{1,63}$/.test(v.trim());

/** Days as typed (Persian digits allowed): 1-36,500, else NaN. */
export function daysOf(raw: string): number {
  const text = toLatinDigits(raw).trim();
  const n = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  return n >= 1 && n <= 36_500 ? n : NaN;
}

/** A new policy as the contract's write (without the reason), or the fields that are wrong. */
export function newPolicyOf(entity: string, d: Draft): { value: Omit<RetentionPolicy, 'id'> } | { problems: DraftProblem[] } {
  const r = policyOf({ entity_type: entity.trim() } as RetentionPolicy, d);
  const bad = !isEntityType(entity);
  if ('problems' in r) return { problems: bad ? ['entity', ...r.problems] : r.problems };
  return bad ? { problems: ['entity'] } : r;
}

/** The edited policy as the contract's write (without the reason), or the fields that are wrong. */
export function policyOf(p: RetentionPolicy, d: Draft): { value: Omit<RetentionPolicy, 'id'> } | { problems: DraftProblem[] } {
  const problems: DraftProblem[] = [];
  const days = daysOf(d.days);
  if (Number.isNaN(days)) problems.push('days');
  const appliesTo = d.appliesTo.trim();
  if (appliesTo.length > 40) problems.push('appliesTo');
  const legal = d.legalBasis.trim();
  if (legal.length > 300) problems.push('legalBasis');
  if (problems.length) return { problems };
  return {
    value: {
      entity_type: p.entity_type,
      applies_to_status: appliesTo || null,
      retention_days: days,
      action: d.action,
      legal_basis: legal || null,
      status: d.status,
    },
  };
}

export function RetentionPage() {
  const t = useT();
  const f = useFormat();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const paging = useCursorPaging('retention');
  const list = useApiQuery('admin.retention_list', { query: { limit: PAGE_SIZE, ...(paging.cursor ? { cursor: paging.cursor } : {}) } });
  const session = useSession();
  const canAdd = canCall('admin.retention_create', session.data?.staff?.roles ?? []);
  const items = list.data?.items;
  const adding = canAdd && params.get('policy') === 'new';
  const selected = items?.find((p) => p.id === params.get('policy')) ?? null;
  const open = (id: string) => {
    const q = new URLSearchParams(params);
    q.set('policy', id);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };
  const select = (p: RetentionPolicy) => open(p.id);

  const columns: Column<RetentionPolicy>[] = [
    { id: 'entity', header: t('admin.retention.col.entity'), pinned: true, cell: (p) => <Bidi ltr>{p.entity_type}</Bidi> },
    {
      id: 'applies_to',
      header: t('admin.retention.col.appliesTo'),
      cell: (p) => (p.applies_to_status ? <Bidi ltr>{p.applies_to_status}</Bidi> : t('admin.retention.any')),
    },
    {
      id: 'days',
      header: t('admin.retention.col.days'),
      align: 'end',
      cell: (p) => t('admin.retention.daysN', { n: f.number(p.retention_days) }),
    },
    { id: 'action', header: t('admin.retention.col.action'), cell: (p) => actionLabel(p.action, t) },
    { id: 'legal', header: t('admin.retention.col.legal'), cell: (p) => (p.legal_basis ? <Bidi>{p.legal_basis}</Bidi> : '—') },
    {
      id: 'status',
      header: t('admin.retention.col.status'),
      cell: (p) => <Badge tone={p.status === 'active' ? 'success' : 'neutral'}>{statusLabel(p.status, t)}</Badge>,
    },
  ];

  return (
    <div className="adm-page" data-testid="retention-page">
      <h1 className="adm-page-title">{t('admin.retention.title')}</h1>
      <p className="adm-measure">{t('admin.retention.intro')}</p>
      {canAdd ? (
        <div className="adm-actions">
          <Button size="sm" variant="secondary" icon="plus" onClick={() => open('new')} disabled={adding}>
            {t('admin.retention.add.open')}
          </Button>
        </div>
      ) : null}
      <CaseLayout
        labels={{ list: t('admin.retention.listLabel'), item: t('admin.retention.itemLabel'), decision: t('admin.retention.historyLabel') }}
        list={
          <DataTable
            id="retention"
            caption={t('admin.retention.listLabel')}
            columns={columns}
            rows={items}
            rowKey={(p) => p.id}
            loading={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            emptyText={t('admin.retention.empty')}
            selectedKey={selected?.id ?? null}
            onSelect={select}
            paging={{
              page: paging.page,
              hasPrev: paging.page > 1,
              hasNext: !!list.data?.next_cursor,
              onPrev: paging.prev,
              onNext: () => list.data?.next_cursor && paging.next(list.data.next_cursor),
            }}
          />
        }
        item={
          adding ? (
            <NewPolicyForm />
          ) : selected ? (
            <PolicyEditor key={selected.id} policy={selected} />
          ) : (
            <p className="adm-muted">{t('admin.retention.pick')}</p>
          )
        }
        decision={
          adding ? (
            <p className="adm-muted">{t('admin.retention.add.afterApproval')}</p>
          ) : selected ? (
            <>
              <h2 className="adm-panel-title">{t('admin.retention.historyLabel')}</h2>
              <AuditDrawer entityType="data_retention_policy" entityId={selected.id} label={selected.entity_type} />
            </>
          ) : (
            <p className="adm-muted">{t('admin.retention.pickFirst')}</p>
          )
        }
      />
    </div>
  );
}

/** The policy fields shared by the editor and the new-policy form. */
function PolicyFields({
  draft,
  setDraft,
  err,
}: {
  draft: Draft;
  setDraft: (f: (d: Draft) => Draft) => void;
  err: (k: DraftProblem, key: MessageKey) => string | undefined;
}) {
  const t = useT();
  const uid = useId();
  return (
    <>
      <TextField
        label={t('admin.retention.col.days')}
        hint={t('admin.retention.daysHint')}
        error={err('days', 'admin.retention.daysInvalid')}
        value={draft.days}
        inputMode="numeric"
        dir="ltr"
        maxLength={5}
        autoComplete="off"
        onChange={(e) => setDraft((d) => ({ ...d, days: e.target.value }))}
      />
      <div className="cp-field">
        <label className="cp-field-label" htmlFor={`${uid}-action`}>
          {t('admin.retention.col.action')}
        </label>
        <div className="cp-field-box">
          <select
            id={`${uid}-action`}
            className="cp-field-input adm-select"
            value={draft.action}
            onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value as Draft['action'] }))}
          >
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {actionLabel(a, t)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <TextField
        label={t('admin.retention.col.appliesTo')}
        hint={t('admin.retention.appliesToHint')}
        error={err('appliesTo', 'admin.retention.appliesToInvalid')}
        value={draft.appliesTo}
        dir="ltr"
        maxLength={40}
        autoComplete="off"
        onChange={(e) => setDraft((d) => ({ ...d, appliesTo: e.target.value }))}
      />
      <TextField
        multiline
        rows={2}
        label={t('admin.retention.col.legal')}
        error={err('legalBasis', 'admin.retention.legalInvalid')}
        value={draft.legalBasis}
        maxLength={300}
        onChange={(e) => setDraft((d) => ({ ...d, legalBasis: e.target.value }))}
      />
      <div className="cp-field">
        <label className="cp-field-label" htmlFor={`${uid}-status`}>
          {t('admin.retention.col.status')}
        </label>
        <div className="cp-field-box">
          <select
            id={`${uid}-status`}
            className="cp-field-input adm-select"
            value={draft.status}
            aria-describedby={`${uid}-status-h`}
            onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value as Draft['status'] }))}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s, t)}
              </option>
            ))}
          </select>
        </div>
        <p id={`${uid}-status-h`} className="cp-field-hint">
          {t('admin.retention.statusHint')}
        </p>
      </div>
    </>
  );
}

function PolicyEditor({ policy }: { policy: RetentionPolicy }) {
  const t = useT();
  const f = useFormat();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(policy));
  const [tried, setTried] = useState(false);
  const [dialog, setDialog] = useState(false);
  const action = useAdminAction('admin.retention_update', {
    target: policy.entity_type,
    onOutcome: () => void queryClient.invalidateQueries({ queryKey: LIST_KEY }),
  });
  const busy = action.state.status === 'busy';
  const result = policyOf(policy, draft);
  const problems = 'problems' in result ? result.problems : [];
  const value = 'value' in result ? result.value : null;
  const unchanged = JSON.stringify(draftOf(policy)) === JSON.stringify(draft);
  const err = (k: DraftProblem, key: MessageKey) => (tried && problems.includes(k) ? t(key) : undefined);

  const submit = (reason: string) => {
    if (!value) return;
    setDialog(false);
    void action.run({ path: { policy_id: policy.id }, body: { ...value, reason }, reason });
  };

  return (
    <article data-testid="policy-editor" data-policy={policy.id}>
      <h2 className="adm-panel-title">
        <Bidi ltr>{policy.entity_type}</Bidi>
      </h2>
      <form
        className="adm-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!value || unchanged || busy) return;
          action.reset();
          setDialog(true);
        }}
      >
        <PolicyFields draft={draft} setDraft={setDraft} err={err} />
        <div className="adm-actions">
          <Button type="submit" variant="primary" disabled={unchanged} loading={busy}>
            {t('admin.retention.saveForApproval')}
          </Button>
          <Button type="button" variant="ghost" disabled={unchanged} onClick={() => setDraft(draftOf(policy))}>
            {t('admin.retention.undo')}
          </Button>
        </div>
        <p className="adm-muted">{t('admin.retention.fourEyesHint')}</p>
      </form>
      <ActionNotice state={action.state} />
      <DryRun policy={policy} draft={draft} />
      <ReasonDialog
        open={dialog}
        onClose={() => setDialog(false)}
        kind="setting_change"
        title={t('admin.retention.dialogTitle', { entity: policy.entity_type })}
        confirmLabel={t('admin.retention.saveForApproval')}
        summary={
          value ? (
            <>
              <p>
                {t('admin.retention.summary', {
                  from: t('admin.retention.daysN', { n: f.number(policy.retention_days) }),
                  fromAction: actionLabel(policy.action, t),
                  to: t('admin.retention.daysN', { n: f.number(value.retention_days) }),
                  toAction: actionLabel(value.action, t),
                  status: statusLabel(value.status, t),
                })}
              </p>
              <p className="adm-muted">{t('admin.retention.fourEyesHint')}</p>
            </>
          ) : null
        }
        onSubmit={submit}
        name="retention"
      />
    </article>
  );
}

/**
 * The dry-run input for a policy and its draft: the edited period and status when they differ from the policy (a
 * preview of a change), nothing otherwise (the policy's own values); null while the typed period is not valid.
 */
export function dryRunInput(policy: RetentionPolicy, d: Draft): { retention_days?: number; applies_to_status?: string | null } | null {
  const days = daysOf(d.days);
  if (Number.isNaN(days)) return null;
  const status = d.appliesTo.trim() || null;
  return {
    ...(days !== policy.retention_days ? { retention_days: days } : {}),
    ...(status !== (policy.applies_to_status ?? null) ? { applies_to_status: status } : {}),
  };
}

function DryRun({ policy, draft }: { policy: RetentionPolicy; draft: Draft }) {
  const t = useT();
  const f = useFormat();
  // A count that changes nothing (no reason, not audited): read like a query, on demand.
  const api = useApiClient();
  const [state, setState] = useState<{ busy: boolean; result: RetentionDryRun | null; error: ApiProblem | null }>({
    busy: false,
    result: null,
    error: null,
  });
  const input = dryRunInput(policy, draft);
  const preview = !!input && Object.keys(input).length > 0;
  const result = state.result;
  const count = async () => {
    if (!input) return;
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const r = await api.api('admin.retention_dry_run', { path: { policy_id: policy.id }, body: input });
      setState({ busy: false, result: r, error: null });
    } catch (err) {
      setState({ busy: false, result: null, error: err as ApiProblem });
    }
  };
  return (
    <section className="adm-panel adm-stack" data-testid="retention-dry-run" aria-labelledby="retention-dry-run-t">
      <h3 id="retention-dry-run-t" className="adm-subtitle">
        {t('admin.retention.dry.title')}
      </h3>
      <p className="adm-muted">{t('admin.retention.dry.text')}</p>
      <div className="adm-actions">
        <Button size="sm" variant="secondary" disabled={!input} loading={state.busy} onClick={() => void count()}>
          {preview ? t('admin.retention.dry.runChanged') : t('admin.retention.dry.run')}
        </Button>
      </div>
      {state.error ? <Banner tone="danger" text={t('admin.retention.dry.failed')} /> : null}
      {result ? <DryRunResult r={result} f={f} /> : null}
    </section>
  );
}

function DryRunResult({ r, f }: { r: RetentionDryRun; f: ReturnType<typeof useFormat> }) {
  const t = useT();
  return (
    <div data-testid="dry-run-result" role="status" className="adm-stack">
      <p>
        {t('admin.retention.dry.basis', {
          days: t('admin.retention.daysN', { n: f.number(r.retention_days) }),
          cutoff: f.date(r.cutoff, 'dateShort'),
          status: r.applies_to_status ?? t('admin.retention.any'),
        })}
      </p>
      {r.status === 'inactive' ? <p className="adm-muted">{t('admin.retention.dry.inactive')}</p> : null}
      {r.outcome === 'counted' ? (
        <>
          <p data-testid="dry-run-affected">
            <strong>
              {t(`admin.retention.dry.affected.${r.action === 'anonymize' ? 'anonymize' : 'delete'}`, { n: f.number(r.affected ?? 0) })}
            </strong>
          </p>
          {r.by_status?.length ? (
            <table className="adm-simple-table">
              <caption className="sr-only">{t('admin.retention.dry.byStatus')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin.retention.col.appliesTo')}</th>
                  <th scope="col">{t('admin.retention.dry.count')}</th>
                </tr>
              </thead>
              <tbody>
                {r.by_status.map((s) => (
                  <tr key={s.status}>
                    <td>
                      <Bidi ltr>{s.status}</Bidi>
                    </td>
                    <td>{f.number(s.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      ) : (
        <p data-testid="dry-run-outcome">{t(`admin.retention.dry.outcome.${r.outcome}`)}</p>
      )}
    </div>
  );
}

const EMPTY_DRAFT: Draft = { days: '', action: 'delete', appliesTo: '', legalBasis: '', status: 'active' };

/** Add a policy (admin.retention_create): four-eyes; the approver's decision creates it. */
function NewPolicyForm() {
  const t = useT();
  const f = useFormat();
  const queryClient = useQueryClient();
  const [entity, setEntity] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [tried, setTried] = useState(false);
  const [dialog, setDialog] = useState(false);
  const action = useAdminAction('admin.retention_create', {
    target: entity.trim() || 'retention',
    onOutcome: () => void queryClient.invalidateQueries({ queryKey: LIST_KEY }),
  });
  const busy = action.state.status === 'busy';
  const result = newPolicyOf(entity, draft);
  const problems = 'problems' in result ? result.problems : [];
  const value = 'value' in result ? result.value : null;
  const err = (k: DraftProblem, key: MessageKey) => (tried && problems.includes(k) ? t(key) : undefined);
  const duplicate = action.state.status === 'failed' && action.state.problem.code === 'DUPLICATE';
  return (
    <article data-testid="policy-new">
      <h2 className="adm-panel-title">{t('admin.retention.add.title')}</h2>
      <p className="adm-muted">{t('admin.retention.add.text')}</p>
      <form
        className="adm-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!value || busy) return;
          action.reset();
          setDialog(true);
        }}
      >
        <TextField
          label={t('admin.retention.add.entity')}
          hint={t('admin.retention.add.entityHint')}
          error={err('entity', 'admin.retention.add.entityInvalid')}
          value={entity}
          dir="ltr"
          maxLength={64}
          autoComplete="off"
          onChange={(e) => setEntity(e.target.value)}
        />
        <PolicyFields draft={draft} setDraft={setDraft} err={err} />
        <div className="adm-actions">
          <Button type="submit" variant="primary" loading={busy}>
            {t('admin.retention.saveForApproval')}
          </Button>
        </div>
        <p className="adm-muted">{t('admin.retention.add.fourEyes')}</p>
      </form>
      {duplicate ? <Banner tone="danger" text={t('admin.retention.add.duplicate')} /> : <ActionNotice state={action.state} />}
      <ReasonDialog
        open={dialog}
        onClose={() => setDialog(false)}
        kind="setting_change"
        title={t('admin.retention.add.dialog', { entity: entity.trim() })}
        confirmLabel={t('admin.retention.saveForApproval')}
        summary={
          value ? (
            <>
              <p>
                {t('admin.retention.add.summary', {
                  entity: value.entity_type,
                  days: t('admin.retention.daysN', { n: f.number(value.retention_days) }),
                  action: actionLabel(value.action, t),
                  status: statusLabel(value.status, t),
                })}
              </p>
              <p className="adm-muted">{t('admin.retention.add.fourEyes')}</p>
            </>
          ) : null
        }
        onSubmit={(reason) => {
          if (!value) return;
          setDialog(false);
          void action.run({ body: { ...value, reason }, reason });
        }}
        name="retention-new"
      />
    </article>
  );
}
