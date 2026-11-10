'use client';
// Data retention policies (AC6.T5, Docs/23 A-RET-01, Docs/40 §23.5): each policy says how long records of a kind are
// kept and what happens after (delete, anonymize, archive), with its legal basis. An edit (including deactivating a
// policy) waits for a second platform admin (4EYES); the requester sees the four-eyes banner. Adding a policy and the
// dry run of Docs/23 are not in contract 1.3.0; the screen says so instead of showing dead controls (GD-08).
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useState } from 'react';
import type { RetentionPolicy } from '@carpal/api-contracts';
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
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { useApiQuery } from '@/lib/api/query';
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

/** The edited policy as the contract's write (without the reason), or the fields that are wrong. */
export function policyOf(
  p: RetentionPolicy,
  d: Draft,
): { value: Omit<RetentionPolicy, 'id'> } | { problems: ('days' | 'appliesTo' | 'legalBasis')[] } {
  const problems: ('days' | 'appliesTo' | 'legalBasis')[] = [];
  const daysText = toLatinDigits(d.days).trim();
  const days = /^\d{1,5}$/.test(daysText) ? Number(daysText) : NaN;
  if (!(days >= 1 && days <= 36_500)) problems.push('days');
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
  const items = list.data?.items;
  const selected = items?.find((p) => p.id === params.get('policy')) ?? null;
  const select = (p: RetentionPolicy) => {
    const q = new URLSearchParams(params);
    q.set('policy', p.id);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

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
      <p className="adm-muted adm-measure" data-testid="retention-gaps">
        {t('admin.retention.gaps')}
      </p>
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
        item={selected ? <PolicyEditor key={selected.id} policy={selected} /> : <p className="adm-muted">{t('admin.retention.pick')}</p>}
        decision={
          selected ? (
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

function PolicyEditor({ policy }: { policy: RetentionPolicy }) {
  const t = useT();
  const f = useFormat();
  const uid = useId();
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
  const err = (k: (typeof problems)[number], key: MessageKey) => (tried && problems.includes(k) ? t(key) : undefined);

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
