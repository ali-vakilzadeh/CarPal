'use client';
// /l/ci#<token> (P10.T5, Docs/22 W-APP-01 "check-in link opened from SMS works on the web"): the link mailed at
// confirmation checks the customer in without signing in (appointments.check_in_link is PUB LNK(ci), DI-23), from 2
// hours before to 2 hours after the confirmed start. The token is read from the fragment, removed from the address
// bar and sent only when the user taps "I've arrived" (a link preview or a prefetch must never check anybody in).
// States: done (with the appointment for a signed-in user), too early / too late (409 outside_window), expired or
// already used (410), incomplete link.
import { useState, type ReactNode } from 'react';
import { Button, buttonClass } from '@/components/ds/button';
import { StateView } from '@/components/shell/states';
import { readFragmentToken } from '@/features/auth';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';
import { useSession } from '@/lib/api/session';
import { useBrowserValue } from '@/lib/browser-value';
import { useLocale, useT } from '@/lib/i18n/client';

type State = 'ready' | 'working' | 'done' | 'window' | 'expired' | 'error';

export function CheckInLinkPage() {
  const t = useT();
  const locale = useLocale();
  const api = useApiClient();
  const session = useSession();
  const token = useBrowserValue<string | null | undefined>(readFragmentToken, undefined);
  const [state, setState] = useState<State>('ready');
  const [appointmentId, setAppointmentId] = useState<string | null>(null);

  const checkIn = async () => {
    if (!token) return;
    setState('working');
    try {
      const r = await api.api('appointments.check_in_link', { body: { token } });
      setAppointmentId(r.appointment_id);
      setState('done');
    } catch (err) {
      if (err instanceof ApiProblem && (err.status === 410 || err.code === 'LINK_EXPIRED' || err.code === 'LINK_USED')) setState('expired');
      else if (err instanceof ApiProblem && err.code === 'INVALID_TRANSITION') setState('window');
      else setState('error');
    }
  };

  const home = (
    <a href={`/${locale}`} className={buttonClass({ variant: 'secondary' })}>
      <span className="cp-btn-label">{t('appointments.checkIn.home')}</span>
    </a>
  );

  // The states keep the page's one h1 (the state's own heading is an h2).
  const page = (state: ReactNode) => (
    <>
      <h1 className="sr-only">{t('appointments.checkIn.title')}</h1>
      {state}
    </>
  );

  if (token === undefined) return page(<div className="pwa-state" role="status" aria-busy="true" />);
  if (token === null)
    return page(
      <StateView kind="removed" t={t} title={t('appointments.checkIn.title')} text={t('appointments.checkIn.missing')} action={home} />,
    );
  if (state === 'done')
    return page(
      <StateView
        kind="empty"
        t={t}
        title={t('appointments.checkIn.done')}
        text={t('appointments.checkIn.doneText')}
        action={
          session.data?.signed_in && appointmentId ? (
            <a href={`/${locale}/appointments/${encodeURIComponent(appointmentId)}`} className={buttonClass({ variant: 'primary' })}>
              <span className="cp-btn-label">{t('appointments.checkIn.open')}</span>
            </a>
          ) : (
            home
          )
        }
      />,
    );
  if (state === 'expired')
    return page(
      <StateView
        kind="removed"
        t={t}
        title={t('appointments.checkIn.expired')}
        text={t('appointments.checkIn.expiredText')}
        action={home}
      />,
    );
  return (
    <div className="pwa-stack">
      <h1 className="pwa-text-title m-0">{t('appointments.checkIn.title')}</h1>
      <p className="pwa-text-body m-0">{t('appointments.checkIn.text')}</p>
      {state === 'window' ? (
        <p className="pwa-error-text m-0" role="alert">
          {t('appointments.checkIn.window')}
        </p>
      ) : null}
      {state === 'error' ? (
        <p className="pwa-error-text m-0" role="alert">
          {t('appointments.errors.failed')}
        </p>
      ) : null}
      <Button variant="primary" icon="pin" block loading={state === 'working'} onClick={() => void checkIn()}>
        {t('appointments.checkIn.arrived')}
      </Button>
    </div>
  );
}
