'use client';
// A-AUTH-01 Staff sign-in (AC4.T1/T2, GD-04): the page the auth host sends the browser to (/id/signin?interaction_id=…),
// served on the console origin through the /id proxy. One page whose steps are client state, so the interaction
// (cookie-bound on the auth host) and the typed email survive between them:
//   sign-in   email + password (auth.signin_password, proof of work in strict mode), or the security key alone
//             (auth.webauthn_options purpose signin); for a step-up (prompt=login) the key comes first
//   enrol     a staff account without a device-bound key (next 'enrol_passkey'): the emailed code, then the browser
//             creates the key (auth.passkey_enrol_options, auth.passkey_enrol); the auth host asks for it at once
//   key       the second factor with the security key (next 'mfa'; staff use WebAuthn only, SEC-AU-9)
//   forgot    auth.password_reset_start (the emailed link opens the PWA's reset page, which completes it)
//   locked / expired / gate / finishing
// On next 'complete' the browser re-requests the authorize URL that started the interaction (resumeUrl) and the BFF
// finishes the sign-in. No sign-up, no one-time-code sign-in, no social sign-in, no "Keep me signed in" (GD-04, D-16).
import type { AuthNext } from '@carpal/api-contracts';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { TextField } from '@/components/ds/text-field';
import { goTo, useBrowserValue } from '@/lib/browser';
import { toLatinDigits } from '@/lib/format';
import { clock } from '@/lib/format/clock';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { browserPow, createAuthClient, type AuthClient } from './auth-client';
import {
  enrolmentOptions,
  enrolPasskey,
  passkeyAlreadyRegistered,
  passkeyCancelled,
  passkeysSupported,
  verifyWithPasskey,
} from './passkey';
import { authOutcome, type AuthOutcome } from './problems';

export interface StaffSignInProps {
  /** From the query; null when the page was opened without one. */
  interactionId: string | null;
  /** The authorize URL to re-request on completion (from the /id proxy's resume cookie); null = unknown interaction. */
  resumeUrl: string | null;
  /** "Start again" after the interaction expired (keeps the return path). */
  restartUrl: string;
  /** The authorize request asked for a fresh sign-in (prompt=login): a step-up for a sensitive action (GD-11). */
  stepUp: boolean;
  /** Tests inject a client; the page uses the /id proxy with proof of work. */
  auth?: AuthClient;
}

type Step =
  | { name: 'signin' }
  | { name: 'enrol' }
  | { name: 'mfa'; added: boolean }
  | { name: 'forgot'; email: string }
  | { name: 'forgotSent' }
  | { name: 'locked'; until: number }
  | { name: 'expired' }
  | { name: 'gate' }
  | { name: 'finishing' };

interface Flow {
  auth: AuthClient;
  interactionId: string;
  go: (step: Step) => void;
  /** Acts on an AuthNext: complete → back to the authorize URL; mfa → the key step; enrol_passkey → enrolment. */
  next: (n: AuthNext) => void;
  /** Expired, locked and gate outcomes move to their steps; the outcome is returned for the form to show the rest. */
  fail: (err: unknown, credentials?: MessageKey) => AuthOutcome;
}

/** The time of an event; only called from event handlers, never while rendering. */
const eventTime = (): number => Date.now();

export function StaffSignIn(props: StaffSignInProps) {
  const locale = useLocale();
  const auth = useMemo(
    () => props.auth ?? createAuthClient({ solvePow: (p) => browserPow(p), locale: () => locale }),
    [props.auth, locale],
  );
  // The typed email outlives the steps (back from a pause or a reset keeps it).
  const [email, setEmail] = useState('');
  const [step, setStep] = useState<Step>(() => (props.interactionId && props.resumeUrl ? { name: 'signin' } : { name: 'expired' }));

  if (!props.interactionId || !props.resumeUrl || step.name === 'expired') return <Expired restartUrl={props.restartUrl} />;
  const resumeUrl = props.resumeUrl;

  const flow: Flow = {
    auth,
    interactionId: props.interactionId,
    go: setStep,
    fail(err, credentials) {
      const outcome = authOutcome(err, credentials);
      if (outcome.kind === 'expired') setStep({ name: 'expired' });
      else if (outcome.kind === 'locked') setStep({ name: 'locked', until: eventTime() + outcome.retryAfterMs });
      else if (outcome.kind === 'gate') setStep({ name: 'gate' });
      return outcome;
    },
    next(n) {
      if (n.next === 'complete') {
        setStep({ name: 'finishing' });
        goTo(resumeUrl);
      } else if (n.next === 'enrol_passkey') setStep({ name: 'enrol' });
      else if (n.next === 'mfa') setStep({ name: 'mfa', added: step.name === 'enrol' });
      // verify_email, verify_phone, consent and reactivate are consumer steps: a staff account never gets them (the
      // backend answers them only for accounts that are not active staff). Treat them as a failed sign-in.
      else setStep({ name: 'expired' });
    },
  };

  return (
    <div className="adm-auth-steps" data-step={step.name}>
      {step.name === 'signin' ? <SigninStep flow={flow} email={email} onEmail={setEmail} stepUp={props.stepUp} /> : null}
      {step.name === 'enrol' ? <EnrolStep flow={flow} restartUrl={props.restartUrl} /> : null}
      {step.name === 'mfa' ? <KeyStep flow={flow} added={step.added} restartUrl={props.restartUrl} /> : null}
      {step.name === 'forgot' ? <ForgotStep flow={flow} initialEmail={step.email} /> : null}
      {step.name === 'forgotSent' ? <ForgotSent flow={flow} /> : null}
      {step.name === 'locked' ? <Locked flow={flow} until={step.until} /> : null}
      {step.name === 'gate' ? <Gate /> : null}
      {step.name === 'finishing' ? <Finishing /> : null}
    </div>
  );
}

/** The step's heading takes focus when the step opens (not on first load), so screen readers hear where they are. */
function StepTitle({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (document.activeElement === document.body || document.activeElement === null) return;
    ref.current?.focus();
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1} className="adm-auth-title">
      {children}
    </h1>
  );
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="adm-auth-error" role="alert">
      <Icon name="alert" size={16} />
      {message}
    </p>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------- email + password, or the key alone

function SigninStep({ flow, email, onEmail, stepUp }: { flow: Flow; email: string; onEmail: (v: string) => void; stepUp: boolean }) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'password' | 'key' | null>(null);
  const [emailError, setEmailError] = useState<MessageKey | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const canKey = useBrowserValue(passkeysSupported, true);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setEmailError(null);
    const address = email.trim();
    if (!EMAIL.test(address)) return setEmailError('admin.signin.errors.emailMissing');
    if (!password) return setError('admin.signin.errors.passwordMissing');
    setBusy('password');
    try {
      flow.next(await flow.auth.call('auth.signin_password', { interaction_id: flow.interactionId, email: address, password }));
    } catch (err) {
      const outcome = flow.fail(err, 'admin.signin.errors.invalid');
      if (outcome.kind === 'message') setError(outcome.message);
    } finally {
      setBusy(null);
    }
  };

  const withKey = async () => {
    setError(null);
    if (!canKey) return setError('admin.signin.errors.unsupported');
    setBusy('key');
    try {
      flow.next(await verifyWithPasskey(flow.auth, flow.interactionId, 'signin'));
    } catch (err) {
      if (passkeyCancelled(err)) return;
      const outcome = flow.fail(err, 'admin.signin.errors.keyFailed');
      if (outcome.kind === 'message')
        setError(outcome.message === 'admin.signin.errors.generic' ? 'admin.signin.errors.keyFailed' : outcome.message);
    } finally {
      setBusy(null);
    }
  };

  const keyButton = (
    <Button
      variant={stepUp ? 'primary' : 'secondary'}
      icon="lock"
      block
      loading={busy === 'key'}
      disabled={busy !== null}
      onClick={() => void withKey()}
    >
      {t('admin.signin.withKey')}
    </Button>
  );

  return (
    <div className="adm-auth-step">
      <StepTitle>{t(stepUp ? 'admin.signin.stepUpTitle' : 'admin.signin.title')}</StepTitle>
      <p className="adm-auth-text">{t(stepUp ? 'admin.signin.stepUpText' : 'admin.signin.intro')}</p>
      {stepUp ? (
        <>
          {keyButton}
          <p className="adm-auth-or">{t('admin.signin.or')}</p>
        </>
      ) : null}
      <form className="adm-auth-step" onSubmit={submit} noValidate>
        <TextField
          label={t('admin.signin.email')}
          type="email"
          name="username"
          autoComplete="username"
          dir="ltr"
          value={email}
          onChange={(e) => onEmail(e.target.value)}
          error={emailError ? t(emailError) : undefined}
          required
        />
        <TextField
          label={t('admin.signin.password')}
          type="password"
          name="password"
          autoComplete="current-password"
          dir="ltr"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <FormError message={error ? t(error) : null} />
        <Button type="submit" variant={stepUp ? 'secondary' : 'primary'} block loading={busy === 'password'} disabled={busy !== null}>
          {t('admin.signin.continue')}
        </Button>
      </form>
      {stepUp ? null : (
        <>
          <p className="adm-auth-or">{t('admin.signin.or')}</p>
          {keyButton}
        </>
      )}
      <button type="button" className="adm-link adm-auth-aside" onClick={() => flow.go({ name: 'forgot', email: email.trim() })}>
        {t('admin.signin.forgotLink')}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- first security key (BR-03, SEC-ADM-2)

function EnrolStep({ flow, restartUrl }: { flow: Flow; restartUrl: string }) {
  const t = useT();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const canKey = useBrowserValue(passkeysSupported, true);
  // A checked code's options are kept, so a cancelled browser prompt can try again without a new code.
  const options = useRef<{ code: string; value: PublicKeyCredentialCreationOptionsJSON } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const digits = toLatinDigits(code).replace(/\s/g, '');
    if (!/^\d{6}$/.test(digits)) return setError('admin.signin.errors.codeFormat');
    if (!canKey) return setError('admin.signin.errors.unsupported');
    setBusy(true);
    try {
      if (options.current?.code !== digits)
        options.current = { code: digits, value: await enrolmentOptions(flow.auth, flow.interactionId, digits) };
      flow.next(await enrolPasskey(flow.auth, flow.interactionId, options.current.value));
    } catch (err) {
      if (passkeyCancelled(err)) return;
      if (passkeyAlreadyRegistered(err)) return setError('admin.signin.errors.alreadyRegistered');
      const outcome = flow.fail(err, 'admin.signin.errors.codeWrong');
      if (outcome.kind === 'message') {
        if (outcome.message === 'admin.signin.errors.codeWrong') options.current = null;
        setError(outcome.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="adm-auth-step" onSubmit={submit} noValidate>
      <StepTitle>{t('admin.signin.enrol.title')}</StepTitle>
      <p className="adm-auth-text">{t('admin.signin.enrol.why')}</p>
      <Banner tone="info" icon="doc" text={t('admin.signin.enrol.sent')} />
      <TextField
        label={t('admin.signin.enrol.code')}
        hint={t('admin.signin.enrol.codeHint')}
        name="one-time-code"
        autoComplete="one-time-code"
        inputMode="numeric"
        dir="ltr"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        required
      />
      <FormError message={error ? t(error) : null} />
      <Button type="submit" variant="primary" icon="lock" block loading={busy}>
        {t('admin.signin.enrol.create')}
      </Button>
      <p className="adm-auth-text adm-auth-aside">
        {t('admin.signin.enrol.noCode')}{' '}
        <a className="adm-link" href={restartUrl}>
          {t('admin.signin.expired.restart')}
        </a>
      </p>
    </form>
  );
}

// ---------------------------------------------------------------- the security key as the second factor

function KeyStep({ flow, added, restartUrl }: { flow: Flow; added: boolean; restartUrl: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const canKey = useBrowserValue(passkeysSupported, true);

  const verify = async () => {
    setError(null);
    if (!canKey) return setError('admin.signin.errors.unsupported');
    setBusy(true);
    try {
      flow.next(await verifyWithPasskey(flow.auth, flow.interactionId, 'mfa'));
    } catch (err) {
      if (passkeyCancelled(err)) return;
      const outcome = flow.fail(err, 'admin.signin.errors.keyFailed');
      if (outcome.kind === 'message')
        setError(outcome.message === 'admin.signin.errors.generic' ? 'admin.signin.errors.keyFailed' : outcome.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="adm-auth-step">
      <StepTitle>{t('admin.signin.mfa.title')}</StepTitle>
      {added ? <Banner tone="success" text={t('admin.signin.mfa.added')} /> : null}
      <p className="adm-auth-text">{t('admin.signin.mfa.text')}</p>
      <FormError message={error ? t(error) : null} />
      <Button variant="primary" icon="lock" block loading={busy} onClick={() => void verify()}>
        {t('admin.signin.mfa.action')}
      </Button>
      <a className="adm-link adm-auth-aside" href={restartUrl}>
        {t('admin.signin.expired.restart')}
      </a>
    </div>
  );
}

// ---------------------------------------------------------------- forgot password

function ForgotStep({ flow, initialEmail }: { flow: Flow; initialEmail: string }) {
  const t = useT();
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    if (!EMAIL.test(address)) return setError('admin.signin.errors.emailMissing');
    setBusy(true);
    setError(null);
    try {
      await flow.auth.call('auth.password_reset_start', { email: address });
      flow.go({ name: 'forgotSent' });
    } catch (err) {
      const outcome = flow.fail(err);
      if (outcome.kind === 'message') setError(outcome.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="adm-auth-step" onSubmit={submit} noValidate>
      <StepTitle>{t('admin.signin.forgot.title')}</StepTitle>
      <p className="adm-auth-text">{t('admin.signin.forgot.text')}</p>
      <TextField
        label={t('admin.signin.email')}
        type="email"
        autoComplete="username"
        dir="ltr"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={error ? t(error) : undefined}
      />
      <Button type="submit" variant="primary" block loading={busy}>
        {t('admin.signin.forgot.send')}
      </Button>
      <button type="button" className="adm-link adm-auth-aside" onClick={() => flow.go({ name: 'signin' })}>
        {t('admin.signin.forgot.back')}
      </button>
    </form>
  );
}

function ForgotSent({ flow }: { flow: Flow }) {
  const t = useT();
  return (
    <div className="adm-auth-step">
      <StepTitle>{t('admin.signin.forgot.title')}</StepTitle>
      <Banner tone="plain" text={t('admin.signin.forgot.sent')} />
      <Button block onClick={() => flow.go({ name: 'signin' })}>
        {t('admin.signin.forgot.back')}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- paused, expired, gate, finishing

function useCountdown(untilMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (untilMs <= now) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [untilMs, now]);
  return Math.max(0, Math.ceil((untilMs - now) / 1000));
}

function Locked({ flow, until }: { flow: Flow; until: number }) {
  const t = useT();
  const f = useFormat();
  const left = useCountdown(until);
  return (
    <div className="adm-auth-step">
      <StepTitle>{t('admin.signin.locked.title')}</StepTitle>
      <p className="adm-auth-text">{left > 0 ? t('admin.signin.locked.text') : t('admin.signin.locked.ready')}</p>
      {left > 0 ? (
        <p className="adm-auth-countdown" aria-live="polite">
          {clock(left, f.digits)}
        </p>
      ) : null}
      <Button variant={left > 0 ? 'secondary' : 'primary'} block onClick={() => flow.go({ name: 'signin' })}>
        {t('admin.signin.locked.back')}
      </Button>
    </div>
  );
}

function Expired({ restartUrl }: { restartUrl: string }) {
  const t = useT();
  return (
    <div className="adm-auth-step" data-step="expired">
      <StepTitle>{t('admin.signin.expired.title')}</StepTitle>
      <p className="adm-auth-text">{t('admin.signin.expired.text')}</p>
      <a href={restartUrl} className={buttonClass({ variant: 'primary', block: true })}>
        <span className="cp-btn-label">{t('admin.signin.expired.restart')}</span>
      </a>
    </div>
  );
}

function Gate() {
  const t = useT();
  return (
    <div className="adm-auth-step">
      <StepTitle>{t('admin.signin.gate.title')}</StepTitle>
      <Banner tone="warn" icon="shield" text={t('admin.signin.gate.text')} />
    </div>
  );
}

function Finishing() {
  const t = useT();
  return (
    <p className="adm-auth-finishing" role="status" aria-live="polite">
      <Icon name="check" size={24} />
      {t('admin.signin.finishing')}
    </p>
  );
}
