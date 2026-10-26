'use client';
// Link-token pages of the auth host (P4.T3, P4.T5): /l/ev#<token> verifies an email address (auth.email_verify) and
// /l/pr#<token> sets a new password (auth.password_reset_complete). The token arrives in the fragment, so it never
// reaches a server log or the Referer (SEC-LT-2); the page reads it, removes it from the address bar and POSTs it.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { StateView } from '@/components/shell/states';
import { ApiProblem } from '@/lib/api/problem';
import { useBrowserValue } from '@/lib/browser-value';
import { useApiClient } from '@/lib/api/query';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { PasswordField } from './fields';
import { passwordError } from './password';
import { authOutcome } from './problems';

/** The token of this page load, captured on the first read in the browser (then removed from the address bar). */
const captured = new Map<string, string | null>();

export function readFragmentToken(): string | null {
  const key = location.pathname;
  if (!captured.has(key)) {
    // Tokens are base64url: anything else (including a broken percent-encoding) is an incomplete link.
    const value = location.hash.replace(/^#/, '');
    captured.set(key, /^[A-Za-z0-9_-]{8,512}$/.test(value) ? value : null);
    if (location.hash) history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  }
  return captured.get(key) ?? null;
}

/** Tests only: forget captured tokens. */
export function forgetFragmentTokens(): void {
  captured.clear();
}

/** undefined while server-rendering and hydrating; then the token, or null when the link is incomplete. */
function useFragmentToken(): string | null | undefined {
  return useBrowserValue<string | null | undefined>(readFragmentToken, undefined);
}

function useLoginHref(): string {
  const locale = useLocale();
  return `/${locale}/login`;
}

export function EmailVerifyPage() {
  const t = useT();
  const api = useApiClient();
  const token = useFragmentToken();
  const loginHref = useLoginHref();
  const started = useRef(false);
  const [state, setState] = useState<'working' | 'done' | 'used' | 'expired' | 'taken' | 'error'>('working');

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    api
      .api('auth.email_verify', { body: { token } })
      .then(() => setState('done'))
      .catch((err: unknown) => {
        if (err instanceof ApiProblem && err.code === 'LINK_USED') setState('used');
        else if (err instanceof ApiProblem && (err.code === 'LINK_EXPIRED' || err.status === 410)) setState('expired');
        else if (err instanceof ApiProblem && err.code === 'DUPLICATE') setState('taken');
        else setState('error');
      });
  }, [api, token]);

  const action = (
    <a href={loginHref} className={buttonClass({ variant: 'primary' })}>
      <span className="cp-btn-label">{state === 'done' ? t('auth.link.continue') : t('auth.link.logIn')}</span>
    </a>
  );
  if (token === null)
    return <StateView kind="removed" t={t} title={t('auth.link.evTitle')} text={t('auth.link.missing')} action={action} />;
  if (token === undefined || state === 'working')
    return (
      <div className="pwa-state" role="status" aria-live="polite">
        <p className="pwa-state-title">{t('auth.link.evWorking')}</p>
      </div>
    );
  if (state === 'done')
    return <StateView kind="empty" t={t} title={t('auth.link.evDone')} text={t('auth.link.evDoneText')} action={action} />;
  const text: Record<'used' | 'expired' | 'taken' | 'error', MessageKey> = {
    used: 'auth.link.evUsed',
    expired: 'auth.link.evExpired',
    taken: 'auth.link.evTaken',
    error: 'auth.errors.generic',
  };
  return (
    <StateView kind={state === 'error' ? 'error' : 'removed'} t={t} title={t('auth.link.evTitle')} text={t(text[state])} action={action} />
  );
}

export function PasswordResetPage() {
  const t = useT();
  const api = useApiClient();
  const token = useFragmentToken();
  const loginHref = useLoginHref();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: MessageKey; confirm?: MessageKey }>({});
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'form' | 'done' | 'expired'>('form');

  const loginAction = (primary: boolean) => (
    <a href={loginHref} className={buttonClass({ variant: primary ? 'primary' : 'secondary' })}>
      <span className="cp-btn-label">{t('auth.link.logIn')}</span>
    </a>
  );
  if (token === undefined) return null;
  if (token === null)
    return <StateView kind="removed" t={t} title={t('auth.link.prTitle')} text={t('auth.link.missing')} action={loginAction(true)} />;
  if (state === 'done')
    return <StateView kind="empty" t={t} title={t('auth.link.prDone')} text={t('auth.link.prDoneText')} action={loginAction(true)} />;
  if (state === 'expired')
    return <StateView kind="removed" t={t} title={t('auth.link.prTitle')} text={t('auth.link.prExpired')} action={loginAction(true)} />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const found: typeof errors = {};
    const pw = passwordError(password, true);
    if (pw) found.password = pw;
    if (!pw && confirm !== password) found.confirm = 'auth.link.prMismatch';
    setErrors(found);
    if (found.password || found.confirm) return;
    setBusy(true);
    try {
      await api.api('auth.password_reset_complete', { body: { token, new_password: password } });
      setState('done');
    } catch (err) {
      const outcome = authOutcome(err);
      if (outcome.kind === 'expired') setState('expired');
      else if (outcome.kind === 'fields') setErrors({ password: outcome.fields['/new_password'] ?? outcome.message });
      else if (outcome.kind === 'locked') setError('auth.errors.tooMany');
      else setError(outcome.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
      <h1 className="pwa-auth-title">{t('auth.link.prTitle')}</h1>
      <PasswordField
        label={t('auth.link.prNew')}
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        error={errors.password ? t(errors.password) : null}
        strength={{ contacts: [] }}
        required
      />
      <PasswordField
        label={t('auth.link.prConfirm')}
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        error={errors.confirm ? t(errors.confirm) : null}
        required
      />
      {error ? <Banner tone="danger" text={t(error)} /> : null}
      <Button type="submit" variant="primary" block loading={busy}>
        {t('auth.link.prSave')}
      </Button>
    </form>
  );
}
