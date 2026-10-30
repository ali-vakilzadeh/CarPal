'use client';
// W-SET-01 Profile (mirrors C-PROF-01; P9.T2): the public display name with its preview ("Your reviews show: Sara M."),
// the private full name, and the contact details with their verified marks and Change: a new email gets a
// verification link and changes only once it is opened (me.email_change, AAL2); a new phone gets a code
// (me.phone_change_start, AAL2 → me.phone_change_verify). Both AAL2 starts go through the step-up and are repeated
// after it (the draft holds the new address or number, never a code). The contact card is the target of
// "Verify your contact details" links (#contact, e.g. from comments: 403 VERIFIED_CONTACT_REQUIRED).
import type { Me } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ds/badge';
import { Button } from '@/components/ds/button';
import { TextField } from '@/components/ds/text-field';
import { useIntentHandler } from '@/components/shell/auth-intent';
import { useStepUp } from '@/components/shell/step-up';
import { useToast } from '@/components/shell/toast';
import { maskDestination, normalizePhone } from '@/features/auth';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { SESSION_QUERY_KEY } from '@/lib/api/session';
import { useRegion } from '@/lib/config/client';
import { toLatinDigits } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { publicName } from './model';
import { Card, ErrorLine, ReadState } from './parts';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@.]{2,}$/;

export function ProfileSection() {
  const me = useApiQuery('me.get', undefined, { staleTime: 60_000 });
  if (!me.data) return <ReadState status={me.status} error={me.error} refetch={me.refetch} />;
  return (
    <div className="pwa-stack">
      <NamesCard me={me.data} />
      <ContactCard me={me.data} />
    </div>
  );
}

function useMeRefresh() {
  const queryClient = useQueryClient();
  return (me?: Me) => {
    if (me) queryClient.setQueryData(apiQueryKey('me.get'), me);
    else void queryClient.invalidateQueries({ queryKey: apiQueryKey('me.get') });
    // The header shows the display name from the BFF session (refreshed from me.get / me.update, P9).
    void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  };
}

function NamesCard({ me }: { me: Me }) {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useMeRefresh();
  const [display, setDisplay] = useState(me.display_name ?? '');
  const [full, setFull] = useState(me.full_name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const preview = publicName(full, display);
  const fullInvalid = full.trim().length < 1;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (fullInvalid) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.api('me.update', { body: { display_name: display.trim() || null, full_name: full.trim() } });
      refresh(next);
      toast(t('settings.profile.saved'));
    } catch (err) {
      setError(err);
      // 412: someone changed the account elsewhere — reload it but keep what was typed here.
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('settings.profile.namesTitle')}>
      <form className="pwa-stack-sm" onSubmit={save} noValidate>
        <TextField
          label={t('settings.profile.displayName')}
          hint={t('settings.profile.preview', { name: preview || '—' })}
          value={display}
          maxLength={60}
          autoComplete="nickname"
          onChange={(e) => setDisplay(e.target.value)}
        />
        <TextField
          label={t('settings.profile.fullName')}
          hint={t('settings.profile.fullNameHint')}
          value={full}
          maxLength={120}
          autoComplete="name"
          error={fullInvalid ? t('settings.profile.fullNameRequired') : undefined}
          onChange={(e) => setFull(e.target.value)}
        />
        <ErrorLine error={error} />
        <div className="pwa-inline-buttons">
          <Button type="submit" variant="primary" loading={busy} disabled={fullInvalid}>
            {t('common.actions.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

type EmailDraft = { new_email: string };
type PhoneDraft = { phone: string };

function ContactCard({ me }: { me: Me }) {
  const t = useT();
  const api = useApiClient();
  const toast = useToast();
  const region = useRegion();
  const stepUp = useStepUp();
  const refresh = useMeRefresh();
  const codes = region.sms_country_codes;
  const [editing, setEditing] = useState<'email' | 'phone' | null>(null);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [sentTo, setSentTo] = useState<{ kind: 'email' | 'phone'; value: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const startEmail = async (newEmail: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await stepUp<unknown, EmailDraft>({
        type: 'settings.email_change',
        draft: { new_email: newEmail },
        label: t('settings.stepUp.email'),
        run: () => api.api('me.email_change', { body: { new_email: newEmail } }),
      });
      if (r.steppingUp) return;
      setSentTo({ kind: 'email', value: newEmail });
      setEditing(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const startPhone = async (e164: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await stepUp<unknown, PhoneDraft>({
        type: 'settings.phone_change',
        draft: { phone: e164 },
        label: t('settings.stepUp.phone'),
        run: () => api.api('me.phone_change_start', { body: { phone: e164 } }),
      });
      if (r.steppingUp) return;
      setSentTo({ kind: 'phone', value: e164 });
      setEditing('phone');
      setCode('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  // After the step-up sign-in: send the link or code that was asked for before it.
  useIntentHandler<EmailDraft>('settings.email_change', async (intent) => {
    if (!intent.draft?.new_email) return;
    await api.api('me.email_change', { body: { new_email: intent.draft.new_email } });
    setSentTo({ kind: 'email', value: intent.draft.new_email });
    return t('settings.profile.emailSent', { email: intent.draft.new_email });
  });
  useIntentHandler<PhoneDraft>('settings.phone_change', async (intent) => {
    if (!intent.draft?.phone) return;
    await api.api('me.phone_change_start', { body: { phone: intent.draft.phone } });
    setSentTo({ kind: 'phone', value: intent.draft.phone });
    setEditing('phone');
    return t('settings.profile.codeSent');
  });

  const verifyPhone = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      refresh(await api.api('me.phone_change_verify', { body: { code: code.trim() } }));
      setSentTo(null);
      setEditing(null);
      toast(t('settings.profile.phoneChanged'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const e164 = normalizePhone(phone, codes);
  const verified = (at: string | null) =>
    at ? (
      <Badge tone="success" icon="check">
        {t('settings.profile.verified')}
      </Badge>
    ) : (
      <Badge tone="signal" icon="alert">
        {t('settings.profile.notVerified')}
      </Badge>
    );

  return (
    <Card id="contact" title={t('settings.profile.contactTitle')} text={t('settings.profile.contactText')}>
      <dl className="pwa-settings-facts">
        <div>
          <dt>{t('settings.profile.email')}</dt>
          <dd>
            <bdi dir="ltr">{me.email}</bdi> {verified(me.email_verified_at)}
          </dd>
        </div>
        <div>
          <dt>{t('settings.profile.phone')}</dt>
          <dd>
            {me.phone ? <bdi dir="ltr">{me.phone}</bdi> : t('settings.profile.noPhone')} {me.phone ? verified(me.phone_verified_at) : null}
          </dd>
        </div>
      </dl>
      {sentTo?.kind === 'email' ? (
        <p className="pwa-text-body m-0" role="status">
          {t('settings.profile.emailSent', { email: sentTo.value })}
        </p>
      ) : null}
      {editing === null ? (
        <div className="pwa-inline-buttons">
          <Button size="sm" icon="edit" onClick={() => (setEditing('email'), setError(null))}>
            {t('settings.profile.changeEmail')}
          </Button>
          <Button size="sm" icon="phone" onClick={() => (setEditing('phone'), setSentTo(null), setError(null))}>
            {me.phone ? t('settings.profile.changePhone') : t('settings.profile.addPhone')}
          </Button>
        </div>
      ) : null}
      {editing === 'email' ? (
        <form
          className="pwa-stack-sm"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (EMAIL.test(email.trim())) void startEmail(email.trim());
          }}
        >
          <TextField
            label={t('settings.profile.newEmail')}
            hint={t('settings.profile.newEmailHint')}
            type="email"
            dir="ltr"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <ErrorLine error={error} />
          <div className="pwa-inline-buttons">
            <Button type="submit" variant="primary" loading={busy} disabled={!EMAIL.test(email.trim())}>
              {t('settings.profile.sendLink')}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {t('common.actions.cancel')}
            </Button>
          </div>
        </form>
      ) : null}
      {editing === 'phone' && sentTo?.kind !== 'phone' ? (
        <form
          className="pwa-stack-sm"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (e164) void startPhone(e164);
          }}
        >
          <TextField
            label={t('settings.profile.newPhone')}
            hint={t('settings.profile.newPhoneHint')}
            type="tel"
            dir="ltr"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <ErrorLine error={error} />
          <div className="pwa-inline-buttons">
            <Button type="submit" variant="primary" loading={busy} disabled={!e164}>
              {t('settings.profile.sendCode')}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {t('common.actions.cancel')}
            </Button>
          </div>
        </form>
      ) : null}
      {editing === 'phone' && sentTo?.kind === 'phone' ? (
        <form className="pwa-stack-sm" noValidate onSubmit={verifyPhone}>
          <p className="pwa-text-body m-0" role="status">
            {t('settings.profile.codeSentTo', { phone: maskDestination(sentTo.value, codes) })}
          </p>
          <TextField
            label={t('settings.profile.code')}
            inputMode="numeric"
            autoComplete="one-time-code"
            dir="ltr"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(toLatinDigits(e.target.value).replace(/\D/g, ''))}
          />
          <ErrorLine error={error} />
          <div className="pwa-inline-buttons">
            <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>
              {t('settings.profile.confirm')}
            </Button>
            <Button variant="ghost" onClick={() => (setEditing(null), setSentTo(null))}>
              {t('common.actions.cancel')}
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
