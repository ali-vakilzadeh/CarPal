'use client';
// W-HELP-01 Done (P10.T3; Docs/55 C-HELP-08): the request was sent — reference, shop, car, issue, the preferred times,
// what happens next (the shop's usual response time), the public address or area until the shop confirms (the exact
// address comes with confirmation, 52 §12) with Directions, Track request, Back to home, Add another issue and Cancel
// request. The web push offer for appointment updates belongs here once P12 brings the service worker (PushOffer).
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, buttonClass } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { SkeletonCard } from '@/components/shell/skeleton';
import { StateView, stateFromProblem } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { reference, subjectOf, vehicleText } from '@/features/appointments';
import { DirectionsMenu, addressLine } from '@/features/profiles';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { WizardContext } from './wizard';

/** P12 adds the web push offer for appointment updates here (OQ-07); nothing until then. */
function PushOffer() {
  return null;
}

export function DoneStep({ ctx }: { ctx: WizardContext }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const id = ctx.c.appointmentId!;
  const q = useApiQuery('appointments.get', { path: { appointment_id: id } });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!q.data) return q.isPending ? <SkeletonCard lines={6} /> : <StateView kind={stateFromProblem(q.error)} t={t} />;
  const a = q.data;
  const loc = a.provider_location;
  const area = loc ? addressLine([loc.address.address_line_1, loc.address.city], locale) : null;
  const windows = [...a.time_windows].sort((x, y) => x.priority - y.priority);
  const cancellable = a.allowed_transitions.includes('cancelled');

  const cancel = async () => {
    setBusy(true);
    try {
      const next = await api.api('appointments.transition', {
        path: { appointment_id: a.id },
        body: { to: 'cancelled', cancellation_reason: t('appointments.cancel.reason.cantMakeIt') },
      });
      queryClient.setQueryData(apiQueryKey('appointments.get', { path: { appointment_id: a.id } }), next);
      void queryClient.invalidateQueries({ queryKey: ['appointments.list'] });
      toast(t('appointments.toast.cancelled'));
      router.push(`/${locale}/appointments/${a.id}`);
    } catch {
      toast(t('appointments.errors.failed'));
      setBusy(false);
    }
  };

  return (
    <div className="pwa-stack">
      <section className="pwa-help-done" aria-labelledby="help-done">
        <span className="pwa-help-done-mark" aria-hidden="true">
          <Icon name="check" size={32} />
        </span>
        <h1 id="help-done" className="pwa-text-title m-0">
          {t('help.done.title', { name: a.provider.name })}
        </h1>
        <p className="pwa-text-body m-0">{t('help.done.reference', { ref: reference(a.id) })}</p>
      </section>
      <section className="pwa-card pwa-stack-xs">
        <h2 className="pwa-text-label m-0">{t('help.done.next')}</h2>
        <p className="pwa-text-body m-0">
          {a.provider.measured_response_time_minutes
            ? t('help.done.respondsIn', { time: f.number(Math.max(1, Math.round(a.provider.measured_response_time_minutes / 60))) })
            : t('help.done.notify')}
        </p>
      </section>
      <dl className="pwa-dl pwa-card">
        <dt>{t('help.case.vehicle')}</dt>
        <dd>
          <bdi>{vehicleText(a.vehicle, f)}</bdi>
        </dd>
        <dt>{t('help.done.issue')}</dt>
        <dd dir="auto">{subjectOf(a)}</dd>
        <dt>{t('help.done.times')}</dt>
        <dd>{windows.length ? windows.map((w) => f.date(w.start_at, 'dateTime')).join(' · ') : '—'}</dd>
        {area ? (
          <>
            <dt>{t('help.done.where')}</dt>
            <dd dir="auto">
              {area}
              <span className="pwa-text-caption"> · {t('appointments.detail.exactLater')}</span>
            </dd>
          </>
        ) : null}
      </dl>
      {loc?.point ? (
        <div>
          <DirectionsMenu point={loc.point} address={area} approximate={loc.visibility !== 'exact'} name={a.provider.name} size="sm" />
        </div>
      ) : null}
      <PushOffer />
      <div className="pwa-stack-sm">
        <Link href={`/${locale}/appointments/${a.id}`} className={buttonClass({ variant: 'primary', block: true })}>
          <span className="cp-btn-label">{t('help.done.track')}</span>
        </Link>
        <Link href={`/${locale}/home`} className={buttonClass({ block: true })}>
          <span className="cp-btn-label">{t('help.done.home')}</span>
        </Link>
        <Link href={`/${locale}/help`} className={buttonClass({ variant: 'ghost', block: true })}>
          <span className="cp-btn-label">{t('help.done.another')}</span>
        </Link>
      </div>
      {cancellable ? (
        confirming ? (
          <div className="pwa-card pwa-stack-sm" role="group" aria-label={t('help.done.cancelTitle')}>
            <p className="pwa-text-label m-0">{t('help.done.cancelTitle')}</p>
            <p className="pwa-text-body m-0">{t('help.done.cancelText', { name: a.provider.name })}</p>
            <div className="pwa-inline-buttons">
              <Button variant="danger" loading={busy} onClick={() => void cancel()}>
                {t('help.done.cancel')}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                {t('appointments.change.keep')}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button variant="ghost" icon="close" onClick={() => setConfirming(true)}>
              {t('help.done.cancel')}
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}
