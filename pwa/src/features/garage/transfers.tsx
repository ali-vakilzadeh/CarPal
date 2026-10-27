'use client';
// Vehicle ownership transfers (P7.T8, BA-04, backend GD-33: one owner per VIN). Owner side: the "Ownership requests"
// block of W-GAR-01 lists incoming pending requests (who asks, their message, the car, the expiry) with Accept — after
// a confirmation that lists what moves (service history, documents, issues, reminders, mileage, photos; nickname,
// plate and notes are cleared) — and Reject. Buyer side: outgoing pending requests with their expiry and Cancel, and
// TransferAsk, the "Did you buy this car?" form that W-GAR-03 shows on 409 DUPLICATE with vin_transfer_available.
// The current owner is never shown to the buyer.
import type { VehicleTransfer } from '@carpal/api-contracts';
import { useState } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { Dialog } from '@/components/shell/dialog';
import { useToast } from '@/components/shell/toast';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { useRefresh, useTransfers, VEHICLE_OPS } from './hooks';
import { pendingTransfers } from './model';
import { useModelName } from './names';

const TRANSFER_OPS = ['vehicles.transfers_list', ...VEHICLE_OPS] as const;

export function OwnershipRequests() {
  const t = useT();
  const transfers = useTransfers();
  const { incoming, outgoing } = pendingTransfers(transfers.data?.items ?? []);
  if (incoming.length === 0 && outgoing.length === 0) return null;
  return (
    <section className="pwa-ownership" aria-labelledby="ownership-title" data-testid="ownership-requests">
      <h2 id="ownership-title" className="pwa-section-title">
        {t('garage.transfer.blockTitle')}
      </h2>
      <ul className="pwa-plain-list">
        {incoming.map((tr) => (
          <IncomingRequest key={tr.id} transfer={tr} />
        ))}
        {outgoing.map((tr) => (
          <OutgoingRequest key={tr.id} transfer={tr} />
        ))}
      </ul>
    </section>
  );
}

function IncomingRequest({ transfer: tr }: { transfer: VehicleTransfer }) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useRefresh();
  const { full } = useModelName(tr.vehicle_summary);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const decide = async (decision: 'accept' | 'reject') => {
    setBusy(decision);
    setError(null);
    try {
      await api.api('vehicles.transfer_decide', { path: { transfer_id: tr.id }, body: { decision } });
      await refresh(...TRANSFER_OPS);
      setConfirm(false);
      toast(t(decision === 'accept' ? 'garage.transfer.accepted' : 'garage.transfer.rejected'));
    } catch (err) {
      setError(err instanceof ApiProblem && err.code === 'INVALID_TRANSITION' ? 'garage.transfer.noLonger' : 'garage.saveFailed');
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="pwa-transfer" data-direction="incoming">
      <p className="pwa-transfer-title" dir="auto">
        {t('garage.transfer.incoming', { name: tr.requester_display ?? t('garage.transfer.someone') })}
      </p>
      <p className="pwa-text-caption" dir="auto">
        <bdi>{full}</bdi>
        {tr.vehicle_summary.vin_last4 ? (
          <>
            {' · '}
            {t('garage.transfer.vinEnding')} <bdi dir="ltr">{tr.vehicle_summary.vin_last4}</bdi>
          </>
        ) : null}
      </p>
      {tr.message ? (
        <blockquote className="pwa-transfer-message" dir="auto">
          {tr.message}
        </blockquote>
      ) : null}
      <p className="pwa-text-caption">{t('garage.transfer.expires', { date: f.date(tr.expires_at) })}</p>
      {error ? <Banner tone="danger" text={t(error)} /> : null}
      <div className="pwa-inline-buttons">
        <Button size="sm" variant="primary" onClick={() => setConfirm(true)}>
          {t('garage.transfer.accept')}
        </Button>
        <Button size="sm" variant="ghost" loading={busy === 'reject'} disabled={!!busy} onClick={() => void decide('reject')}>
          {t('garage.transfer.reject')}
        </Button>
      </div>
      <Dialog
        name="transfer-accept"
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t('garage.transfer.confirmTitle')}
        footer={
          <>
            <Button variant="danger" loading={busy === 'accept'} onClick={() => void decide('accept')}>
              {t('garage.transfer.confirmAccept')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              {t('common.actions.cancel')}
            </Button>
          </>
        }
      >
        <p className="pwa-text-body">{t('garage.transfer.confirmText', { name: tr.requester_display ?? t('garage.transfer.someone') })}</p>
        <ul className="pwa-bullets">
          <li>{t('garage.transfer.moves.history')}</li>
          <li>{t('garage.transfer.moves.documents')}</li>
          <li>{t('garage.transfer.moves.issues')}</li>
          <li>{t('garage.transfer.moves.mileage')}</li>
          <li>{t('garage.transfer.moves.photos')}</li>
        </ul>
        <Banner tone="warn" text={t('garage.transfer.cleared')} />
        {error ? <Banner tone="danger" text={t(error)} /> : null}
      </Dialog>
    </li>
  );
}

function OutgoingRequest({ transfer: tr }: { transfer: VehicleTransfer }) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useRefresh();
  const { full } = useModelName(tr.vehicle_summary);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const cancel = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await api.api('vehicles.transfer_cancel', { path: { transfer_id: tr.id } });
      await refresh(...TRANSFER_OPS);
      toast(t('garage.transfer.cancelled'));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="pwa-transfer" data-direction="outgoing">
      <p className="pwa-transfer-title" dir="auto">
        {t('garage.transfer.outgoing')}
      </p>
      <p className="pwa-text-caption" dir="auto">
        <bdi>{full}</bdi>
      </p>
      <p className="pwa-text-caption">{t('garage.transfer.waiting', { date: f.date(tr.expires_at) })}</p>
      {failed ? <p className="pwa-text-caption pwa-error-text">{t('garage.saveFailed')}</p> : null}
      <div className="pwa-inline-buttons">
        <Button size="sm" variant="ghost" loading={busy} onClick={() => void cancel()}>
          {t('garage.transfer.cancel')}
        </Button>
      </div>
    </li>
  );
}

type AskResult = { kind: 'sent'; transfer: VehicleTransfer } | { kind: 'pending' } | { kind: 'notFound' } | { kind: 'error' } | null;

/** "Did you buy this car?" — ask the VIN's current owner to move the car to this garage (vehicles.transfer_request). */
export function TransferAsk({ vin, onCancelled }: { vin: string; onCancelled?: () => void }) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const refresh = useRefresh();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AskResult>(null);
  const send = async () => {
    setBusy(true);
    try {
      const transfer = await api.api('vehicles.transfer_request', {
        body: { vin, ...(message.trim() ? { message: message.trim() } : {}) },
      });
      setResult({ kind: 'sent', transfer });
      void refresh('vehicles.transfers_list');
    } catch (err) {
      if (err instanceof ApiProblem && err.code === 'DUPLICATE') setResult({ kind: 'pending' });
      else if (err instanceof ApiProblem && err.code === 'REFERENCE_NOT_FOUND') setResult({ kind: 'notFound' });
      else setResult({ kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (id: string) => {
    setBusy(true);
    try {
      await api.api('vehicles.transfer_cancel', { path: { transfer_id: id } });
      void refresh('vehicles.transfers_list');
      setResult(null);
      onCancelled?.();
    } catch {
      setResult({ kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  if (result?.kind === 'sent')
    return (
      <Banner
        tone="success"
        title={t('garage.transfer.sentTitle')}
        text={t('garage.transfer.sentText', { date: f.date(result.transfer.expires_at) })}
      >
        <div className="pwa-banner-actions">
          <Button size="sm" variant="ghost" loading={busy} onClick={() => void cancel(result.transfer.id)}>
            {t('garage.transfer.cancel')}
          </Button>
        </div>
      </Banner>
    );
  if (result?.kind === 'pending') return <Banner tone="info" text={t('garage.transfer.alreadyAsked')} />;
  return (
    <Banner tone="info" icon="car" title={t('garage.transfer.askTitle')} text={t('garage.transfer.askText')}>
      <div className="flex flex-col gap-3 pt-2">
        <TextField
          multiline
          label={t('garage.transfer.message')}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={500}
          rows={2}
        />
        {result?.kind === 'notFound' ? <p className="pwa-text-caption">{t('garage.transfer.notFound')}</p> : null}
        {result?.kind === 'error' ? <p className="pwa-text-caption pwa-error-text">{t('garage.saveFailed')}</p> : null}
        <div>
          <Button size="sm" loading={busy} onClick={() => void send()}>
            {t('garage.transfer.send')}
          </Button>
        </div>
      </div>
    </Banner>
  );
}
