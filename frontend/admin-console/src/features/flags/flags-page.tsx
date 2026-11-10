'use client';
// Feature flags and the AI kill switch (AC6.T2, Docs/23 A-FLAG-01, Docs/40 §23.5 and Appendix B, SEC-AI-6). The AI
// automation kill switch is a large control of its own at the top: turning it on is immediate (reason + confirmation)
// and stops every AI feature within one config refresh; turning it off again waits for a second platform admin. The
// table lists every flag (key, description, type, state, targeting, environment, last change) with a type filter in
// the URL; the selected flag can be switched and its targeting edited, always with a reason and the flag's version
// as If-Match, so a change made meanwhile is refused (412) and explained with a Reload that keeps the edit.
// featured.enabled carries the MVP note (no paid placements yet) and needs a second admin to turn on.
// Not in the contract: scheduled changes (Docs/23 "Should"), a per-flag history (no flag id; the audit log in AC13).
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import type { FeatureFlag, Role } from '@carpal/api-contracts';
import {
  ActionNotice,
  CaseLayout,
  DataTable,
  ReasonDialog,
  useAdminAction,
  useCursorPaging,
  useUrlFilters,
  type Column,
  type FilterDef,
} from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { Icon } from '@/components/ds/icon';
import { TextField } from '@/components/ds/text-field';
import { ifMatchOf } from '@/lib/api/client';
import { useApiQuery } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import {
  draftOf,
  environmentLabel,
  FEATURED,
  FLAG_TYPES,
  flagTypeLabel,
  KILL_SWITCH,
  needsSecondApprover,
  PLAN_KEYS,
  planLabel,
  roleLabel,
  sameTargeting,
  TARGET_ROLES,
  targetingOf,
  targetingSummary,
  type PlanKey,
  type TargetingDraft,
} from './flag-logic';

const PAGE_SIZE = 100;
const LIST_KEY = ['admin.flags_list'] as const;

type Pending = { key: string; kind: 'toggle'; next: boolean } | { key: string; kind: 'targeting'; targeting: FeatureFlag['targeting'] };

export function FlagsPage() {
  const t = useT();
  const f = useFormat();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();

  const filterDefs: FilterDef[] = useMemo(
    () => [
      {
        key: 'type',
        label: t('admin.flags.filter.type'),
        allowAll: true,
        options: FLAG_TYPES.map((v) => ({ value: v, label: flagTypeLabel(v, t) })),
      },
    ],
    [t],
  );
  const filters = useUrlFilters(filterDefs);
  const paging = useCursorPaging(JSON.stringify(filters.query));
  const type = filters.values.type as FeatureFlag['flag_type'] | '';
  const list = useApiQuery('admin.flags_list', {
    query: { ...(type ? { flag_type: type } : {}), limit: PAGE_SIZE, ...(paging.cursor ? { cursor: paging.cursor } : {}) },
  });
  const kill = useApiQuery('admin.flags_list', { query: { flag_type: 'kill_switch', limit: PAGE_SIZE } });
  const killFlag = kill.data?.items.find((x) => x.key === KILL_SWITCH) ?? null;

  const items = list.data?.items;
  const selectedKey = params.get('flag');
  const selected = items?.find((x) => x.key === selectedKey) ?? (killFlag?.key === selectedKey ? killFlag : null);
  const select = (flag: FeatureFlag) => {
    const p = new URLSearchParams(params);
    p.set('flag', flag.key);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  // One action for the page (one replay handler after a step-up); `last` says which control it was for.
  const [last, setLast] = useState<Pending | null>(null);
  const [dialog, setDialog] = useState<Pending | null>(null);
  const reload = () => void queryClient.invalidateQueries({ queryKey: LIST_KEY });
  const action = useAdminAction('admin.flag_update', { target: last?.key ?? '', onOutcome: reload });
  const busy = action.state.status === 'busy';

  const ask = (p: Pending) => {
    if (busy) return;
    action.reset();
    setDialog(p);
  };
  const submit = (reason: string) => {
    const p = dialog;
    if (!p) return;
    const flag = p.key === killFlag?.key ? killFlag : (items?.find((x) => x.key === p.key) ?? selected);
    if (!flag) return;
    setDialog(null);
    setLast(p);
    const body = p.kind === 'toggle' ? { enabled: p.next, reason } : { targeting: p.targeting, reason };
    void action.run({ path: { key: flag.key }, body, reason, ifMatch: ifMatchOf(flag.version) });
  };
  const noticeFor = (key: string) =>
    last?.key === key ? <ActionNotice state={action.state} applied={t('admin.flags.applied')} onReload={reload} /> : null;

  const columns: Column<FeatureFlag>[] = [
    { id: 'key', header: t('admin.flags.col.key'), pinned: true, cell: (x) => <Bidi ltr>{x.key}</Bidi> },
    { id: 'description', header: t('admin.flags.col.description'), cell: (x) => (x.description ? <Bidi>{x.description}</Bidi> : '—') },
    { id: 'type', header: t('admin.flags.col.type'), cell: (x) => flagTypeLabel(x.flag_type, t) },
    { id: 'enabled', header: t('admin.flags.col.enabled'), cell: (x) => <StateBadge flag={x} /> },
    {
      id: 'targeting',
      header: t('admin.flags.col.targeting'),
      cell: (x, ctx) => targetingSummary(x.targeting, t, ctx.digits).join(' · '),
    },
    { id: 'environment', header: t('admin.flags.col.environment'), cell: (x) => environmentLabel(x.environment, t), defaultHidden: true },
    {
      id: 'changed',
      header: t('admin.flags.col.changed'),
      cell: (x, ctx) => (
        <>
          <Bidi>{x.updated_by_display}</Bidi> · <time dateTime={x.updated_at}>{ctx.digits(f.date(x.updated_at, 'dateTime'))}</time>
        </>
      ),
    },
  ];

  const dialogFlag = dialog ? (dialog.key === killFlag?.key ? killFlag : (items?.find((x) => x.key === dialog.key) ?? selected)) : null;
  const dialogFourEyes = dialog?.kind === 'toggle' && dialogFlag ? needsSecondApprover(dialog.key, dialogFlag.enabled, dialog.next) : false;
  const killOn = dialog?.kind === 'toggle' && dialog.key === KILL_SWITCH && dialog.next;

  return (
    <div className="adm-page" data-testid="flags-page">
      <h1 className="adm-page-title">{t('admin.flags.title')}</h1>
      <KillSwitchPanel
        flag={killFlag}
        loading={kill.isPending}
        failed={!!kill.error}
        busy={busy && last?.key === KILL_SWITCH}
        onToggle={(next) => ask({ key: KILL_SWITCH, kind: 'toggle', next })}
        notice={noticeFor(KILL_SWITCH)}
      />
      <h2 className="adm-section-title">{t('admin.flags.allTitle')}</h2>
      <CaseLayout
        labels={{ list: t('admin.flags.listLabel'), item: t('admin.flags.itemLabel'), decision: t('admin.flags.decisionLabel') }}
        list={
          <DataTable
            id="flags"
            caption={t('admin.flags.listLabel')}
            columns={columns}
            rows={items}
            rowKey={(x) => x.key}
            loading={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            emptyText={t('admin.flags.empty')}
            selectedKey={selected?.key ?? null}
            onSelect={select}
            filters={filterDefs}
            filterValues={filters.values}
            onFilterChange={filters.setFilter}
            onApplyView={filters.applyView}
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
          selected ? (
            <FlagDetail
              key={selected.key}
              flag={selected}
              busy={busy}
              onSave={(targeting) => ask({ key: selected.key, kind: 'targeting', targeting })}
            />
          ) : (
            <p className="adm-muted">{t('admin.flags.pick')}</p>
          )
        }
        decision={
          <>
            <h2 className="adm-panel-title">{t('admin.flags.decisionLabel')}</h2>
            {selected ? (
              <FlagSwitch flag={selected} busy={busy} onToggle={(next) => ask({ key: selected.key, kind: 'toggle', next })} />
            ) : (
              <p className="adm-muted">{t('admin.flags.pickFirst')}</p>
            )}
            {selected && selected.key !== KILL_SWITCH ? noticeFor(selected.key) : null}
          </>
        }
      />
      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind="setting_change"
        title={
          dialog?.kind === 'targeting'
            ? t('admin.flags.dialog.targetingTitle')
            : killOn
              ? t('admin.flags.kill.dialogOnTitle')
              : dialog?.kind === 'toggle' && dialog.next
                ? t('admin.flags.dialog.onTitle')
                : t('admin.flags.dialog.offTitle')
        }
        confirmLabel={
          dialogFourEyes ? t('admin.flags.dialog.request') : killOn ? t('admin.flags.kill.turnOn') : t('admin.flags.dialog.confirm')
        }
        confirmVariant={killOn ? 'danger' : 'primary'}
        summary={
          dialog && dialogFlag ? (
            <>
              <p>
                <Bidi ltr>{dialog.key}</Bidi>
              </p>
              <p>
                {dialog.kind === 'toggle'
                  ? dialog.next
                    ? t('admin.flags.dialog.turnsOn')
                    : t('admin.flags.dialog.turnsOff')
                  : t('admin.flags.dialog.newTargeting', { list: targetingSummary(dialog.targeting, t, f.digits).join(' · ') })}
              </p>
              {killOn ? <p className="adm-error">{t('admin.flags.kill.dialogOnEffect')}</p> : null}
              {dialogFourEyes ? <p className="adm-muted">{t('admin.flags.dialog.fourEyes')}</p> : null}
            </>
          ) : null
        }
        onSubmit={submit}
        name="flag"
      />
    </div>
  );
}

function StateBadge({ flag }: { flag: FeatureFlag }) {
  const t = useT();
  return flag.enabled ? (
    <Badge tone={flag.key === KILL_SWITCH ? 'danger' : 'success'}>{t('admin.flags.on')}</Badge>
  ) : (
    <Badge tone="neutral">{t('admin.flags.off')}</Badge>
  );
}

function KillSwitchPanel({
  flag,
  loading,
  failed,
  busy,
  onToggle,
  notice,
}: {
  flag: FeatureFlag | null;
  loading: boolean;
  failed: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
  notice: ReactNode;
}) {
  const t = useT();
  const f = useFormat();
  const on = !!flag?.enabled;
  return (
    <section
      className="adm-kill"
      data-state={flag ? (on ? 'on' : 'off') : 'unknown'}
      aria-labelledby="kill-title"
      data-testid="kill-switch"
    >
      <div className="adm-kill-head">
        <Icon name="alert" size={28} />
        <h2 id="kill-title" className="adm-panel-title">
          {t('admin.flags.kill.title')}
        </h2>
        {flag ? (
          <Badge tone={on ? 'danger' : 'success'}>
            <span data-testid="kill-state">{on ? t('admin.flags.kill.on') : t('admin.flags.kill.off')}</span>
          </Badge>
        ) : null}
      </div>
      {loading ? (
        <p className="adm-muted">{t('admin.kit.table.loading')}</p>
      ) : failed ? (
        <Banner tone="danger" text={t('admin.flags.kill.failed')} />
      ) : !flag ? (
        <Banner tone="warn" text={t('admin.flags.kill.missing')} />
      ) : (
        <>
          <p className="adm-measure">{on ? t('admin.flags.kill.onText') : t('admin.flags.kill.offText')}</p>
          <p className="adm-muted">
            {t('admin.flags.kill.lastChanged', { who: flag.updated_by_display, when: f.date(flag.updated_at, 'dateTime') })}
          </p>
          <div className="adm-actions">
            <Button variant={on ? 'secondary' : 'danger'} icon={on ? 'refresh' : 'alert'} loading={busy} onClick={() => onToggle(!on)}>
              {on ? t('admin.flags.kill.turnOff') : t('admin.flags.kill.turnOn')}
            </Button>
          </div>
          {on ? <p className="adm-muted">{t('admin.flags.kill.offNeedsSecond')}</p> : null}
        </>
      )}
      {notice}
    </section>
  );
}

function FlagSwitch({ flag, busy, onToggle }: { flag: FeatureFlag; busy: boolean; onToggle: (next: boolean) => void }) {
  const t = useT();
  const next = !flag.enabled;
  const fourEyes = needsSecondApprover(flag.key, flag.enabled, next);
  return (
    <div className="adm-switch" data-testid="flag-switch">
      <p>
        {t('admin.flags.now')} <StateBadge flag={flag} />
      </p>
      {flag.key === FEATURED ? <Banner tone="info" title={t('admin.flags.featured.title')} text={t('admin.flags.featured.text')} /> : null}
      {flag.flag_type === 'ai_feature' ? <p className="adm-muted">{t('admin.flags.aiNote')}</p> : null}
      <div className="adm-actions">
        <Button variant={next ? 'primary' : 'secondary'} loading={busy} onClick={() => onToggle(next)}>
          {next ? t('admin.flags.turnOn') : t('admin.flags.turnOff')}
        </Button>
      </div>
      {fourEyes ? <p className="adm-muted">{t('admin.flags.dialog.fourEyes')}</p> : null}
    </div>
  );
}

function FlagDetail({ flag, busy, onSave }: { flag: FeatureFlag; busy: boolean; onSave: (targeting: FeatureFlag['targeting']) => void }) {
  const t = useT();
  const f = useFormat();
  // The draft belongs to the flag (keyed by its key): a reload after someone else's change keeps it.
  const [draft, setDraft] = useState<TargetingDraft>(() => draftOf(flag.targeting));
  const [tried, setTried] = useState(false);
  const result = targetingOf(draft);
  const problems = 'problems' in result ? result.problems : {};
  const unchanged = 'value' in result && sameTargeting(result.value, flag.targeting);
  const toggleRole = (r: Role, on: boolean) => setDraft((d) => ({ ...d, roles: on ? [...d.roles, r] : d.roles.filter((x) => x !== r) }));
  const togglePlan = (p: PlanKey, on: boolean) =>
    setDraft((d) => ({ ...d, planKeys: on ? [...d.planKeys, p] : d.planKeys.filter((x) => x !== p) }));
  const problem = (field: keyof typeof problems, name: 'regions' | 'orgs' | 'percentage') => {
    const p = problems[field];
    return tried && p ? t(`admin.flags.target.problem.${name}_${p}` as MessageKey) : undefined;
  };
  return (
    <article data-testid="flag-detail" data-flag={flag.key}>
      <h2 className="adm-panel-title">
        <Bidi ltr>{flag.key}</Bidi>
      </h2>
      {flag.description ? (
        <p>
          <Bidi>{flag.description}</Bidi>
        </p>
      ) : null}
      <dl className="adm-facts">
        <div>
          <dt>{t('admin.flags.col.type')}</dt>
          <dd>{flagTypeLabel(flag.flag_type, t)}</dd>
        </div>
        <div>
          <dt>{t('admin.flags.col.environment')}</dt>
          <dd>{environmentLabel(flag.environment, t)}</dd>
        </div>
        <div>
          <dt>{t('admin.flags.col.targeting')}</dt>
          <dd data-testid="flag-targeting">{targetingSummary(flag.targeting, t, f.digits).join(' · ')}</dd>
        </div>
        <div>
          <dt>{t('admin.flags.col.changed')}</dt>
          <dd>
            <Bidi>{flag.updated_by_display}</Bidi> · {f.date(flag.updated_at, 'dateTime')}
          </dd>
        </div>
      </dl>
      <form
        className="adm-form"
        noValidate
        aria-labelledby="targeting-title"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if ('value' in result && !unchanged && !busy) onSave(result.value);
        }}
      >
        <h3 id="targeting-title" className="adm-subtitle">
          {t('admin.flags.target.title')}
        </h3>
        <p className="adm-muted">{t('admin.flags.target.intro')}</p>
        <fieldset className="adm-choices">
          <legend>{t('admin.flags.target.roles')}</legend>
          {TARGET_ROLES.map((r) => (
            <Check key={r} checked={draft.roles.includes(r)} onChange={(e) => toggleRole(r, e.target.checked)}>
              {roleLabel(r, t)}
            </Check>
          ))}
        </fieldset>
        <TextField
          label={t('admin.flags.target.regions')}
          hint={t('admin.flags.target.regionsHint')}
          error={problem('regions', 'regions')}
          value={draft.regions}
          dir="ltr"
          autoComplete="off"
          onChange={(e) => setDraft((d) => ({ ...d, regions: e.target.value }))}
        />
        <TextField
          multiline
          rows={3}
          label={t('admin.flags.target.orgs')}
          hint={t('admin.flags.target.orgsHint')}
          error={problem('organizationIds', 'orgs')}
          value={draft.organizationIds}
          dir="ltr"
          onChange={(e) => setDraft((d) => ({ ...d, organizationIds: e.target.value }))}
        />
        <fieldset className="adm-choices">
          <legend>{t('admin.flags.target.plans')}</legend>
          {PLAN_KEYS.map((p) => (
            <Check key={p} checked={draft.planKeys.includes(p)} onChange={(e) => togglePlan(p, e.target.checked)}>
              {planLabel(p, t)}
            </Check>
          ))}
        </fieldset>
        <TextField
          label={t('admin.flags.target.percentage')}
          hint={t('admin.flags.target.percentageHint')}
          error={problem('percentage', 'percentage')}
          value={draft.percentage}
          inputMode="numeric"
          dir="ltr"
          maxLength={3}
          autoComplete="off"
          onChange={(e) => setDraft((d) => ({ ...d, percentage: e.target.value }))}
        />
        <div className="adm-actions">
          <Button type="submit" disabled={unchanged} loading={busy}>
            {t('admin.flags.target.save')}
          </Button>
          <Button type="button" variant="ghost" disabled={unchanged} onClick={() => setDraft(draftOf(flag.targeting))}>
            {t('admin.flags.target.undo')}
          </Button>
        </div>
        {unchanged ? <p className="adm-muted">{t('admin.flags.target.unchanged')}</p> : null}
      </form>
    </article>
  );
}
