'use client';
// Notifications & templates (AC14.T3, Docs/23 A-NOTIF-01, Docs/40 §23.5, backend S17, S25a, S26a; platform admins).
// Three tabs:
// - Templates: every message template per channel (email, push, SMS) and language, filtered by channel, language and
//   "missing translation"; the text in use (staff override or built-in), the placeholders it may use, and flags for a
//   missing or outdated translation. Transactional messages and critical alerts ("Always delivered") are shown locked.
//   An editable template is previewed with sample values (admin.notif_template_preview, checked like a save), saved
//   with a reason (If-Match of the override; none on the built-in text) and reset to the built-in text. In-app texts
//   are the clients' dictionaries and are not edited here (owner decision 2026-11-16).
// - Rules: review invitation delay and reminders (0-3 days, strictly ascending, while the 7-day link is valid),
//   reminders to businesses about approval requests, default quiet hours, digest hour and weekly day, and the
//   maintenance due windows by date and mileage, and the monthly odometer prompt (0 off, or 14-90 days without a
//   reading; backend S26b, AC14b.T4); saved as a whole with If-Match and a reason (D-100).
// - Delivery health: per channel and provider, attempted and failed deliveries with the failure rate over 24 hours, 7
//   and 30 days, and the last failure (aggregates only).
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import type { DeliveryHealthWindow, NotificationRules, NotificationTemplate } from '@carpal/api-contracts';
import {
  ActionNotice,
  CaseLayout,
  DataTable,
  problemText,
  ReasonDialog,
  useAdminAction,
  useUrlFilters,
  type Column,
  type FilterDef,
} from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { TextField } from '@/components/ds/text-field';
import { ifMatchOf } from '@/lib/api/client';
import type { ApiProblem } from '@/lib/api/problem';
import { useApiClient, useApiQuery } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import {
  CHANNELS,
  hasSubject,
  ratePercent,
  rulesDraftOf,
  rulesWriteOf,
  templateId,
  templateWriteOf,
  type RulesDraft,
  type RulesProblem,
} from './notif-logic';

type Tab = 'templates' | 'rules' | 'health';
const TABS: readonly Tab[] = ['templates', 'rules', 'health'];
const TEMPLATES_KEY = ['admin.notif_templates_list'] as const;
const RULES_KEY = ['admin.notif_rules_get'] as const;

const channelLabel = (c: string, t: Translate) =>
  (CHANNELS as readonly string[]).includes(c) ? t(`admin.notif.channel.${c}` as MessageKey) : t('admin.kit.unknown', { value: c });
const localeLabel = (l: string, t: Translate) => (l === 'en' || l === 'fa' ? t(`admin.policies.locale.${l}`) : l);

export function NotificationsPage() {
  const t = useT();
  const params = useSearchParams();
  const pathname = usePathname();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'templates';
  return (
    <div className="adm-page" data-testid="notifications-page">
      <h1 className="adm-page-title">{t('admin.notif.title')}</h1>
      <p className="adm-measure">{t('admin.notif.intro')}</p>
      <nav className="adm-tabs" aria-label={t('admin.notif.tabsLabel')}>
        {TABS.map((x) => (
          <Link
            key={x}
            href={x === 'templates' ? pathname : `${pathname}?tab=${x}`}
            aria-current={tab === x ? 'page' : undefined}
            className="adm-tab"
            data-tab={x}
          >
            {t(`admin.notif.tab.${x}`)}
          </Link>
        ))}
      </nav>
      {tab === 'templates' ? <TemplatesTab /> : tab === 'rules' ? <RulesTab /> : <HealthTab />}
    </div>
  );
}

function TemplatesTab() {
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const filterDefs: FilterDef[] = useMemo(
    () => [
      {
        key: 'channel',
        label: t('admin.notif.filter.channel'),
        allowAll: true,
        options: CHANNELS.map((c) => ({ value: c, label: channelLabel(c, t) })),
      },
      {
        key: 'locale',
        label: t('admin.notif.filter.locale'),
        allowAll: true,
        options: (['en', 'fa'] as const).map((l) => ({ value: l, label: localeLabel(l, t) })),
      },
      {
        key: 'missing_only',
        label: t('admin.notif.filter.missing'),
        allowAll: true,
        options: [{ value: 'true', label: t('admin.notif.filter.missingOnly') }],
      },
    ],
    [t],
  );
  const filters = useUrlFilters(filterDefs);
  const list = useApiQuery('admin.notif_templates_list', {
    query: {
      ...(filters.values.channel ? { channel: filters.values.channel as NotificationTemplate['channel'] } : {}),
      ...(filters.values.locale ? { locale: filters.values.locale as 'en' | 'fa' } : {}),
      ...(filters.values.missing_only ? { missing_only: true } : {}),
    },
  });
  const items = list.data?.items;
  const selected = items?.find((x) => templateId(x) === params.get('template')) ?? null;
  const select = (x: NotificationTemplate) => {
    const q = new URLSearchParams(params);
    q.set('template', templateId(x));
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

  const columns: Column<NotificationTemplate>[] = [
    { id: 'key', header: t('admin.notif.col.key'), pinned: true, cell: (x) => <Bidi ltr>{x.template_key}</Bidi> },
    { id: 'channel', header: t('admin.notif.col.channel'), cell: (x) => channelLabel(x.channel, t) },
    { id: 'locale', header: t('admin.notif.col.locale'), cell: (x) => localeLabel(x.locale, t) },
    {
      id: 'source',
      header: t('admin.notif.col.source'),
      cell: (x) => (x.source === 'override' ? t('admin.notif.source.override') : t('admin.notif.source.code')),
    },
    { id: 'flags', header: t('admin.notif.col.flags'), cell: (x) => <TemplateFlags tpl={x} /> },
  ];

  return (
    <CaseLayout
      labels={{ list: t('admin.notif.listLabel'), item: t('admin.notif.itemLabel'), decision: t('admin.notif.aboutLabel') }}
      list={
        <DataTable
          id="notif-templates"
          caption={t('admin.notif.listLabel')}
          columns={columns}
          rows={items}
          rowKey={templateId}
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          emptyText={t('admin.notif.empty')}
          selectedKey={selected ? templateId(selected) : null}
          onSelect={select}
          filters={filterDefs}
          filterValues={filters.values}
          onFilterChange={filters.setFilter}
          onApplyView={filters.applyView}
        />
      }
      item={selected ? <TemplateEditor key={templateId(selected)} tpl={selected} /> : <p className="adm-muted">{t('admin.notif.pick')}</p>}
      decision={<p className="adm-muted">{t('admin.notif.previewHint')}</p>}
    />
  );
}

function TemplateFlags({ tpl }: { tpl: NotificationTemplate }) {
  const t = useT();
  return (
    <span className="adm-badges">
      {tpl.always_delivered ? <Badge tone="accent">{t('admin.notif.flag.always')}</Badge> : null}
      {!tpl.editable ? <Badge tone="neutral">{t('admin.notif.flag.locked')}</Badge> : null}
      {tpl.missing_translation ? <Badge tone="danger">{t('admin.notif.flag.missing')}</Badge> : null}
      {tpl.translation_outdated ? <Badge tone="signal">{t('admin.notif.flag.outdated')}</Badge> : null}
    </span>
  );
}

function TemplateEditor({ tpl }: { tpl: NotificationTemplate }) {
  const t = useT();
  const f = useFormat();
  const uid = useId();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState(tpl.subject ?? '');
  const [body, setBody] = useState(tpl.body);
  const [tried, setTried] = useState(false);
  const [dialog, setDialog] = useState<'save' | 'reset' | null>(null);
  const [preview, setPreview] = useState<
    { s: 'idle' } | { s: 'busy' } | { s: 'ready'; subject: string | null; body: string } | { s: 'failed'; p: ApiProblem }
  >({
    s: 'idle',
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: TEMPLATES_KEY });
  const save = useAdminAction('admin.notif_template_update', { target: tpl.template_key, onOutcome: refresh });
  const reset = useAdminAction('admin.notif_template_reset', { target: tpl.template_key, onOutcome: refresh });
  const busy = save.state.status === 'busy' || reset.state.status === 'busy';
  const result = templateWriteOf(tpl, subject, body);
  const problems = 'problems' in result ? result.problems : [];
  const unchanged = subject === (tpl.subject ?? '') && body === tpl.body;
  const dir = tpl.locale === 'fa' ? 'rtl' : 'ltr';
  // The override's version is its If-Match; the built-in text takes none ('' sends no header, D-101).
  const ifMatch = tpl.source === 'override' && tpl.version !== null ? ifMatchOf(tpl.version) : '';

  const runPreview = async () => {
    setPreview({ s: 'busy' });
    try {
      const r = await api.api('admin.notif_template_preview', {
        path: { template_key: tpl.template_key },
        body: { channel: tpl.channel, locale: tpl.locale, ...(hasSubject(tpl.channel) ? { subject } : {}), body },
      });
      setPreview({ s: 'ready', subject: r.subject, body: r.body });
    } catch (err) {
      setPreview({ s: 'failed', p: err as ApiProblem });
    }
  };

  return (
    <article data-testid="template-editor" data-template={templateId(tpl)} data-editable={tpl.editable ? 'true' : 'false'}>
      <h2 className="adm-panel-title">
        <Bidi ltr>{tpl.template_key}</Bidi>
      </h2>
      <p className="adm-muted">
        {channelLabel(tpl.channel, t)} · {localeLabel(tpl.locale, t)} ·{' '}
        {tpl.source === 'override'
          ? t('admin.notif.editedBy', {
              name: tpl.updated_by_display ?? '—',
              at: tpl.updated_at ? f.date(tpl.updated_at, 'dateTime') : '—',
            })
          : t('admin.notif.source.codeLong')}
      </p>
      <TemplateFlags tpl={tpl} />
      {tpl.always_delivered ? <p className="adm-muted">{t('admin.notif.alwaysText')}</p> : null}
      {tpl.missing_translation ? <Banner tone="warn" text={t('admin.notif.missingText')} /> : null}
      {tpl.translation_outdated ? <Banner tone="info" text={t('admin.notif.outdatedText')} /> : null}
      <section aria-labelledby={`${uid}-vars`}>
        <h3 id={`${uid}-vars`} className="adm-section-title">
          {t('admin.notif.variables')}
        </h3>
        {tpl.variables.length ? (
          <ul className="adm-chips" data-testid="template-variables">
            {tpl.variables.map((v) => (
              <li key={v}>
                <code lang="en" dir="ltr">{`{${v}}`}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="adm-muted">{t('admin.notif.noVariables')}</p>
        )}
      </section>
      {!tpl.editable ? (
        <>
          <p className="adm-muted" data-testid="template-locked">
            {tpl.kind === 'transactional' ? t('admin.notif.lockedTransactional') : t('admin.notif.lockedAlways')}
          </p>
          {tpl.subject !== null ? (
            <p lang={tpl.locale} dir={dir}>
              <strong>{tpl.subject}</strong>
            </p>
          ) : null}
          <div lang={tpl.locale} dir={dir} className="adm-policy-text" tabIndex={0} aria-label={t('admin.notif.field.body')}>
            {tpl.body}
          </div>
        </>
      ) : (
        <form
          className="adm-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTried(true);
            if (!('value' in result) || unchanged || busy) return;
            save.reset();
            reset.reset();
            setDialog('save');
          }}
        >
          {hasSubject(tpl.channel) ? (
            <TextField
              label={tpl.channel === 'push' ? t('admin.notif.field.pushTitle') : t('admin.notif.field.subject')}
              error={tried && problems.includes('subject') ? t('admin.notif.problem.subject') : undefined}
              value={subject}
              dir={dir}
              lang={tpl.locale}
              maxLength={200}
              onChange={(e) => setSubject(e.target.value)}
            />
          ) : null}
          <TextField
            multiline
            rows={tpl.channel === 'email' ? 10 : 4}
            label={t('admin.notif.field.body')}
            hint={t('admin.notif.field.bodyHint')}
            error={
              tried && problems.includes('body')
                ? t('admin.notif.problem.body')
                : tried && 'unknown' in result && result.unknown.length
                  ? t('admin.notif.problem.unknown', { names: result.unknown.map((n) => `{${n}}`).join(', ') })
                  : undefined
            }
            value={body}
            dir={dir}
            lang={tpl.locale}
            maxLength={4000}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="adm-actions">
            <Button type="button" variant="secondary" loading={preview.s === 'busy'} onClick={() => void runPreview()}>
              {t('admin.notif.preview')}
            </Button>
            <Button type="submit" variant="primary" disabled={unchanged} loading={save.state.status === 'busy'}>
              {t('admin.notif.save')}
            </Button>
            <Button type="button" variant="ghost" disabled={unchanged} onClick={() => (setSubject(tpl.subject ?? ''), setBody(tpl.body))}>
              {t('admin.notif.undo')}
            </Button>
            {tpl.source === 'override' ? (
              <Button
                type="button"
                variant="danger"
                disabled={busy}
                loading={reset.state.status === 'busy'}
                onClick={() => {
                  save.reset();
                  reset.reset();
                  setDialog('reset');
                }}
              >
                {t('admin.notif.reset')}
              </Button>
            ) : null}
          </div>
        </form>
      )}
      <ActionNotice state={save.state} applied={t('admin.notif.saved')} onReload={refresh} />
      <ActionNotice state={reset.state} applied={t('admin.notif.resetDone')} onReload={refresh} />
      {preview.s === 'ready' ? (
        <section className="adm-panel" data-testid="template-preview" aria-label={t('admin.notif.previewLabel')}>
          <h3 className="adm-section-title">{t('admin.notif.previewLabel')}</h3>
          {preview.subject !== null ? (
            <p lang={tpl.locale} dir={dir}>
              <strong>{preview.subject}</strong>
            </p>
          ) : null}
          <div lang={tpl.locale} dir={dir} className="adm-policy-text">
            {preview.body}
          </div>
        </section>
      ) : preview.s === 'failed' ? (
        <Banner tone="danger" text={problemText(preview.p, t)} />
      ) : null}
      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind="template_edit"
        title={
          dialog === 'reset'
            ? t('admin.notif.dialog.reset', { key: tpl.template_key })
            : t('admin.notif.dialog.save', { key: tpl.template_key })
        }
        confirmLabel={dialog === 'reset' ? t('admin.notif.reset') : t('admin.notif.save')}
        confirmVariant={dialog === 'reset' ? 'danger' : 'primary'}
        summary={
          <p className="adm-muted">
            {t('admin.notif.dialog.where', { channel: channelLabel(tpl.channel, t), locale: localeLabel(tpl.locale, t) })}
          </p>
        }
        onSubmit={(reason) => {
          const d = dialog;
          setDialog(null);
          if (d === 'reset') {
            void reset.run({
              path: { template_key: tpl.template_key },
              body: { channel: tpl.channel, locale: tpl.locale, reason },
              reason,
              ifMatch,
            });
          } else if ('value' in result) {
            void save.run({ path: { template_key: tpl.template_key }, body: { ...result.value, reason }, reason, ifMatch });
          }
        }}
        name="notif-template"
      />
    </article>
  );
}

function RulesTab() {
  const t = useT();
  const rules = useApiQuery('admin.notif_rules_get', {});
  if (rules.isPending) return <p role="status">{t('admin.work.loading')}</p>;
  if (rules.error || !rules.data)
    return (
      <div className="adm-table-error">
        <Banner tone="danger" text={rules.error ? problemText(rules.error, t) : t('admin.kit.problem.other')} />
        <Button size="sm" icon="refresh" onClick={() => void rules.refetch()}>
          {t('admin.kit.table.retry')}
        </Button>
      </div>
    );
  // Not keyed by version: a save reads the rules again, and a remount would drop its notice (the draft equals what was saved).
  return <RulesForm rules={rules.data} />;
}

const RULE_PROBLEM: Record<RulesProblem, MessageKey> = {
  delay: 'admin.notif.rules.problem.delay',
  invitationDays: 'admin.notif.rules.problem.days',
  approvalDays: 'admin.notif.rules.problem.days',
  quietStart: 'admin.notif.rules.problem.time',
  quietEnd: 'admin.notif.rules.problem.quietEnd',
  digestHour: 'admin.notif.rules.problem.hour',
  maintenanceDays: 'admin.notif.rules.problem.maintenance',
  mileageKm: 'admin.notif.rules.problem.mileage',
  odometerDays: 'admin.notif.rules.problem.odometer',
};

function RulesForm({ rules }: { rules: NotificationRules }) {
  const t = useT();
  const f = useFormat();
  const uid = useId();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RulesDraft>(() => rulesDraftOf(rules));
  const [tried, setTried] = useState(false);
  const [dialog, setDialog] = useState(false);
  const action = useAdminAction('admin.notif_rules_update', {
    target: 'notification_rules',
    onOutcome: () => void queryClient.invalidateQueries({ queryKey: RULES_KEY }),
  });
  const result = rulesWriteOf(rules, draft);
  const problems = 'problems' in result ? result.problems : [];
  const unchanged = JSON.stringify(draft) === JSON.stringify(rulesDraftOf(rules));
  const err = (p: RulesProblem) => (tried && problems.includes(p) ? t(RULE_PROBLEM[p]) : undefined);
  const set = (patch: Partial<RulesDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const num = { inputMode: 'numeric' as const, dir: 'ltr' as const, autoComplete: 'off' };

  return (
    <form
      className="adm-form"
      noValidate
      data-testid="notif-rules"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!('value' in result) || unchanged) return;
        action.reset();
        setDialog(true);
      }}
    >
      <p className="adm-muted">
        {t('admin.notif.rules.updated', {
          name: rules.updated_by_display ?? t('admin.notif.rules.system'),
          at: f.date(rules.updated_at, 'dateTime'),
        })}
      </p>
      <fieldset className="adm-choices">
        <legend>{t('admin.notif.rules.invitations')}</legend>
        <TextField
          label={t('admin.notif.rules.delay')}
          hint={t('admin.notif.rules.delayHint')}
          error={err('delay')}
          value={draft.delay}
          maxLength={4}
          {...num}
          onChange={(e) => set({ delay: e.target.value })}
        />
        <TextField
          label={t('admin.notif.rules.invitationDays')}
          hint={t('admin.notif.rules.daysHint')}
          error={err('invitationDays')}
          value={draft.invitationDays}
          maxLength={20}
          {...num}
          onChange={(e) => set({ invitationDays: e.target.value })}
        />
        <TextField
          label={t('admin.notif.rules.approvalDays')}
          hint={t('admin.notif.rules.approvalDaysHint')}
          error={err('approvalDays')}
          value={draft.approvalDays}
          maxLength={20}
          {...num}
          onChange={(e) => set({ approvalDays: e.target.value })}
        />
      </fieldset>
      <fieldset className="adm-choices">
        <legend>{t('admin.notif.rules.delivery')}</legend>
        <Check checked={draft.quiet} onChange={(e) => set({ quiet: e.target.checked })} hint={t('admin.notif.rules.quietHint')}>
          {t('admin.notif.rules.quiet')}
        </Check>
        {draft.quiet ? (
          <>
            <TextField
              type="time"
              label={t('admin.notif.rules.quietStart')}
              error={err('quietStart')}
              value={draft.quietStart}
              onChange={(e) => set({ quietStart: e.target.value })}
            />
            <TextField
              type="time"
              label={t('admin.notif.rules.quietEnd')}
              error={err('quietEnd')}
              value={draft.quietEnd}
              onChange={(e) => set({ quietEnd: e.target.value })}
            />
          </>
        ) : null}
        <TextField
          label={t('admin.notif.rules.digestHour')}
          hint={t('admin.notif.rules.digestHourHint')}
          error={err('digestHour')}
          value={draft.digestHour}
          maxLength={2}
          {...num}
          onChange={(e) => set({ digestHour: e.target.value })}
        />
        <div className="cp-field">
          <label className="cp-field-label" htmlFor={`${uid}-weekly`}>
            {t('admin.notif.rules.weeklyDay')}
          </label>
          <div className="cp-field-box">
            <select
              id={`${uid}-weekly`}
              className="cp-field-input adm-select"
              value={draft.weeklyDay}
              onChange={(e) => set({ weeklyDay: e.target.value })}
            >
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <option key={d} value={String(d)}>
                  {t(`admin.notif.rules.weekday.${d}` as MessageKey)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>
      <fieldset className="adm-choices">
        <legend>{t('admin.notif.rules.vehicles')}</legend>
        <TextField
          label={t('admin.notif.rules.maintenanceDays')}
          hint={t('admin.notif.rules.maintenanceHint')}
          error={err('maintenanceDays')}
          value={draft.maintenanceDays}
          maxLength={2}
          {...num}
          onChange={(e) => set({ maintenanceDays: e.target.value })}
        />
        <TextField
          label={t('admin.notif.rules.mileageKm')}
          hint={t('admin.notif.rules.mileageHint')}
          error={err('mileageKm')}
          value={draft.mileageKm}
          maxLength={4}
          {...num}
          onChange={(e) => set({ mileageKm: e.target.value })}
        />
        <TextField
          label={t('admin.notif.rules.odometerDays')}
          hint={t('admin.notif.rules.odometerHint')}
          error={err('odometerDays')}
          value={draft.odometerDays}
          maxLength={2}
          {...num}
          onChange={(e) => set({ odometerDays: e.target.value })}
        />
      </fieldset>
      <p className="adm-muted">{t('admin.notif.rules.alwaysNote')}</p>
      <div className="adm-actions">
        <Button type="submit" variant="primary" disabled={unchanged} loading={action.state.status === 'busy'}>
          {t('admin.notif.rules.save')}
        </Button>
        <Button type="button" variant="ghost" disabled={unchanged} onClick={() => setDraft(rulesDraftOf(rules))}>
          {t('admin.notif.undo')}
        </Button>
      </div>
      <ActionNotice
        state={action.state}
        applied={t('admin.notif.rules.saved')}
        onReload={() => void queryClient.invalidateQueries({ queryKey: RULES_KEY })}
      />
      <ReasonDialog
        open={dialog}
        onClose={() => setDialog(false)}
        kind="setting_change"
        title={t('admin.notif.rules.dialog')}
        confirmLabel={t('admin.notif.rules.save')}
        summary={<p className="adm-muted">{t('admin.notif.rules.effect')}</p>}
        onSubmit={(reason) => {
          setDialog(false);
          if ('value' in result) void action.run({ body: { ...result.value, reason }, reason, ifMatch: ifMatchOf(rules.version) });
        }}
        name="notif-rules"
      />
    </form>
  );
}

function HealthTab() {
  const t = useT();
  const f = useFormat();
  const q = useApiQuery('admin.notif_delivery_health', { background: true }, { refetchInterval: 60_000 });
  if (q.isPending) return <p role="status">{t('admin.work.loading')}</p>;
  if (q.error || !q.data)
    return (
      <div className="adm-table-error">
        <Banner tone="danger" text={q.error ? problemText(q.error, t) : t('admin.kit.problem.other')} />
        <Button size="sm" icon="refresh" onClick={() => void q.refetch()}>
          {t('admin.kit.table.retry')}
        </Button>
      </div>
    );
  const rows = q.data.rows;
  const cell = (w: DeliveryHealthWindow) => {
    const pct = ratePercent(w.failure_rate);
    return (
      <>
        {t('admin.notif.health.counts', { failed: f.number(w.failed), attempted: f.number(w.attempted) })}
        {pct !== null ? (
          <>
            {' · '}
            <span data-high={pct >= 5 ? 'true' : 'false'}>
              {t('admin.notif.health.rate', { pct: f.number(pct, { maximumFractionDigits: 1 }) })}
            </span>
          </>
        ) : null}
      </>
    );
  };
  return (
    <section data-testid="notif-health" aria-labelledby="notif-health-title">
      <h2 id="notif-health-title" className="adm-panel-title">
        {t('admin.notif.tab.health')}
      </h2>
      <p className="adm-muted">{t('admin.notif.health.intro', { at: f.date(q.data.generated_at, 'dateTime') })}</p>
      {rows.length === 0 ? (
        <p className="adm-muted">{t('admin.notif.health.empty')}</p>
      ) : (
        <table className="adm-table">
          <caption className="sr-only">{t('admin.notif.tab.health')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('admin.notif.col.channel')}</th>
              <th scope="col">{t('admin.notif.health.provider')}</th>
              <th scope="col">{t('admin.notif.health.h24')}</th>
              <th scope="col">{t('admin.notif.health.d7')}</th>
              <th scope="col">{t('admin.notif.health.d30')}</th>
              <th scope="col">{t('admin.notif.health.lastFailure')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.channel}|${r.provider}`} data-channel={r.channel} data-provider={r.provider}>
                <th scope="row">{channelLabel(r.channel, t)}</th>
                <td>
                  <Bidi ltr>{r.provider}</Bidi>
                </td>
                <td>{cell(r.last_24h)}</td>
                <td>{cell(r.last_7d)}</td>
                <td>{cell(r.last_30d)}</td>
                <td>{r.last_failure_at ? f.date(r.last_failure_at, 'dateTime') : t('admin.notif.health.none')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
