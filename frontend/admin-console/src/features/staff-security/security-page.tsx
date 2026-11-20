'use client';
// Security keys and recovery codes (AC10b.T2, Docs/23 A-AUTH-01, SEC-ADM-2, backend S16a): every staff member's own
// keys (name, added, last used), a backup key (device-bound only; at most 10), removing one (never the last
// device-bound key: 409 LAST_PASSKEY) and a new set of recovery codes (the old set stops working; shown once). The
// operations need a security-key sign-in within the last 5 minutes (401 STEP_UP_REQUIRED max_age=300): the kit's
// step-up asks for the key and brings the staff member back here. The action is then NOT repeated by itself (unlike
// useAdminAction's replay): a new key needs the browser's key prompt, which only a click may open, and new codes
// must be seen when they are made, so the page says "Confirmed" and the staff member presses the button again.
// The codes live only in this component's state (GD-12). These operations are AUD without RSN: no reason is asked.
import { useQueryClient } from '@tanstack/react-query';
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { useState, type FormEvent } from 'react';
import type { StaffPasskey, WebAuthnAttestation } from '@carpal/api-contracts';
import { ConfirmDialog, problemText } from '@/components/admin';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { passkeyAlreadyRegistered, passkeyCancelled, passkeysSupported, RecoveryCodes } from '@/features/auth';
import { useIntentHandler, useStepUp } from '@/features/shell';
import { ApiProblem } from '@/lib/api/problem';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { useBrowserValue } from '@/lib/browser';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey, Translate } from '@/lib/i18n/keys';
import { STAFF_ME_KEY } from './staff-me';

export const KEY_LABEL_MAX = 60;
/** The backend's limit of keys per account (Docs/40 admin.staff_passkey_register_options). */
export const PASSKEY_LIMIT = 10;

type Armed = 'add' | 'codes' | 'remove';
type Notice = { tone: 'success' | 'info' | 'warn' | 'danger'; text: string; testId: string };

const INTENT = { add: 'security.add_key', codes: 'security.new_codes', remove: 'security.remove_key' } as const;

/** What a failed key or code action says. */
export function securityProblem(err: unknown, t: Translate): string {
  if (!(err instanceof ApiProblem)) return t('admin.security.errors.generic');
  if (err.code === 'PASSKEY_NOT_DEVICE_BOUND') return t('admin.signin.errors.notDeviceBound');
  if (err.code === 'LAST_PASSKEY') return t('admin.security.errors.lastKey');
  if (err.code === 'INVALID_TRANSITION' && err.body.detail === 'passkey_limit')
    return t('admin.security.errors.limit', { n: PASSKEY_LIMIT });
  if (err.code === 'CODE_INVALID') return t('admin.security.errors.keyRejected');
  return problemText(err, t);
}

/** Keys that can sign in to the console first (device-bound), newest first within each group. */
export function sortKeys(keys: readonly StaffPasskey[]): StaffPasskey[] {
  return [...keys].sort((a, b) => Number(b.device_bound) - Number(a.device_bound) || b.created_at.localeCompare(a.created_at));
}

export function SecurityPage() {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const stepUp = useStepUp();
  const queryClient = useQueryClient();
  const canKey = useBrowserValue(passkeysSupported, true);
  const keys = useApiQuery('admin.staff_passkeys_list', undefined);
  const me = useApiQuery('admin.staff_me', undefined, { staleTime: 30_000 });

  const [label, setLabel] = useState('');
  const [labelError, setLabelError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState<Armed | null>(null);
  const [armed, setArmed] = useState<Armed | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [removeTarget, setRemoveTarget] = useState<StaffPasskey | null>(null);
  const [askCodes, setAskCodes] = useState(false);
  const [codes, setCodes] = useState<readonly string[] | null>(null);

  // Back from the security key: say so and let the staff member press the button again (see the header).
  useIntentHandler<{ label?: string }>(INTENT.add, (intent) => {
    setLabel(intent.draft?.label ?? '');
    setArmed('add');
  });
  useIntentHandler(INTENT.codes, () => setArmed('codes'));
  useIntentHandler<{ methodId?: string }>(INTENT.remove, (intent) => {
    const id = intent.draft?.methodId;
    const key = keys.data?.passkeys.find((k) => k.id === id) ?? null;
    setArmed('remove');
    if (key) setRemoveTarget(key);
  });

  const refreshKeys = () => void queryClient.invalidateQueries({ queryKey: apiQueryKey('admin.staff_passkeys_list') });
  const fail = (err: unknown) => setNotice({ tone: 'danger', text: securityProblem(err, t), testId: 'security-failed' });

  const addKey = async (e: FormEvent) => {
    e.preventDefault();
    const name = label.trim();
    if (!name) return setLabelError('admin.security.keys.labelMissing');
    if (name.length > KEY_LABEL_MAX) return setLabelError('admin.security.keys.labelLong');
    setLabelError(null);
    if (!canKey) return setNotice({ tone: 'danger', text: t('admin.signin.errors.unsupported'), testId: 'security-failed' });
    setNotice(null);
    setArmed(null);
    setBusy('add');
    try {
      const options = await stepUp({
        type: INTENT.add,
        draft: { label: name },
        run: () => api.api('admin.staff_passkey_register_options', { body: { label: name } }),
      });
      if (options.steppingUp) return;
      const attestation = await startRegistration({ optionsJSON: options.value as unknown as PublicKeyCredentialCreationOptionsJSON });
      const stored = await stepUp({
        type: INTENT.add,
        draft: { label: name },
        run: () => api.api('admin.staff_passkey_register', { body: { attestation: attestation as unknown as WebAuthnAttestation } }),
      });
      if (stored.steppingUp) return;
      setLabel('');
      setNotice({ tone: 'success', text: t('admin.security.keys.added', { name: stored.value.label }), testId: 'security-added' });
      refreshKeys();
    } catch (err) {
      if (passkeyCancelled(err)) return;
      if (passkeyAlreadyRegistered(err))
        return setNotice({ tone: 'warn', text: t('admin.security.errors.alreadyRegistered'), testId: 'security-failed' });
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const removeKey = async (key: StaffPasskey) => {
    setNotice(null);
    setArmed(null);
    setBusy('remove');
    try {
      const r = await stepUp({
        type: INTENT.remove,
        target: key.id,
        draft: { methodId: key.id },
        run: () => api.api('admin.staff_passkey_remove', { path: { method_id: key.id } }),
      });
      setRemoveTarget(null);
      if (r.steppingUp) return;
      setNotice({ tone: 'success', text: t('admin.security.keys.removed', { name: key.label }), testId: 'security-removed' });
      refreshKeys();
    } catch (err) {
      setRemoveTarget(null);
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const newCodes = async () => {
    setNotice(null);
    setArmed(null);
    setBusy('codes');
    try {
      const r = await stepUp({ type: INTENT.codes, run: () => api.api('admin.staff_recovery_codes_regenerate') });
      setAskCodes(false);
      if (r.steppingUp) return;
      setCodes(r.value.recovery_codes);
      void queryClient.invalidateQueries({ queryKey: STAFF_ME_KEY });
    } catch (err) {
      setAskCodes(false);
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const list = keys.data ? sortKeys(keys.data.passkeys) : [];
  const boundCount = list.filter((k) => k.device_bound).length;
  const atLimit = list.length >= PASSKEY_LIMIT;
  const remaining = me.data?.recovery_codes_remaining;

  if (codes) {
    return (
      <div className="adm-page adm-measure" data-testid="security-page">
        <h1 className="adm-page-title">{t('admin.security.title')}</h1>
        <Banner tone="success" text={t('admin.security.codes.made')} />
        <RecoveryCodes codes={codes} doneLabel={t('admin.security.codes.done')} onDone={() => setCodes(null)} />
      </div>
    );
  }

  return (
    <div className="adm-page" data-testid="security-page">
      <h1 className="adm-page-title">{t('admin.security.title')}</h1>
      <p className="adm-measure">{t('admin.security.intro')}</p>
      {armed ? (
        <div data-testid="security-armed" data-action={armed}>
          <Banner tone="info" text={t(`admin.security.armed.${armed}`)} />
        </div>
      ) : null}
      {notice ? (
        <div data-testid={notice.testId}>
          <Banner tone={notice.tone} text={notice.text} />
        </div>
      ) : null}

      <section aria-labelledby="security-keys" className="adm-measure">
        <h2 id="security-keys" className="adm-section-title">
          {t('admin.security.keys.title')}
        </h2>
        {keys.isError ? (
          <Banner tone="danger" text={t('admin.security.errors.load')} />
        ) : !keys.data ? (
          <p role="status">{t('admin.work.loading')}</p>
        ) : (
          <ul className="adm-keys" data-testid="security-keys">
            {list.map((k) => (
              <li key={k.id} className="adm-key" data-testid="security-key" data-key={k.id} data-bound={k.device_bound}>
                <div>
                  <p className="adm-key-name">
                    <Bidi>{k.label}</Bidi>
                  </p>
                  <p className="adm-muted">
                    {t('admin.security.keys.added_at', { when: f.date(k.created_at, 'date') })}
                    {' · '}
                    {k.last_used_at
                      ? t('admin.security.keys.lastUsed', { when: f.date(k.last_used_at, 'dateTime') })
                      : t('admin.security.keys.neverUsed')}
                  </p>
                  {!k.device_bound ? <p className="adm-muted">{t('admin.security.keys.notBound')}</p> : null}
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy !== null || (k.device_bound && boundCount <= 1)}
                  onClick={() => setRemoveTarget(k)}
                  aria-label={t('admin.security.keys.removeNamed', { name: k.label })}
                >
                  {t('admin.security.keys.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {keys.data && boundCount <= 1 ? <p className="adm-muted">{t('admin.security.keys.onlyOne')}</p> : null}

        <form className="adm-key-add" onSubmit={addKey} noValidate>
          <h3 className="adm-panel-title">{t('admin.security.keys.addTitle')}</h3>
          <p className="adm-muted">{t('admin.security.keys.addText')}</p>
          <TextField
            label={t('admin.security.keys.label')}
            hint={t('admin.security.keys.labelHint', { n: KEY_LABEL_MAX })}
            maxLength={KEY_LABEL_MAX}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            error={labelError ? t(labelError, { n: KEY_LABEL_MAX }) : undefined}
            disabled={atLimit}
          />
          {atLimit ? <p className="adm-muted">{t('admin.security.errors.limit', { n: PASSKEY_LIMIT })}</p> : null}
          <Button type="submit" variant="primary" icon="lock" loading={busy === 'add'} disabled={busy !== null || atLimit}>
            {t('admin.security.keys.add')}
          </Button>
        </form>
      </section>

      <section aria-labelledby="security-codes" className="adm-measure">
        <h2 id="security-codes" className="adm-section-title">
          {t('admin.security.codes.title')}
        </h2>
        <p data-testid="security-codes-left" data-remaining={remaining ?? ''}>
          {remaining === undefined ? '' : t('admin.security.codes.remaining', { n: f.number(remaining) })}
        </p>
        <p className="adm-muted">{t('admin.security.codes.text')}</p>
        <Button icon="refresh" loading={busy === 'codes'} disabled={busy !== null} onClick={() => setAskCodes(true)}>
          {t('admin.security.codes.new')}
        </Button>
      </section>
      <p className="adm-muted adm-measure">{t('admin.security.stepUpHint')}</p>

      <ConfirmDialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title={t('admin.security.keys.removeTitle')}
        confirmLabel={t('admin.security.keys.remove')}
        confirmVariant="danger"
        busy={busy === 'remove'}
        onConfirm={() => removeTarget && void removeKey(removeTarget)}
        name="remove-key"
      >
        {removeTarget ? (
          <p>
            {t('admin.security.keys.removeText', { name: removeTarget.label })} {t('admin.security.otherSessions')}
          </p>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={askCodes}
        onClose={() => setAskCodes(false)}
        title={t('admin.security.codes.newTitle')}
        confirmLabel={t('admin.security.codes.new')}
        busy={busy === 'codes'}
        onConfirm={() => void newCodes()}
        name="new-codes"
      >
        <p>{t('admin.security.codes.newText')}</p>
      </ConfirmDialog>
    </div>
  );
}
