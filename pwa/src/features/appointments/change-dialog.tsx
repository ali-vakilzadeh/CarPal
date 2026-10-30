'use client';
// Change or cancel (Docs/21 C-APP-04, Docs/40 §16.2): one dialog with three tasks —
//   - times: suggest another time to the shop (alternative_proposed → requested with new windows), change the windows
//     of a request the shop has not started reviewing (appointments.update, ETag), or send a draft (draft → requested);
//   - cancel: a reason (sent as the cancellation_reason text) and an optional note, with the late-cancellation warning
//     inside 24 hours; a draft is discarded the same way;
//   - delay: "Running late" by 10-90 minutes (appointments.delay, confirmed only).
import type { Appointment } from '@carpal/api-contracts';
import { useState } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { TextField } from '@/components/ds/text-field';
import { Dialog } from '@/components/shell/dialog';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import { CANCEL_REASONS, DELAYS, lateCancellation, type CancelReason } from './model';
import { TimesPicker } from './times-picker';
import { windowsOf, type WindowChoice } from './times';

export type ChangeMode = 'cancel' | 'times' | 'delay';

const MAX_REASON = 500;

export function ChangeDialog({
  a,
  mode,
  onClose,
  onDone,
}: {
  a: Appointment;
  mode: ChangeMode | null;
  onClose: () => void;
  /** The appointment as the server answered, and the toast text. */
  onDone: (next: Appointment, toast: string) => void;
}) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const [reason, setReason] = useState<CancelReason>('cantMakeIt');
  const [note, setNote] = useState('');
  const [choices, setChoices] = useState<WindowChoice[]>([]);
  const [delay, setDelay] = useState<number>(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timeZone = a.provider_location?.timezone ?? f.timeZone;
  const draft = a.status === 'draft';
  const counter = a.status === 'alternative_proposed';

  const fail = (err: unknown) => {
    if (err instanceof ApiProblem && (err.code === 'INVALID_TRANSITION' || err.versionMismatch || err.status === 409))
      setError(err.code === 'CAPACITY_UNAVAILABLE' ? t('appointments.errors.capacity') : t('appointments.errors.changed'));
    else if (err instanceof ApiProblem && err.fields.some((x) => x.pointer.startsWith('/time_windows')))
      setError(t('appointments.errors.times'));
    else if (err instanceof ApiProblem && err.status === 429) setError(t('appointments.errors.tooMany'));
    else setError(t('appointments.errors.failed'));
  };

  const run = async (work: () => Promise<{ next: Appointment; toast: string }>) => {
    setBusy(true);
    setError(null);
    try {
      const { next, toast } = await work();
      onDone(next, toast);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const path = { appointment_id: a.id };
  const submitTimes = () => {
    const windows = windowsOf(choices, timeZone);
    if (!windows.length) return setError(t('appointments.errors.pickTime'));
    void run(async () => {
      if (counter || draft) {
        const next = await api.api('appointments.transition', { path, body: { to: 'requested', time_windows: windows } });
        return { next, toast: t(counter ? 'appointments.toast.countered' : 'appointments.toast.sent') };
      }
      const next = await api.api('appointments.update', { path, body: { time_windows: windows } });
      return { next, toast: t('appointments.toast.timesChanged') };
    });
  };
  const cancel = () => {
    const words = t(`appointments.cancel.reason.${reason}`);
    const text = [...(note.trim() ? `${words}: ${note.trim()}` : words)].slice(0, MAX_REASON).join('');
    void run(async () => ({
      next: await api.api('appointments.transition', { path, body: { to: 'cancelled', cancellation_reason: text } }),
      toast: t(draft ? 'appointments.toast.discarded' : 'appointments.toast.cancelled'),
    }));
  };
  const sendDelay = () =>
    void run(async () => ({
      next: await api.api('appointments.delay', { path, body: { customer_delay_minutes: delay } }),
      toast: t('appointments.toast.delay', { minutes: f.number(delay) }),
    }));

  const title =
    mode === 'times'
      ? t(counter ? 'appointments.change.counterTitle' : draft ? 'appointments.change.sendTitle' : 'appointments.change.timesTitle')
      : mode === 'delay'
        ? t('appointments.delay.title')
        : t(draft ? 'appointments.cancel.discardTitle' : 'appointments.cancel.title');

  return (
    <Dialog
      open={mode !== null}
      onClose={onClose}
      name="appointment-change"
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('appointments.change.keep')}
          </Button>
          {mode === 'times' ? (
            <Button variant="primary" icon="send" loading={busy} onClick={submitTimes} disabled={choices.length === 0}>
              {t(counter ? 'appointments.change.sendCounter' : draft ? 'appointments.change.send' : 'appointments.change.saveTimes')}
            </Button>
          ) : mode === 'delay' ? (
            <Button variant="primary" icon="clock" loading={busy} onClick={sendDelay}>
              {t('appointments.delay.send')}
            </Button>
          ) : (
            <Button variant="danger" loading={busy} onClick={cancel}>
              {t(draft ? 'appointments.cancel.discard' : 'appointments.cancel.confirm')}
            </Button>
          )}
        </>
      }
    >
      <div className="pwa-stack">
        {mode === 'times' ? (
          <TimesPicker
            orgId={a.provider.id}
            locationId={a.provider_location?.id ?? null}
            timeZone={timeZone}
            value={choices}
            onChange={setChoices}
            appointmentType={a.appointment_type}
          />
        ) : null}
        {mode === 'delay' ? (
          <div className="pwa-stack-sm">
            <p className="pwa-text-body m-0">{t('appointments.delay.text', { name: a.provider.name })}</p>
            <div className="pwa-chips" role="group" aria-label={t('appointments.delay.label')}>
              {DELAYS.map((m) => (
                <Chip key={m} selected={delay === m} onClick={() => setDelay(m)}>
                  {t('appointments.delay.minutes', { count: m })}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}
        {mode === 'cancel' ? (
          <div className="pwa-stack-sm">
            {lateCancellation(a) ? <Banner tone="warn" text={t('appointments.cancel.late')} /> : null}
            <p className="pwa-text-body m-0">
              {draft ? t('appointments.cancel.discardText') : t('appointments.cancel.text', { name: a.provider.name })}
            </p>
            {draft ? null : (
              <>
                <div className="pwa-chips" role="group" aria-label={t('appointments.cancel.reasonLabel')}>
                  {CANCEL_REASONS.map((r) => (
                    <Chip key={r} selected={reason === r} onClick={() => setReason(r)}>
                      {t(`appointments.cancel.reason.${r}`)}
                    </Chip>
                  ))}
                </div>
                <TextField
                  multiline
                  rows={2}
                  label={t('appointments.cancel.note')}
                  value={note}
                  maxLength={400}
                  onChange={(e) => setNote(e.target.value)}
                />
              </>
            )}
          </div>
        ) : null}
        {error ? (
          <p className="pwa-error-text m-0" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
