'use client';
// Vehicle context (Docs/22 §2.2-2.3, Docs/21 S-SHARED-09): the chip inside the search box ("for Silver · BMW 320i"),
// the "Your garage" box under the left navigation, and the vehicle selector they open (?modal=vehicle).
import Link from 'next/link';
import { buttonClass } from '@/components/ds/button';
import { cx } from '@/components/ds/cx';
import { Icon } from '@/components/ds/icon';
import { useLocale, useT } from '@/lib/i18n/client';
import type { Vehicle } from '@carpal/api-contracts';
import { ANY_VEHICLE, useActiveVehicle, useVehicleLabel } from './active-vehicle';
import { UrlModal, useUrlModal } from './url-modal';

export const VEHICLE_MODAL = 'vehicle';

export function VehicleChip() {
  const t = useT();
  const { active } = useActiveVehicle();
  const label = useVehicleLabel(active);
  const modal = useUrlModal(VEHICLE_MODAL);
  const text = label ?? t('shell.vehicle.any');
  return (
    <button
      type="button"
      className="cp-chip pwa-vehicle-chip"
      aria-label={t('shell.vehicle.active', { vehicle: text })}
      aria-haspopup="dialog"
      onClick={() => modal.open()}
    >
      <Icon name="car" size={18} />
      <span>{label ? t('shell.header.forVehicle', { vehicle: label }) : text}</span>
      <Icon name="down" size={18} />
    </button>
  );
}

function VehicleOption({ v, selected, onSelect }: { v: Vehicle; selected: boolean; onSelect: () => void }) {
  const label = useVehicleLabel(v) ?? '';
  return (
    <li>
      <button type="button" role="radio" aria-checked={selected} className={cx('pwa-option', selected && 'is-selected')} onClick={onSelect}>
        <Icon name="car" size={20} />
        <bdi className="pwa-option-title">{label}</bdi>
        {selected ? <Icon name="check" size={20} /> : null}
      </button>
    </li>
  );
}

export function VehicleSelectModal() {
  const t = useT();
  const locale = useLocale();
  const modal = useUrlModal(VEHICLE_MODAL);
  const { vehicles, active, setActive } = useActiveVehicle();
  const pick = (id: string) => {
    setActive(id);
    modal.close();
  };
  return (
    <UrlModal control={modal} name={VEHICLE_MODAL} title={t('shell.vehicle.choose')} variant="sheet">
      <ul className="pwa-option-list" role="radiogroup" aria-label={t('shell.vehicle.choose')}>
        {vehicles.map((v) => (
          <VehicleOption key={v.id} v={v} selected={active?.id === v.id} onSelect={() => pick(v.id)} />
        ))}
        <li>
          <button
            type="button"
            role="radio"
            aria-checked={active === null}
            className={cx('pwa-option', active === null && 'is-selected')}
            onClick={() => pick(ANY_VEHICLE)}
          >
            <Icon name="grid" size={20} />
            <span className="pwa-option-title">{t('shell.vehicle.any')}</span>
            {active === null ? <Icon name="check" size={20} /> : null}
          </button>
        </li>
      </ul>
      <Link href={`/${locale}/garage`} className={buttonClass({ variant: 'ghost' })} onClick={() => modal.close()}>
        <Icon name="plus" size={20} />
        <span className="cp-btn-label">{t('shell.garageBox.addVehicle')}</span>
      </Link>
    </UrlModal>
  );
}

export function GarageBox() {
  const t = useT();
  const locale = useLocale();
  const { active, vehicles, isLoading } = useActiveVehicle();
  const label = useVehicleLabel(active);
  const modal = useUrlModal(VEHICLE_MODAL);
  if (isLoading) return <div className="pwa-garage-box" aria-busy="true" />;
  return (
    <section className="pwa-garage-box" aria-labelledby="pwa-garage-box-title">
      <h2 id="pwa-garage-box-title" className="pwa-menu-heading">
        {t('shell.garageBox.title')}
      </h2>
      {active ? (
        <>
          <Link href={`/${locale}/garage`} className="pwa-garage-vehicle">
            <Icon name="car" size={20} />
            <bdi>{label}</bdi>
          </Link>
          <p className="pwa-text-caption">
            {active.open_issue_count > 0
              ? t('shell.garageBox.openIssues', { count: active.open_issue_count })
              : t('shell.garageBox.noIssues')}
          </p>
          {vehicles.length > 1 ? (
            <button type="button" className="pwa-link" onClick={() => modal.open()}>
              {t('shell.garageBox.switch')}
            </button>
          ) : null}
        </>
      ) : (
        <>
          <p className="pwa-text-caption">{t('shell.garageBox.empty')}</p>
          <Link href={`/${locale}/garage`} className={buttonClass({ size: 'sm' })}>
            <Icon name="plus" size={20} />
            <span className="cp-btn-label">{t('shell.garageBox.addVehicle')}</span>
          </Link>
        </>
      )}
    </section>
  );
}
