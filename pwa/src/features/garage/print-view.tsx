'use client';
// W-GAR-01 "Print / Export PDF" (Docs/22, Story Ch. 10): a buyer-friendly layout of the whole service history — the
// car (model, year, mileage, VIN ending only; no plate, nickname or notes), every record with date, work, shop, mileage,
// optional cost and its source mark, and what "Verified" means. The browser's print dialog makes the PDF ("Save as
// PDF"); print CSS hides the app shell and the controls. Costs can be left out (?costs=0).
import type { ServiceRecord } from '@carpal/api-contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, buttonClass } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { ErrorState } from '@/components/shell/error-boundary';
import { SkeletonCard } from '@/components/shell/skeleton';
import { useApiClient } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { PAGE, useVehicle } from './hooks';
import { garagePath, isVerified, sortRecords } from './model';
import { useModelName, useNodeNames } from './names';

export function PrintView({ vehicleId }: { vehicleId: string }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const router = useRouter();
  const search = useSearchParams();
  const api = useApiClient();
  const vehicle = useVehicle(vehicleId);
  const systems = useNodeNames('service_system');
  const { full } = useModelName(vehicle.data ?? null);
  const costs = search.get('costs') !== '0';
  const [records, setRecords] = useState<ServiceRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [madeAt] = useState(() => Date.now());

  useEffect(() => {
    let stop = false;
    (async () => {
      const all: ServiceRecord[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: ServiceRecord[]; next_cursor: string | null } = await api.api('service_records.list', {
          path: { vehicle_id: vehicleId },
          query: { limit: PAGE, ...(cursor ? { cursor } : {}) },
        });
        all.push(...page.items);
        cursor = page.next_cursor;
      } while (cursor && all.length < 1000 && !stop);
      if (!stop)
        setRecords(
          sortRecords(
            all.filter((r) => r.status !== 'removed'),
            'date',
            'desc',
          ),
        );
    })().catch(() => !stop && setFailed(true));
    return () => {
      stop = true;
    };
  }, [api, vehicleId]);

  if (vehicle.isError) return <ErrorState error={vehicle.error} onRetry={() => void vehicle.refetch()} />;
  if (!vehicle.data || (!records && !failed)) return <SkeletonCard lines={8} />;
  const v = vehicle.data;
  return (
    <article className="pwa-print" data-testid="print-view">
      <div className="pwa-print-controls">
        <Link href={garagePath(locale, v.id, 'history')} className="pwa-link">
          ← {t('garage.print.back')}
        </Link>
        <Check
          checked={costs}
          onChange={(e) => router.replace(`${garagePath(locale, v.id, 'print')}${e.target.checked ? '' : '?costs=0'}`)}
        >
          {t('garage.export.includeCosts')}
        </Check>
        <Button variant="primary" icon="download" onClick={() => window.print()}>
          {t('garage.print.print')}
        </Button>
      </div>
      <header className="pwa-print-head">
        <p className="pwa-print-brand">{t('common.appName')}</p>
        <h1 className="pwa-page-title">{t('garage.print.title')}</h1>
        <p className="pwa-text-body" dir="auto">
          <bdi>{full}</bdi>
        </p>
        <p className="pwa-text-caption">
          {[
            v.mileage_km !== undefined ? t('garage.mileageValue', { km: f.number(v.mileage_km) }) : null,
            v.vin_last4 ? `${t('garage.print.vinEnding')} ${v.vin_last4}` : null,
            t('garage.print.generated', { date: f.date(madeAt, 'dateLong') }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </header>
      {failed ? <ErrorState error={new Error('records')} compact /> : null}
      {records && records.length === 0 ? <p className="pwa-text-body">{t('garage.history.emptyTitle')}</p> : null}
      {records && records.length > 0 ? (
        <table className="pwa-table pwa-print-table">
          <thead>
            <tr>
              <th scope="col">{t('garage.history.date')}</th>
              <th scope="col">{t('garage.history.work')}</th>
              <th scope="col">{t('garage.history.shop')}</th>
              <th scope="col">{t('garage.history.mileage')}</th>
              {costs ? <th scope="col">{t('garage.history.cost')}</th> : null}
              <th scope="col">{t('garage.history.source')}</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <td className="pwa-nowrap">{f.calendarDate(r.service_date)}</td>
                <td dir="auto">
                  {systems.name(r.service_system_node_id) ?? '—'}
                  {r.description ? <span className="pwa-print-desc">{r.description}</span> : null}
                  {r.parts_used?.length ? (
                    <span className="pwa-print-desc">
                      {r.parts_used.map((p) => `${f.digits(p.quantity)} × ${p.name}`).join(f.locale === 'fa' ? '، ' : ', ')}
                    </span>
                  ) : null}
                </td>
                <td dir="auto">{r.provider?.name ?? '—'}</td>
                <td className="pwa-nowrap">{r.mileage_km !== undefined ? f.number(r.mileage_km) : '—'}</td>
                {costs ? <td className="pwa-nowrap">{r.cost ? f.money(r.cost.amount, r.cost.currency) : '—'}</td> : null}
                <td>{isVerified(r) ? `✓ ${t('garage.record.verified')}` : t('garage.record.addedByYou')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <footer className="pwa-print-foot pwa-text-caption">
        <p>{t('garage.print.verifiedNote')}</p>
        <Link href={garagePath(locale, v.id, 'history')} className={`${buttonClass({ variant: 'ghost', size: 'sm' })} pwa-print-controls`}>
          <span className="cp-btn-label">{t('garage.print.back')}</span>
        </Link>
      </footer>
    </article>
  );
}
