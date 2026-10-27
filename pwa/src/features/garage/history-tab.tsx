'use client';
// W-GAR-01 Service History tab (W-GAR-02, C-GARAGE-02): on desktop a table (date, work, shop, mileage, cost, source
// mark Verified / Added by you, attachments) with sortable columns, filters (category, verified only, date range —
// server-side through service_records.list) and a Timeline toggle (newest first, grouped by year; the only view on
// phones). Print / Export opens the buyer-friendly print view; "N" adds a record (not while typing). A row opens the
// record drawer (?modal=record&record=<id>). The AI history summary sits below (AI-off aware).
import type { ServiceRecord, Vehicle } from '@carpal/api-contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ds/badge';
import { Button, buttonClass } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { DateField } from '@/components/fields/date-field';
import { SelectField } from '@/components/fields/select-field';
import { ErrorState } from '@/components/shell/error-boundary';
import { SkeletonList } from '@/components/shell/skeleton';
import { StateView } from '@/components/shell/states';
import { useUrlModal } from '@/components/shell/url-modal';
import { useFormat } from '@/lib/format/client';
import { gregorianToJalali, parseIsoDate } from '@/lib/format/jalali';
import { useLocale, useT } from '@/lib/i18n/client';
import { TABLET_UP, useMediaQuery } from '@/lib/media-query';
import { HistoryAiSummary } from './ai';
import { useRecords, type HistoryFilters } from './hooks';
import { garagePath, groupByYear, isVerified, recordPath, sortRecords, type RecordSort } from './model';
import { useNodeNames } from './names';
import { RecordDrawer } from './record-drawer';

export function HistoryTab({ vehicle: v, readOnly }: { vehicle: Vehicle; readOnly: boolean }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const wide = useMediaQuery(TABLET_UP);
  const systems = useNodeNames('service_system');
  const [filters, setFilters] = useState<HistoryFilters>({});
  const [view, setView] = useState<'table' | 'timeline'>('table');
  const [sort, setSort] = useState<{ by: RecordSort; dir: 'asc' | 'desc' }>({ by: 'date', dir: 'desc' });
  const records = useRecords(v.id, filters);
  const drawer = useUrlModal('record', ['record']);
  const list = (records.data?.pages ?? []).flatMap((p) => p.items).filter((r) => r.status !== 'removed');
  const newHref = recordPath(locale, v.id, 'new');

  // "N" adds a record on this tab (Docs/22 W-GAR-01), never while typing or with a modifier.
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      router.push(newHref);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [readOnly, router, newHref]);

  const filtered = !!(filters.systemId || filters.verifiedOnly || filters.from || filters.to);
  const showTable = wide && view === 'table';

  return (
    <div className="pwa-tab-stack">
      <div className="pwa-toolbar">
        {!readOnly ? (
          <Link href={newHref} className={buttonClass({ variant: 'primary', size: 'sm' })} aria-keyshortcuts="N">
            <Icon name="plus" size={20} />
            <span className="cp-btn-label">{t('garage.history.add')}</span>
          </Link>
        ) : null}
        <Link href={garagePath(locale, v.id, 'print')} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
          <Icon name="doc" size={20} />
          <span className="cp-btn-label">{t('garage.history.print')}</span>
        </Link>
        {wide ? (
          <div className="pwa-segmented" role="group" aria-label={t('garage.history.viewLabel')}>
            <button
              type="button"
              className={cx('pwa-segment', view === 'table' && 'is-active')}
              aria-pressed={view === 'table'}
              onClick={() => setView('table')}
            >
              <Icon name="list" size={20} />
              {t('garage.history.table')}
            </button>
            <button
              type="button"
              className={cx('pwa-segment', view === 'timeline' && 'is-active')}
              aria-pressed={view === 'timeline'}
              onClick={() => setView('timeline')}
            >
              <Icon name="clock" size={20} />
              {t('garage.history.timeline')}
            </button>
          </div>
        ) : null}
      </div>

      <details className="pwa-history-filters" open={filtered}>
        <summary className="pwa-history-filters-summary">
          <Icon name="filter" size={20} />
          {t('garage.history.filters')}
        </summary>
        <div className="pwa-history-filters-grid">
          <SelectField
            label={t('garage.history.category')}
            value={filters.systemId ?? ''}
            onChange={(id) => setFilters((f) => ({ ...f, systemId: id || undefined }))}
            placeholder={t('garage.history.allCategories')}
            options={systems.nodes.map((n) => ({ value: n.id, label: n.name.text }))}
          />
          <DateField
            label={t('garage.history.from')}
            value={filters.from ?? ''}
            onChange={(from) => setFilters((f) => ({ ...f, from: from || undefined }))}
            optional
          />
          <DateField
            label={t('garage.history.to')}
            value={filters.to ?? ''}
            onChange={(to) => setFilters((f) => ({ ...f, to: to || undefined }))}
            optional
          />
          <Check
            checked={!!filters.verifiedOnly}
            onChange={(e) => setFilters((f) => ({ ...f, verifiedOnly: e.target.checked || undefined }))}
          >
            {t('garage.history.verifiedOnly')}
          </Check>
        </div>
        {filtered ? (
          <Button size="sm" variant="ghost" onClick={() => setFilters({})}>
            {t('garage.history.clearFilters')}
          </Button>
        ) : null}
      </details>

      {records.isPending ? (
        <SkeletonList count={3} label={t('garage.loading')} />
      ) : records.isError ? (
        <ErrorState error={records.error} onRetry={() => void records.refetch()} compact />
      ) : list.length === 0 ? (
        <StateView
          kind="empty"
          t={t}
          compact
          title={filtered ? t('garage.history.noMatch') : t('garage.history.emptyTitle')}
          text={filtered ? undefined : t('garage.history.emptyText')}
        />
      ) : showTable ? (
        <HistoryTable
          records={sortRecords(list, sort.by, sort.dir)}
          sort={sort}
          onSort={setSort}
          onOpen={(id) => drawer.open({ record: id })}
        />
      ) : (
        <Timeline records={list} onOpen={(id) => drawer.open({ record: id })} />
      )}
      {records.hasNextPage ? (
        <div>
          <Button size="sm" variant="secondary" loading={records.isFetchingNextPage} onClick={() => void records.fetchNextPage()}>
            {t('common.actions.loadMore')}
          </Button>
        </div>
      ) : null}

      {!readOnly && list.length > 0 ? <HistoryAiSummary vehicle={v} /> : null}
      <RecordDrawer vehicle={v} recordId={drawer.isOpen ? drawer.params.get('record') : null} onClose={drawer.close} readOnly={readOnly} />
    </div>
  );
}

function useRecordText() {
  const systems = useNodeNames('service_system');
  return (r: ServiceRecord) => systems.name(r.service_system_node_id) ?? '—';
}

function SourceMark({ record }: { record: ServiceRecord }) {
  const t = useT();
  return isVerified(record) ? (
    <Badge tone="success" icon="shield">
      {t('garage.record.verified')}
    </Badge>
  ) : (
    <Badge tone="neutral" icon="user">
      {t('garage.record.addedByYou')}
    </Badge>
  );
}

function HistoryTable({
  records,
  sort,
  onSort,
  onOpen,
}: {
  records: ServiceRecord[];
  sort: { by: RecordSort; dir: 'asc' | 'desc' };
  onSort: (s: { by: RecordSort; dir: 'asc' | 'desc' }) => void;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const f = useFormat();
  const work = useRecordText();
  const header = (by: RecordSort, label: string) => (
    <th scope="col" aria-sort={sort.by === by ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className="pwa-sort-button"
        onClick={() => onSort({ by, dir: sort.by === by && sort.dir === 'desc' ? 'asc' : 'desc' })}
      >
        {label}
        {sort.by === by ? <Icon name={sort.dir === 'asc' ? 'up' : 'down'} size={16} /> : null}
      </button>
    </th>
  );
  return (
    <div className="pwa-table-wrap">
      <table className="pwa-table" data-testid="history-table">
        <caption className="sr-only">{t('garage.history.caption')}</caption>
        <thead>
          <tr>
            {header('date', t('garage.history.date'))}
            <th scope="col">{t('garage.history.work')}</th>
            <th scope="col">{t('garage.history.shop')}</th>
            {header('mileage', t('garage.history.mileage'))}
            {header('cost', t('garage.history.cost'))}
            <th scope="col">{t('garage.history.source')}</th>
            <th scope="col">
              <span className="sr-only">{t('garage.history.attachments')}</span>
              <Icon name="attach" size={16} />
            </th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.id}>
              <td className="pwa-nowrap">{f.calendarDate(r.service_date)}</td>
              <td>
                <button type="button" className="pwa-link pwa-row-open" onClick={() => onOpen(r.id)} dir="auto">
                  {work(r)}
                </button>
                {r.description ? (
                  <span className="pwa-text-caption pwa-clamp" dir="auto">
                    {r.description}
                  </span>
                ) : null}
              </td>
              <td dir="auto">{r.provider?.name ?? '—'}</td>
              <td className="pwa-nowrap">{r.mileage_km !== undefined ? t('garage.mileageValue', { km: f.number(r.mileage_km) }) : '—'}</td>
              <td className="pwa-nowrap">{r.cost ? f.money(r.cost.amount, r.cost.currency) : '—'}</td>
              <td>
                <SourceMark record={r} />
              </td>
              <td>
                {r.evidence.filter((e) => e.status === 'active').length > 0 ? (
                  <Icon name="attach" size={20} label={t('garage.history.hasAttachments')} />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function jalaliYear(iso: string): number {
  const d = parseIsoDate(iso);
  return d ? gregorianToJalali(d.year, d.month, d.day).year : Number(iso.slice(0, 4));
}

function Timeline({ records, onOpen }: { records: ServiceRecord[]; onOpen: (id: string) => void }) {
  const t = useT();
  const f = useFormat();
  const work = useRecordText();
  return (
    <div className="pwa-timeline" data-testid="history-timeline">
      {groupByYear(records, (d) => (f.locale === 'fa' ? jalaliYear(d) : Number(d.slice(0, 4)))).map((g) => (
        <section key={g.year} aria-labelledby={`year-${g.year}`}>
          <h3 id={`year-${g.year}`} className="pwa-timeline-year">
            {f.digits(g.year)}
          </h3>
          <ul className="pwa-plain-list">
            {g.records.map((r) => (
              <li key={r.id}>
                <button type="button" className="pwa-timeline-item" onClick={() => onOpen(r.id)}>
                  <span className="pwa-timeline-date">{f.calendarDate(r.service_date, 'dateShort')}</span>
                  <span className="pwa-timeline-body">
                    <span className="pwa-choice-title" dir="auto">
                      {work(r)}
                    </span>
                    <span className="pwa-text-caption" dir="auto">
                      {[
                        r.provider?.name,
                        r.mileage_km !== undefined ? t('garage.mileageValue', { km: f.number(r.mileage_km) }) : null,
                        r.cost ? f.money(r.cost.amount, r.cost.currency) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <SourceMark record={r} />
                  {r.evidence.some((e) => e.status === 'active') ? (
                    <Icon name="attach" size={20} label={t('garage.history.hasAttachments')} />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
