'use client';
// Exchange rates (AC6.T1; new screen, not in Docs/23; Docs/40 §23.5, GD-41): prices are stored in US dollars and
// every app shows them in the region's display currency at the rate set here (config.client). The list shows each
// display currency with its amount per US dollar and who changed it last; the editor previews sample prices at the
// current and the new rate, warns when the change is over 20 % (a second platform admin must approve it, SEC-ADM-6),
// asks for a reason and sends the record's version as If-Match. Someone else's change meanwhile (412) is explained
// with a Reload that keeps the typed rate. This replaces the one-time SQL of backend/deploy/deploy.md.
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { ExchangeRate } from '@carpal/api-contracts';
import { ActionNotice, DataTable, ReasonDialog, useAdminAction, type Column } from '@/components/admin';
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
import { changeRatio, needsSecondApprover, parseRate, SAMPLE_USD } from './rate-logic';

const LIST_KEY = ['admin.exchange_rates_list'] as const;

export function RatesPage() {
  const t = useT();
  const f = useFormat();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const list = useApiQuery('admin.exchange_rates_list', undefined);
  const items = list.data?.items;
  const selectedCode = params.get('currency');
  const selected = items?.find((r) => r.currency === selectedCode) ?? null;

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
    { id: 'updated_by', header: t('admin.rates.col.updatedBy'), cell: (r) => <Bidi>{r.updated_by_display}</Bidi> },
    {
      id: 'updated_at',
      header: t('admin.rates.col.updatedAt'),
      cell: (r, ctx) => <time dateTime={r.updated_at}>{ctx.digits(f.date(r.updated_at, 'dateTime'))}</time>,
    },
  ];

  return (
    <div className="adm-page" data-testid="rates-page">
      <h1 className="adm-page-title">{t('admin.rates.title')}</h1>
      <p className="adm-measure">{t('admin.rates.intro')}</p>
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
  const [dialog, setDialog] = useState(false);
  const action = useAdminAction('admin.exchange_rate_update', {
    target: rate.currency,
    onOutcome: (o) => {
      onChanged();
      if (o.kind === 'applied') setInput('');
    },
  });
  const parsed = parseRate(input, rate.per_usd);
  const next = 'value' in parsed ? parsed.value : null;
  const ratio = next ? changeRatio(rate.per_usd, next) : 0;
  const fourEyes = next ? needsSecondApprover(rate.per_usd, next) : false;
  const busy = action.state.status === 'busy';
  const problem = 'problem' in parsed && (tried || parsed.problem === 'format') && input.trim() !== '' ? parsed.problem : null;
  const money = (usd: number, perUsd: string) => formatMoney(usd, 'USD', f.locale, t, { currency: rate.currency, perUsd: Number(perUsd) });

  const save = () => {
    setTried(true);
    if (!next || busy) return;
    action.reset();
    setDialog(true);
  };
  const submit = (reason: string) => {
    if (!next) return;
    setDialog(false);
    void action.run({ path: { currency: rate.currency }, body: { per_usd: next, reason }, reason, ifMatch: ifMatchOf(rate.version) });
  };
  const pct = f.number(ratio * 100, { maximumFractionDigits: 1, signDisplay: 'exceptZero' });

  return (
    <section className="adm-panel" aria-labelledby="rate-editor-title" data-testid="rate-editor" data-currency={rate.currency}>
      <h2 id="rate-editor-title" className="adm-panel-title">
        {t('admin.rates.editTitle', { currency: rate.currency })}
      </h2>
      <dl className="adm-facts">
        <div>
          <dt>{t('admin.rates.current')}</dt>
          <dd data-testid="rate-current">
            {t('admin.rates.perUsd', { amount: f.number(Number(rate.per_usd), { maximumFractionDigits: 4 }), currency: rate.currency })}
          </dd>
        </div>
        <div>
          <dt>{t('admin.rates.col.updatedBy')}</dt>
          <dd>
            <Bidi>{rate.updated_by_display}</Bidi> · {f.date(rate.updated_at, 'dateTime')}
          </dd>
        </div>
      </dl>
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
          error={problem ? t(`admin.rates.problem.${problem}` as MessageKey) : undefined}
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
                  <td>{next ? money(usd, next) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {next ? <p data-testid="rate-change">{t('admin.rates.change', { pct })}</p> : null}
        </div>
        {fourEyes ? (
          <div data-testid="rate-four-eyes-warning">
            <Banner tone="warn" title={t('admin.rates.bigTitle')} text={t('admin.rates.bigText')} />
          </div>
        ) : null}
        <div className="adm-actions">
          <Button type="submit" variant="primary" icon="check" loading={busy}>
            {fourEyes ? t('admin.rates.saveForApproval') : t('admin.rates.save')}
          </Button>
        </div>
      </form>
      <ActionNotice state={action.state} applied={t('admin.rates.applied')} onReload={onReload} />
      <p className="adm-muted adm-measure">{t('admin.rates.refreshHint')}</p>
      <ReasonDialog
        open={dialog}
        onClose={() => setDialog(false)}
        kind="setting_change"
        title={t('admin.rates.dialogTitle', { currency: rate.currency })}
        confirmLabel={fourEyes ? t('admin.rates.saveForApproval') : t('admin.rates.save')}
        summary={
          next ? (
            <>
              <p>
                {t('admin.rates.dialogSummary', {
                  currency: rate.currency,
                  from: f.number(Number(rate.per_usd), { maximumFractionDigits: 4 }),
                  to: f.number(Number(next), { maximumFractionDigits: 4 }),
                  pct,
                })}
              </p>
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
