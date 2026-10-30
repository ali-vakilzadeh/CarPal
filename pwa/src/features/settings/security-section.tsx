'use client';
// W-SET-01 Sign-in & security (mirrors C-PROF-01 sign-in parts; P9.T2, BA-09, BA-11, BA-13):
// - Password: current + new (12-128, the hosted sign-in's rules); a change signs out every other session.
// - Two-step sign-in: authenticator app (me.mfa_totp_enroll → QR of the otpauth URI + the key as text → code →
//   me.mfa_confirm; the first method returns 10 recovery codes once), passkeys (me.webauthn_register_options →
//   the browser ceremony → the pending method from me.mfa_list → me.mfa_confirm with the attestation), Remove, and
//   new recovery codes.
// - Active sessions table: device, client, country, last active, Sign out per row (the current one = log out here);
//   Sign out of all other devices.
// Every AAL2 write runs through the step-up and is repeated after it, except those that need the user again: a
// passkey (a fresh gesture for the browser sheet) and the password (never stored) reopen their form instead.
import type { MfaMethod, Session } from '@carpal/api-contracts';
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import type { WebAuthnAttestation } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { useIntentHandler } from '@/components/shell/auth-intent';
import { Dialog } from '@/components/shell/dialog';
import { useStepUp } from '@/components/shell/step-up';
import { useToast } from '@/components/shell/toast';
import { checkPassword, passkeyCancelled, passkeysSupported, passwordError, PASSWORD_MAX } from '@/features/auth';
import { QrCode } from '@/features/onboarding';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { useLogout } from '@/lib/api/session';
import { goTo } from '@/lib/browser-nav';
import { useBrowserValue } from '@/lib/browser-value';
import { toLatinDigits } from '@/lib/format';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { Card, downloadText, ErrorLine, ReadState } from './parts';

export function SecuritySection() {
  return (
    <div className="pwa-stack">
      <PasswordCard />
      <MfaCard />
      <SessionsCard />
    </div>
  );
}

/** The key of an otpauth:// URI, for typing it in by hand ("JBSW Y3DP …"). */
export function totpSecret(uri: string): string | null {
  try {
    const secret = new URL(uri).searchParams.get('secret');
    return secret ? secret.replace(/(.{4})/g, '$1 ').trim() : null;
  } catch {
    return null;
  }
}

function PasswordCard() {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const check = checkPassword(next);
  const nextError = next ? passwordError(next, true) : null;

  // Back from the step-up: the passwords were never stored, so the form opens again.
  useIntentHandler('settings.password', () => {
    setOpen(true);
    return t('settings.security.confirmedTypeAgain');
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!current || nextError || !next) return;
    setBusy(true);
    setError(null);
    try {
      const r = await stepUp({
        type: 'settings.password',
        label: t('settings.stepUp.password'),
        run: () => api.api('me.password_change', { body: { current_password: current, new_password: next } }),
      });
      if (r.steppingUp) return;
      setOpen(false);
      setCurrent('');
      setNext('');
      toast(t('settings.security.passwordChanged'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('settings.security.passwordTitle')} text={t('settings.security.passwordText')}>
      {open ? (
        <form className="pwa-stack-sm" onSubmit={submit} noValidate>
          <TextField
            label={t('settings.security.currentPassword')}
            type="password"
            autoComplete="current-password"
            dir="ltr"
            value={current}
            maxLength={PASSWORD_MAX}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <TextField
            label={t('settings.security.newPassword')}
            type="password"
            autoComplete="new-password"
            dir="ltr"
            value={next}
            maxLength={PASSWORD_MAX}
            hint={check.label ? t(check.label) : t('settings.security.newPasswordHint')}
            error={nextError ? t(nextError) : undefined}
            onChange={(e) => setNext(e.target.value)}
          />
          <ErrorLine error={error} />
          <div className="pwa-inline-buttons">
            <Button type="submit" variant="primary" loading={busy} disabled={!current || !next || !!nextError}>
              {t('settings.security.changePassword')}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('common.actions.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="pwa-inline-buttons">
          <Button size="sm" icon="lock" onClick={() => setOpen(true)}>
            {t('settings.security.changePassword')}
          </Button>
        </div>
      )}
    </Card>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const t = useT();
  return (
    <Dialog
      name="recovery-codes"
      open
      onClose={onDone}
      title={t('settings.security.recoveryTitle')}
      footer={
        <>
          <Button icon="download" onClick={() => downloadText('carpal-recovery-codes.txt', `${codes.join('\r\n')}\r\n`, 'text/plain')}>
            {t('settings.security.recoveryDownload')}
          </Button>
          <Button variant="primary" onClick={onDone}>
            {t('settings.security.recoverySaved')}
          </Button>
        </>
      }
    >
      <p className="pwa-text-body">{t('settings.security.recoveryText')}</p>
      <ol className="pwa-recovery-codes" dir="ltr" data-testid="recovery-codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
    </Dialog>
  );
}

type Enrol = { kind: 'totp'; method: MfaMethod; uri: string } | { kind: 'passkey' } | null;

function MfaCard() {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const queryClient = useQueryClient();
  const list = useApiQuery('me.mfa_list', undefined);
  const supported = useBrowserValue(passkeysSupported, false);
  const [enrol, setEnrol] = useState<Enrol>(null);
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState<MfaMethod | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: apiQueryKey('me.mfa_list') });
    void queryClient.invalidateQueries({ queryKey: apiQueryKey('me.get') });
  };

  const active = (list.data?.items ?? []).filter((m) => m.status === 'active');
  const defaultLabel = (kind: 'totp' | 'passkey') =>
    t(kind === 'totp' ? 'settings.security.totpDefaultLabel' : 'settings.security.passkeyDefaultLabel');

  const enrolTotp = async () => {
    const r = await api.api('me.mfa_totp_enroll', { body: { label: label.trim() || defaultLabel('totp') } });
    setEnrol({ kind: 'totp', method: r.method, uri: r.otpauth_uri });
    setCode('');
  };

  const startTotp = async () => {
    setBusy('totp');
    setError(null);
    try {
      await stepUp({ type: 'settings.totp_enroll', label: t('settings.stepUp.mfa'), run: enrolTotp });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };
  useIntentHandler('settings.totp_enroll', async () => {
    await enrolTotp();
    return t('settings.security.scanNow');
  });

  const confirmTotp = async (e: FormEvent) => {
    e.preventDefault();
    if (enrol?.kind !== 'totp') return;
    setBusy('confirm');
    setError(null);
    try {
      const r = await api.api('me.mfa_confirm', { path: { method_id: enrol.method.id }, body: { code } });
      setEnrol(null);
      setLabel('');
      refresh();
      if (r.recovery_codes?.length) setCodes(r.recovery_codes);
      toast(t('settings.security.mfaOn'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const addPasskey = async () => {
    setBusy('passkey');
    setError(null);
    const name = label.trim() || defaultLabel('passkey');
    try {
      const r = await stepUp({
        type: 'settings.passkey',
        label: t('settings.stepUp.mfa'),
        run: () => api.api('me.webauthn_register_options', { body: { label: name } }),
      });
      if (r.steppingUp) return;
      const attestation = await startRegistration({ optionsJSON: r.value as unknown as PublicKeyCredentialCreationOptionsJSON });
      // The pending method holds the challenge; me.mfa_list names it (BA-09).
      const methods = await api.api('me.mfa_list');
      const pending = methods.items
        .filter((m) => m.method_type === 'webauthn' && m.status === 'pending')
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (!pending) throw new Error('no pending passkey');
      const done = await api.api('me.mfa_confirm', {
        path: { method_id: pending.id },
        body: { attestation: attestation as unknown as WebAuthnAttestation },
      });
      setEnrol(null);
      setLabel('');
      refresh();
      if (done.recovery_codes?.length) setCodes(done.recovery_codes);
      toast(t('settings.security.passkeyAdded'));
    } catch (err) {
      if (!passkeyCancelled(err)) setError(err);
    } finally {
      setBusy(null);
    }
  };
  // A passkey needs the person's tap for the browser sheet: after the step-up, the form opens again.
  useIntentHandler('settings.passkey', () => {
    setEnrol({ kind: 'passkey' });
    return t('settings.security.confirmedPasskey');
  });

  type RemoveDraft = { method_id: string };
  const remove = async (m: MfaMethod) => {
    setBusy(`remove:${m.id}`);
    setError(null);
    try {
      const r = await stepUp<unknown, RemoveDraft>({
        type: 'settings.mfa_remove',
        target: m.id,
        draft: { method_id: m.id },
        label: t('settings.stepUp.mfa'),
        run: () => api.api('me.mfa_remove', { path: { method_id: m.id } }),
      });
      if (r.steppingUp) return;
      setRemoving(null);
      refresh();
      toast(t('settings.security.removed', { name: m.label }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };
  useIntentHandler<RemoveDraft>('settings.mfa_remove', async (intent) => {
    if (!intent.draft?.method_id) return;
    await api.api('me.mfa_remove', { path: { method_id: intent.draft.method_id } });
    refresh();
    return t('settings.security.removedOne');
  });

  const regenerate = async () => {
    setBusy('codes');
    setError(null);
    try {
      const r = await stepUp({
        type: 'settings.recovery_codes',
        label: t('settings.stepUp.mfa'),
        run: () => api.api('me.recovery_codes_regenerate'),
      });
      if (!r.steppingUp) setCodes(r.value.recovery_codes);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };
  useIntentHandler('settings.recovery_codes', async () => {
    setCodes((await api.api('me.recovery_codes_regenerate')).recovery_codes);
  });

  const secret = enrol?.kind === 'totp' ? totpSecret(enrol.uri) : null;
  return (
    <Card title={t('settings.security.mfaTitle')} text={t('settings.security.mfaText')}>
      {list.data ? null : <ReadState status={list.status} error={list.error} refetch={list.refetch} />}
      {list.data ? (
        active.length ? (
          <ul className="pwa-settings-list" aria-label={t('settings.security.methods')}>
            {active.map((m) => (
              <li key={m.id} className="pwa-settings-item">
                <div className="pwa-stack-xs">
                  <span className="pwa-text-label" dir="auto">
                    {m.label}
                  </span>
                  <span className="pwa-text-caption">
                    {t(m.method_type === 'totp_mfa' ? 'settings.security.kindTotp' : 'settings.security.kindPasskey')} ·{' '}
                    {m.last_used_at
                      ? t('settings.security.lastUsed', { when: f.relative(m.last_used_at) })
                      : t('settings.security.added', { when: f.date(m.created_at) })}
                  </span>
                </div>
                <Button size="sm" variant="ghost" icon="trash" onClick={() => setRemoving(m)}>
                  {t('settings.security.remove')}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pwa-text-body m-0">{t('settings.security.mfaOff')}</p>
        )
      ) : null}

      {enrol === null ? (
        <div className="pwa-inline-buttons">
          <Button size="sm" icon="lock" loading={busy === 'totp'} onClick={() => void startTotp()}>
            {t('settings.security.addTotp')}
          </Button>
          {supported ? (
            <Button size="sm" icon="shield" onClick={() => (setEnrol({ kind: 'passkey' }), setError(null))}>
              {t('settings.security.addPasskey')}
            </Button>
          ) : null}
          {active.length ? (
            <Button size="sm" variant="ghost" icon="refresh" loading={busy === 'codes'} onClick={() => void regenerate()}>
              {t('settings.security.newCodes')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {enrol?.kind === 'totp' ? (
        <form className="pwa-stack-sm" onSubmit={confirmTotp} noValidate>
          <p className="pwa-text-body m-0">{t('settings.security.scanText')}</p>
          <QrCode value={enrol.uri} label={t('settings.security.qrLabel')} className="pwa-qr" />
          {secret ? (
            <p className="pwa-text-caption m-0">
              {t('settings.security.keyText')}{' '}
              <bdi dir="ltr">
                <code data-testid="totp-secret">{secret}</code>
              </bdi>
            </p>
          ) : null}
          <TextField
            label={t('settings.security.codeFromApp')}
            inputMode="numeric"
            autoComplete="one-time-code"
            dir="ltr"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(toLatinDigits(e.target.value).replace(/\D/g, ''))}
          />
          <ErrorLine error={error} />
          <div className="pwa-inline-buttons">
            <Button type="submit" variant="primary" loading={busy === 'confirm'} disabled={code.length !== 6}>
              {t('settings.security.turnOn')}
            </Button>
            <Button variant="ghost" onClick={() => setEnrol(null)}>
              {t('common.actions.cancel')}
            </Button>
          </div>
        </form>
      ) : null}

      {enrol?.kind === 'passkey' ? (
        <form
          className="pwa-stack-sm"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void addPasskey();
          }}
        >
          <p className="pwa-text-body m-0">{t('settings.security.passkeyText')}</p>
          <TextField
            label={t('settings.security.passkeyName')}
            hint={t('settings.security.passkeyNameHint')}
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
          />
          <ErrorLine error={error} />
          <div className="pwa-inline-buttons">
            <Button type="submit" variant="primary" loading={busy === 'passkey'}>
              {t('settings.security.createPasskey')}
            </Button>
            <Button variant="ghost" onClick={() => setEnrol(null)}>
              {t('common.actions.cancel')}
            </Button>
          </div>
        </form>
      ) : null}

      {enrol === null ? <ErrorLine error={error} /> : null}

      <Dialog
        name="mfa-remove"
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={t('settings.security.removeTitle', { name: removing?.label ?? '' })}
        footer={
          <>
            <Button
              variant="danger"
              loading={removing !== null && busy === `remove:${removing.id}`}
              onClick={() => removing && void remove(removing)}
            >
              {t('settings.security.remove')}
            </Button>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              {t('common.actions.cancel')}
            </Button>
          </>
        }
      >
        <p className="pwa-text-body">{t(active.length <= 1 ? 'settings.security.removeLastText' : 'settings.security.removeText')}</p>
      </Dialog>
      {codes ? <RecoveryCodes codes={codes} onDone={() => setCodes(null)} /> : null}
    </Card>
  );
}

/** "cp-web-consumer" → "CarPal on the web"; app and portal clients by family. */
export function clientLabel(clientId: string): 'web' | 'app' | 'portal' | 'other' {
  if (clientId === 'cp-web-consumer') return 'web';
  if (clientId.startsWith('cp-ios') || clientId.startsWith('cp-android') || clientId.startsWith('cp-mobile')) return 'app';
  if (clientId.startsWith('cp-web-')) return 'portal';
  return 'other';
}

function SessionsCard() {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const api = useApiClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const logout = useLogout();
  const queryClient = useQueryClient();
  const sessions = useApiQuery('me.sessions_list', { query: { limit: 50 } });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['me.sessions_list'] });

  const signOut = async (s: Session) => {
    setBusy(s.id);
    setError(null);
    try {
      if (s.current) {
        await logout();
        goTo(`/${locale}`);
        return;
      }
      await api.api('me.session_revoke', { path: { session_id: s.id } });
      refresh();
      toast(
        t('settings.security.signedOutOne', {
          device:
            s.device_label && s.device_label !== s.client_id ? s.device_label : t(`settings.security.client.${clientLabel(s.client_id)}`),
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const signOutOthers = async () => {
    setBusy('all');
    setError(null);
    try {
      const r = await stepUp({
        type: 'settings.sessions_revoke_all',
        label: t('settings.stepUp.sessions'),
        run: () => api.api('me.sessions_revoke_all', { body: { keep_current: true } }),
      });
      if (r.steppingUp) return;
      refresh();
      toast(t('settings.security.signedOutOthers'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };
  useIntentHandler('settings.sessions_revoke_all', async () => {
    await api.api('me.sessions_revoke_all', { body: { keep_current: true } });
    refresh();
    return t('settings.security.signedOutOthers');
  });

  const items = sessions.data?.items ?? [];
  // The backend names web sessions by their client (device_label = client id) until it parses user agents.
  const device = (s: Session) =>
    s.device_label && s.device_label !== s.client_id
      ? s.device_label
      : t('settings.security.thisKind', { client: t(`settings.security.client.${clientLabel(s.client_id)}`) });
  const others = items.filter((s) => !s.current);
  return (
    <Card title={t('settings.security.sessionsTitle')} text={t('settings.security.sessionsText')}>
      {sessions.data ? null : <ReadState status={sessions.status} error={sessions.error} refetch={sessions.refetch} />}
      {sessions.data && items.length === 0 ? <p className="pwa-text-body m-0">{t('settings.security.noSessions')}</p> : null}
      {items.length ? (
        <div className="pwa-table-wrap">
          <table className="pwa-table pwa-table-stack">
            <caption className="sr-only">{t('settings.security.sessionsTitle')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('settings.security.colDevice')}</th>
                <th scope="col">{t('settings.security.colClient')}</th>
                <th scope="col">{t('settings.security.colLocation')}</th>
                <th scope="col">{t('settings.security.colActive')}</th>
                <th scope="col">
                  <span className="sr-only">{t('settings.security.colActions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} data-testid="session-row">
                  <td data-label={t('settings.security.colDevice')}>
                    <span dir="auto">{device(s)}</span>{' '}
                    {s.current ? (
                      <Badge tone="accent" icon="check">
                        {t('settings.security.current')}
                      </Badge>
                    ) : null}
                  </td>
                  <td data-label={t('settings.security.colClient')}>{t(`settings.security.client.${clientLabel(s.client_id)}`)}</td>
                  <td data-label={t('settings.security.colLocation')}>
                    {s.country ? <bdi>{s.country}</bdi> : t('settings.security.unknownLocation')}
                  </td>
                  <td data-label={t('settings.security.colActive')}>
                    <time dateTime={s.last_seen_at}>{f.relative(s.last_seen_at)}</time>
                  </td>
                  <td>
                    <Button size="sm" variant="ghost" icon="logout" loading={busy === s.id} onClick={() => void signOut(s)}>
                      {s.current ? t('settings.security.signOutHere') : t('settings.security.signOut')}
                      <span className="sr-only"> {device(s)}</span>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <ErrorLine error={error} />
      {others.length ? (
        <div className="pwa-inline-buttons">
          <Button size="sm" variant="danger" icon="logout" loading={busy === 'all'} onClick={() => void signOutOthers()}>
            {t('settings.security.signOutOthers')}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
