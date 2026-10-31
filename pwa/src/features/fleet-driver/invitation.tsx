'use client';
// /l/mi#<token> (P12.T4 "sign-in as a driver"): the organization invitation mailed by org.member_invite (backend
// links point at https://carpal.app/l/mi#…, SEC-LT-2). A fleet invites its drivers this way; the invited person
// signs in (or signs up) with the invited email — org.invitation_accept checks the match (SEC-LT-5) — and then
// accepts. Guests keep the token in this tab's sessionStorage across the hosted sign-in (it never goes to the BFF
// as an intent: the link is single-use and personal). Drivers go on to their vehicles; other roles to the portal.
import { useEffect, useState } from 'react';
import { Button, buttonClass } from '@/components/ds/button';
import { StateView } from '@/components/shell/states';
import { readFragmentToken } from '@/features/auth';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';
import { loginUrl, useSession } from '@/lib/api/session';
import { useBrowserValue } from '@/lib/browser-value';
import { usePwaConfig } from '@/lib/config/client';
import { useLocale, useT } from '@/lib/i18n/client';

const KEY = 'cp:mi-token';

function readToken(): string | null {
  const fromLink = readFragmentToken();
  try {
    if (fromLink) sessionStorage.setItem(KEY, fromLink);
    return fromLink ?? sessionStorage.getItem(KEY);
  } catch {
    return fromLink;
  }
}

function forgetToken() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

type State = 'ready' | 'working' | 'driver' | 'member' | 'expired' | 'mismatch' | 'error';

export function InvitationLinkPage() {
  const t = useT();
  // The states keep the page's one h1 (a state's own heading is an h2), as on /l/ci.
  return (
    <>
      <h1 className="sr-only">{t('driver.invite.title')}</h1>
      <InvitationBody />
    </>
  );
}

function InvitationBody() {
  const t = useT();
  const locale = useLocale();
  const api = useApiClient();
  const session = useSession();
  const { portalUrl } = usePwaConfig();
  const token = useBrowserValue<string | null | undefined>(readToken, undefined);
  const [state, setState] = useState<State>('ready');
  const [org, setOrg] = useState<string | null>(null);

  useEffect(() => {
    if (state === 'driver' || state === 'member' || state === 'expired') forgetToken();
  }, [state]);

  if (token === undefined || session.data === undefined) return null;
  if (!token) return <StateView kind="removed" t={t} title={t('driver.invite.incomplete')} text={t('driver.invite.incompleteText')} />;

  if (!session.data.signed_in)
    return (
      <StateView
        kind="noAccess"
        t={t}
        title={t('driver.invite.title')}
        text={t('driver.invite.signInText')}
        action={
          <a href={loginUrl({ returnTo: '/l/mi', locale })} className={buttonClass({ variant: 'primary' })}>
            <span className="cp-btn-label">{t('driver.invite.signIn')}</span>
          </a>
        }
      />
    );

  const accept = async () => {
    setState('working');
    try {
      const m = await api.api('org.invitation_accept', { body: { token } });
      setOrg(m.organization?.name ?? null);
      setState(m.role === 'fleet_driver' ? 'driver' : 'member');
    } catch (err) {
      if (err instanceof ApiProblem && (err.status === 410 || err.code === 'LINK_EXPIRED' || err.code === 'LINK_USED')) setState('expired');
      else if (err instanceof ApiProblem && err.code === 'LINK_RECIPIENT_MISMATCH') setState('mismatch');
      else setState('error');
    }
  };

  if (state === 'driver')
    return (
      <StateView
        kind="empty"
        t={t}
        title={t('driver.invite.joined', { name: org ?? '' })}
        text={t('driver.invite.joinedText')}
        action={
          <a href={`/${locale}/drive`} className={buttonClass({ variant: 'primary' })}>
            <span className="cp-btn-label">{t('driver.invite.openVehicles')}</span>
          </a>
        }
      />
    );
  if (state === 'member')
    return (
      <StateView
        kind="empty"
        t={t}
        title={t('driver.invite.joined', { name: org ?? '' })}
        text={t('driver.invite.portalText')}
        action={
          <a href={portalUrl} className={buttonClass({ variant: 'primary' })}>
            <span className="cp-btn-label">{t('driver.invite.openPortal')}</span>
          </a>
        }
      />
    );
  if (state === 'expired')
    return <StateView kind="removed" t={t} title={t('driver.invite.expired')} text={t('driver.invite.expiredText')} />;
  return (
    <StateView
      kind={state === 'mismatch' || state === 'error' ? 'error' : 'empty'}
      t={t}
      title={t(state === 'mismatch' ? 'driver.invite.mismatch' : state === 'error' ? 'driver.invite.failed' : 'driver.invite.title')}
      text={t(state === 'mismatch' ? 'driver.invite.mismatchText' : 'driver.invite.text')}
      action={
        <Button variant="primary" loading={state === 'working'} onClick={() => void accept()}>
          {t('driver.invite.accept')}
        </Button>
      }
    />
  );
}
