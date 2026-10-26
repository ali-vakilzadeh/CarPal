'use client';
// Sign-in notices of the shell (P4, P3 carry-overs): the BFF ended the session (401 SESSION_ENDED → "You were signed
// out"), and a sign-in that came back without success (/bff/oauth/callback appends ?signin=<outcome> to the return
// URL). The outcome parameter is left in the URL: the (app) session gate uses it to show "Log in to see this page"
// instead of sending the browser straight back to the hosted sign-in.
import { useEffect } from 'react';
import { SESSION_ENDED_EVENT } from '@/lib/api/query';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { useToast } from './toast';

export const SIGNIN_OUTCOMES: Record<string, MessageKey> = {
  expired: 'shell.signin.expired',
  state: 'shell.signin.expired',
  issuer: 'shell.signin.failed',
  failed: 'shell.signin.failed',
  cancelled: 'shell.signin.cancelled',
  step_up: 'shell.signin.stepUp',
};

export function SessionNotices() {
  const t = useT();
  const toast = useToast();

  useEffect(() => {
    const onEnded = () => toast(t('shell.session.ended'));
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
  }, [toast, t]);

  // Read once per page load: the outcome only ever arrives with the redirect from the BFF.
  useEffect(() => {
    const outcome = new URLSearchParams(location.search).get('signin');
    const key = outcome ? SIGNIN_OUTCOMES[outcome] : undefined;
    if (key) toast(t(key), { durationMs: 8_000 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per page load
  }, []);

  return null;
}
