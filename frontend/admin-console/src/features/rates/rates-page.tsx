'use client';
// Exchange rates (AC6.T1; new screen, not in Docs/23; Docs/40 §23.5, GD-41): prices are stored in US dollars and
// every app shows them in the region's display currency at the rate set here (config.client). The list shows each
// display currency with its amount per US dollar, who changed it last and whether it was set today; the editor
// previews sample prices at the current and the new rate, warns when the change is over 20 % (a second platform admin
// must approve it, SEC-ADM-6), asks for a reason and sends the record's version as If-Match. Someone else's change
// meanwhile (412) is explained with a Reload that keeps the typed rate. This replaces the one-time SQL of
// backend/deploy/deploy.md. The editor opens the rate's audit trail (AC13: rates carry their audit id since backend S21).
// Daily workflow (AC14b.T3, owner decision 2026-11-16, backend S26a): the IRR rate is set every morning. A rate not set
// today (ExchangeRate.set_today, the region's day) is badged and opened first, "Set today's rate" is the main action,
// and an unchanged rate can be kept for today (the same value saved again: the database stamps updated_at, so
// set_today turns true). The reason comes prefilled ("Daily rate DD/MM", editable). The morning staff notice and the
// dashboard rate card open this page.
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { ExchangeRate } from '@carpal/api-contracts';
import { ActionNotice, AuditDrawer, DataTable, ReasonDialog, useAdminAction, type Column } from '@/components/admin';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { ifMatchOf } from '@/lib/api/client';
import { useApiQuery } from '@/lib/api/query';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { formatMoney } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { changeRatio, dailyReasonDate, needsSecondApprover, parseRate, SAMPLE_USD } from './rate-logic';

const LIST_KEY = ['admin.exchange_rates_list'] as const;

/** The rate the page opens: the one in the URL, else the first not set today, else the only one. */
export function rateToOpen(items: readonly ExchangeRate[] | undefined, code: string | null): ExchangeRate | null {
  if (!items) return null;
  return items.find((r) => r.currency === code) ?? items.find((r) => !r.set_today) ?? (items.length === 1 ? items[0]! : null);
}

export function RatesPage() {
  const t = useT();
  const f = useFormat();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const list = useApiQuery('admin.exchange_rates_list', undefined);
  const items = list.data?.items;
  // A rate opened without ?currency= (the first not set today) stays open once it is set (it would no longer be picked).
  const [opened, setOpened] = useState<string | null>(null);
  const selected = rateToOpen(items, params.get('currency') ?? opened);
  if (selected && !params.get('currency') && opened !== selected.currency) setOpened(selected.currency);

  const select = (rate: ExchangeRate) => {
    const p = new URLSearchParams(params);
    p.set('currency', rate.currency);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  const columns: Column<ExchangeRate>[] = [
    { id: 'currency', header: t('admin.rates.col.currency'), pinned: true, cell: (r, ctx) => <Bidi ltr>{ctx.digits(r.currency)}</Bidi> },
    {
      id: 'per_usd',
      header: t('admin.rates.col.perUsd'),
      align: 'end',
      cell: (r) => <span data-testid={`rate-${r.currency}`}>{f.number(Number(r.per_usd), { maximumFractionDigits: 4 })}</span>,
    },
    {
      id: 'today',
      header: t('admin.rates.col.today'),
      cell: (r) => (
        <span data-testid={`rate-today-${r.currency}`} data-set={r.set_today ? 'true' : 'false'}>
          {r.set_today ? (
            <Badge tone="success" icon="check">
              {t('admin.rates.setToday')}
            </Badge>
          ) : (
            <Badge tone="signal" icon="clock">
              {t('admin.rates.notSetToday')}
            </Badge>
          )}
        </span>
      ),
    },
    { id: 'updated_by', header: t('admin.rates.col.updatedBy'), cell: (r) => <Bidi>{r.updated_by_display}</Bidi> },
    {
      id: 'updated_at',
      header: t('admin.rates.col.updatedAt'),
      cell: (r, ctx) => (
        <time dateTime={r.updated_at} title={ctx.digits(f.date(r.updated_at, 'dateTime'))}>
          {ctx.digits(f.relative(r.updated_at))}
        </time>
      ),
    },
  ];

  return (
    <div className="adm-page" data-testid="rates-page">
      <h1 className="adm-page-title">{t('admin.rates.title')}</h1>
      <p className="adm-measure">{t('admin.rates.intro')}</p>
      <p className="adm-muted adm-measure">{t('admin.rates.daily')}</p>
      <p className="adm-muted adm-measure">{t('admin.rates.displayOnly')}</p>
      <DataTable
        id="rates"
        caption={t('admin.rates.listLabel')}
        columns={columns}
        rows={items}
        rowKey={(r) => r.currency}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        emptyText={t('admin.rates.empty')}
        selectedKey={selected?.currency ?? null}
        onSelect={select}
      />
      {selected ? (
        <RateEditor
          key={selected.currency}
          rate={selected}
          onReload={() => void list.refetch()}
          onChanged={() => void queryClient.invalidateQueries({ queryKey: LIST_KEY })}
        />
      ) : (
        <p className="adm-muted">{t('admin.rates.pick')}</p>
      )}
    </div>
  );
}

function RateEditor({ rate, onReload, onChanged }: { rate: ExchangeRate; onReload: () => void; onChanged: () => void }) {
  const t = useT();
  const f = useFormat();
  const [input, setInput] = useState('');
  const [tried, setTried] = useState(false);
  // The dialog confirms either the typed rate or the current rate kept for today.
  const [dialog, setDialog] = useState<'set' | 'keep' | null>(null);
  const action = useAdminAction('admin.exchange_rate_update', {
    target: rate.currency,
    onOutcome: (o) => {
      onChanged();
      if (o.kind === 'applied') setInput('');
    },
  });
  const parsed = parseRate(input, rate.per_usd);
  const typed = 'value' in parsed ? parsed.value : null;
  const next = dialog === 'keep' ? rate.per_usd : typed;
  const ratio = typed ? changeRatio(rate.per_usd, typed) : 0;
  const fourEyes = typed ? needsSecondApprover(rate.per_usd, typed) : false;
  const busy = action.state.status === 'busy';
  const rawProblem = 'problem' in parsed && (tried || parsed.problem === 'format') && input.trim() !== '' ? parsed.problem : null;
  // The same rate typed again: before today's rate is set, point to "Keep this rate for today".
  const problem: MessageKey | null = rawProblem
    ? rawProblem === 'same' && !rate.set_today
      ? 'admin.rates.problem.sameKeep'
      : (`admin.rates.problem.${rawProblem}` as MessageKey)
    : null;
  const money = (usd: number, perUsd: string) => formatMoney(usd, 'USD', f.locale, t, { currency: rate.currency, perUsd: Number(perUsd) });
  const amount = (perUsd: string) => f.number(Number(perUsd), { maximumFractionDigits: 4 });
  const setLabel = fourEyes ? t('admin.rates.saveForApproval') : t('admin.rates.setTodayAction');

  const save = () => {
    setTried(true);
    if (!typed || busy) return;
    action.reset();
    setDialog('set');
  };
  const keep = () => {
    if (busy) return;
    action.reset();
    setDialog('keep');
  };
  const submit = (reason: string) => {
    if (!next) return;
    setDialog(null);
    void action.run({ path: { currency: rate.currency }, body: { per_usd: next, reason }, reason, ifMatch: ifMatchOf(rate.version) });
  };
  const pct = f.number(ratio * 100, { maximumFractionDigits: 1, signDisplay: 'exceptZero' });
  const lastSet = { name: rate.updated_by_display, when: f.date(rate.updated_at, 'dateTime'), ago: f.relative(rate.updated_at) };

  return (
    <section className="adm-panel" aria-labelledby="rate-editor-title" data-testid="rate-editor" data-currency={rate.currency}>
      <h2 id="rate-editor-title" className="adm-panel-title">
        {t('admin.rates.editTitle', { currency: rate.currency })}
      </h2>
      <div data-testid="rate-today" data-set={rate.set_today ? 'true' : 'false'}>
        {rate.set_today ? (
          <Banner tone="success" text={t('admin.rates.todayDone', lastSet)} />
        ) : (
          <Banner
            tone="warn"
            title={t('admin.rates.notSetToday')}
            text={t('admin.rates.todayMissing', { ...lastSet, currency: rate.currency })}
          />
        )}
      </div>
      <dl className="adm-facts">
        <div>
          <dt>{t('admin.rates.current')}</dt>
          <dd data-testid="rate-current">{t('admin.rates.perUsd', { amount: amount(rate.per_usd), currency: rate.currency })}</dd>
        </div>
        <div>
          <dt>{t('admin.rates.col.updatedBy')}</dt>
          <dd>
            <Bidi>{rate.updated_by_display}</Bidi> · {lastSet.when}
          </dd>
        </div>
      </dl>
      {/* The rate's history by its audit id (backend S21, BR-26; AC13.T1). */}
      <AuditDrawer entityType="exchange_rate" entityId={rate.id} label={rate.currency} />
      <form
        className="adm-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <TextField
          label={t('admin.rates.newLabel', { currency: rate.currency })}
          hint={t('admin.rates.newHint')}
          error={problem ? t(problem) : undefined}
          value={input}
          inputMode="decimal"
          autoComplete="off"
          dir="ltr"
          maxLength={24}
          onChange={(e) => setInput(e.target.value)}
        />
        <div className="adm-preview" data-testid="rate-preview" aria-live="polite">
          <p className="adm-preview-title">{t('admin.rates.preview')}</p>
          <table className="adm-mini-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.rates.previewPrice')}</th>
                <th scope="col">{t('admin.rates.previewNow')}</th>
                <th scope="col">{t('admin.rates.previewNew')}</th>
              </tr>
            </thead>
            <tbody>
              {SAMPLE_USD.map((usd) => (
                <tr key={usd}>
                  <th scope="row">{t('format.currency.usd', { amount: f.number(usd) })}</th>
                  <td>{money(usd, rate.per_usd)}</td>
                  <td>{typed ? money(usd, typed) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {typed ? <p data-testid="rate-change">{t('admin.rates.change', { pct })}</p> : null}
        </div>
        {fourEyes ? (
          <div data-testid="rate-four-eyes-warning">
            <Banner tone="warn" title={t('admin.rates.bigTitle')} text={t('admin.rates.bigText')} />
          </div>
        ) : null}
        <div className="adm-actions">
          <Button type="submit" variant="primary" icon="check" loading={busy && dialog !== 'keep'}>
            {setLabel}
          </Button>
          {rate.set_today ? null : (
            <Button type="button" variant="secondary" disabled={busy} onClick={keep}>
              {t('admin.rates.keep', { amount: amount(rate.per_usd), currency: rate.currency })}
            </Button>
          )}
        </div>
      </form>
      <ActionNotice state={action.state} applied={t('admin.rates.applied')} onReload={onReload} />
      <p className="adm-muted adm-measure">{t('admin.rates.refreshHint')}</p>
      <ReasonDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind="setting_change"
        title={t(dialog === 'keep' ? 'admin.rates.keepTitle' : 'admin.rates.dialogTitle', { currency: rate.currency })}
        confirmLabel={dialog === 'keep' ? t('admin.rates.keepConfirm') : setLabel}
        initial={{ code: 'planned_change', note: t('admin.rates.dailyReason', { date: dailyReasonDate() }) }}
        summary={
          dialog === 'keep' ? (
            <p>{t('admin.rates.keepSummary', { currency: rate.currency, amount: amount(rate.per_usd) })}</p>
          ) : typed ? (
            <>
              <p>{t('admin.rates.dialogSummary', { currency: rate.currency, from: amount(rate.per_usd), to: amount(typed), pct })}</p>
              {fourEyes ? <p className="adm-muted">{t('admin.rates.bigText')}</p> : null}
            </>
          ) : null
        }
        onSubmit={submit}
        name="rate"
      />
    </section>
  );
}
