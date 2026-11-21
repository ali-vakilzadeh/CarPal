'use client';
// A-AUTH-01 Staff sign-in (AC4.T1/T2, GD-04): the page the auth host sends the browser to (/id/signin?interaction_id=…),
// served on the console origin through the /id proxy. One page whose steps are client state, so the interaction
// (cookie-bound on the auth host) and the typed email survive between them:
//   sign-in   email + password (auth.signin_password, proof of work in strict mode), or the security key alone
//             (auth.webauthn_options purpose signin); for a step-up (prompt=login) the key comes first
//   password  a staff account seeded with an initial or one-time password (next 'change_password', contract 1.5.0,
//             AC14b.T2): the emailed code and a new password twice (auth.password_set_initial); no way to skip. The
//             same code then opens the enrolment of an account without a key (carried over, not typed again)
//   enrol     a staff account without a device-bound key (next 'enrol_passkey'): the emailed code, then the browser
//             creates the key (auth.passkey_enrol_options, auth.passkey_enrol); the auth host asks for it at once
//   key       the second factor with the security key (next 'mfa'; staff use WebAuthn only, SEC-AU-9)
//   codes     the staff recovery codes, shown once after a new key (AuthNext.recovery_codes, AC10b.T1), then the key
//   forgot    auth.password_reset_start (the emailed link opens the PWA's reset page, which completes it)
//   recover…  "Lost my security key" (AC10b.T3, backend S16b): the account email, the password (or "forgotten") and a
//             recovery code (auth.staff_recovery_start), the emailed code (…_verify), the wait for two administrators
//             (…_status, polled), then the new password if forgotten and the new key (…_complete_options, …_complete),
//             the new codes and the key step. The /id proxy keeps the request handle server-side; when this browser
//             has a recovery on file, the page opens on the waiting step, so an approval hours later continues in a
//             new sign-in.
//   locked / expired / gate / finishing
// On next 'complete' the browser re-requests the authorize URL that started the interaction (resumeUrl) and the BFF
// finishes the sign-in. No sign-up, no one-time-code sign-in, no social sign-in, no "Keep me signed in" (GD-04, D-16).
import type { AuthNext, StaffRecoveryStatus } from '@carpal/api-contracts';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Banner } from '@/components/ds/banner';
import { Check } from '@/components/ds/check';
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
  completeRecovery,
  enrolmentOptions,
  enrolPasskey,
  passkeyAlreadyRegistered,
  passkeyCancelled,
  passkeysSupported,
  recoveryKeyOptions,
  verifyWithPasskey,
} from './passkey';
import { NEW_PASSWORD_MAX, NEW_PASSWORD_MIN, newPasswordProblem, newPasswordRefusal, passwordStrength } from './password-rules';
import { authOutcome, type AuthOutcome } from './problems';
import { RecoveryCodes } from './recovery-codes';

export interface StaffSignInProps {
  /** From the query; null when the page was opened without one. */
  interactionId: string | null;
  /** The authorize URL to re-request on completion (from the /id proxy's resume cookie); null = unknown interaction. */
  resumeUrl: string | null;
  /** "Start again" after the interaction expired (keeps the return path). */
  restartUrl: string;
  /** The authorize request asked for a fresh sign-in (prompt=login): a step-up for a sensitive action (GD-11). */
  stepUp: boolean;
  /** This browser has a staff account recovery on file (the BFF's cookie, AC10b): open on its waiting step. */
  recoveryPending?: boolean;
  /** Tests inject a client; the page uses the /id proxy with proof of work. */
  auth?: AuthClient;
}

type Step =
  | { name: 'signin' }
  | { name: 'password' }
  | { name: 'enrol'; code?: string }
  | { name: 'mfa'; added: boolean; passwordChanged?: boolean }
  | { name: 'codes'; codes: readonly string[]; then: AuthNext; added: boolean }
  | { name: 'recover'; email: string }
  | { name: 'recoverCode' }
  | { name: 'recoverWait'; status: StaffRecoveryStatus | null }
  | { name: 'recoverKey'; passwordForgotten: boolean }
  | { name: 'forgot'; email: string }
  | { name: 'forgotSent' }
  | { name: 'locked'; until: number }
  | { name: 'expired'; note?: MessageKey }
  | { name: 'gate' }
  | { name: 'finishing' };

interface Flow {
  auth: AuthClient;
  interactionId: string;
  go: (step: Step) => void;
  /**
   * Acts on an AuthNext: recovery codes → shown once first; complete → back to the authorize URL; mfa → the key step
   * ('added': a new key was just made); enrol_passkey → enrolment.
   */
  next: (n: AuthNext, added?: boolean) => void;
  /** Expired, locked and gate outcomes move to their steps; the outcome is returned for the form to show the rest. */
  fail: (err: unknown, credentials?: MessageKey) => AuthOutcome;
}

/**
 * What "This sign-in page has expired" adds for the step it expired in: after a new key the key is kept (sign in
 * with it); during a recovery the request is kept (start again from this browser to continue).
 */
function expiredNote(step: Step): { note?: MessageKey } {
  if ((step.name === 'mfa' && step.added) || step.name === 'codes') return { note: 'admin.signin.expired.keySaved' };
  // After the first-sign-in password change (AC14b.T2): the initial password no longer works, the new one does.
  if ((step.name === 'enrol' && step.code) || (step.name === 'mfa' && step.passwordChanged))
    return { note: 'admin.signin.expired.passwordSaved' };
  if (step.name.startsWith('recover')) return { note: 'admin.signin.expired.recovery' };
  return {};
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
  const [step, setStep] = useState<Step>(() =>
    !props.interactionId || !props.resumeUrl
      ? { name: 'expired' }
      : props.recoveryPending && !props.stepUp
        ? { name: 'recoverWait', status: null }
        : { name: 'signin' },
  );

  if (!props.interactionId || !props.resumeUrl || step.name === 'expired')
    return <Expired restartUrl={props.restartUrl} note={step.name === 'expired' ? step.note : undefined} />;
  const resumeUrl = props.resumeUrl;

  const flow: Flow = {
    auth,
    interactionId: props.interactionId,
    go: setStep,
    fail(err, credentials) {
      const outcome = authOutcome(err, credentials);
      if (outcome.kind === 'expired') setStep({ name: 'expired', ...expiredNote(step) });
      else if (outcome.kind === 'locked') setStep({ name: 'locked', until: eventTime() + outcome.retryAfterMs });
      else if (outcome.kind === 'gate') setStep({ name: 'gate' });
      return outcome;
    },
    next(n, added = step.name === 'enrol' || step.name === 'recoverKey') {
      if (n.recovery_codes?.length) {
        const { recovery_codes: codes, ...rest } = n;
        setStep({ name: 'codes', codes, then: rest, added });
      } else if (n.next === 'complete') {
        setStep({ name: 'finishing' });
        goTo(resumeUrl);
      } else if (n.next === 'change_password') setStep({ name: 'password' });
      else if (n.next === 'enrol_passkey') setStep({ name: 'enrol' });
      else if (n.next === 'mfa') setStep({ name: 'mfa', added });
      // verify_email, verify_phone, consent and reactivate are consumer steps: a staff account never gets them (the
      // backend answers them only for accounts that are not active staff). Treat them as a failed sign-in.
      else setStep({ name: 'expired' });
    },
  };

  return (
    <div className="adm-auth-steps" data-step={step.name}>
      {step.name === 'signin' ? <SigninStep flow={flow} email={email} onEmail={setEmail} stepUp={props.stepUp} /> : null}
      {step.name === 'password' ? <PasswordStep flow={flow} restartUrl={props.restartUrl} /> : null}
      {step.name === 'enrol' ? <EnrolStep flow={flow} restartUrl={props.restartUrl} code={step.code} /> : null}
      {step.name === 'mfa' ? (
        <KeyStep flow={flow} added={step.added} passwordChanged={!!step.passwordChanged} restartUrl={props.restartUrl} />
      ) : null}
      {step.name === 'codes' ? <CodesStep flow={flow} codes={step.codes} then={step.then} added={step.added} /> : null}
      {step.name === 'recover' ? <RecoverStep flow={flow} initialEmail={step.email} /> : null}
      {step.name === 'recoverCode' ? <RecoverCodeStep flow={flow} /> : null}
      {step.name === 'recoverWait' ? <RecoverWaitStep flow={flow} initial={step.status} /> : null}
      {step.name === 'recoverKey' ? <RecoverKeyStep flow={flow} passwordForgotten={step.passwordForgotten} /> : null}
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
        {/* An expired initial password gets the same answer as a wrong one (SEC-AU-11, backend S26a): say what to do. */}
        {error === 'admin.signin.errors.invalid' && !stepUp ? (
          <p className="adm-auth-text">{t('admin.signin.errors.initialExpired')}</p>
        ) : null}
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
      {stepUp ? null : (
        <button type="button" className="adm-link adm-auth-aside" onClick={() => flow.go({ name: 'recover', email: email.trim() })}>
          {t('admin.signin.recover.link')}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- first sign-in password change (AC14b.T2, SEC-ADM-2)

/** Show or hide a password field's text (the field stays type=password unless asked). */
function RevealButton({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <button type="button" className="adm-auth-reveal" aria-pressed={shown} aria-label={t('admin.signin.initial.show')} onClick={onToggle}>
      <Icon name="eye" size={20} />
    </button>
  );
}

function PasswordStep({ flow, restartUrl }: { flow: Flow; restartUrl: string }) {
  const t = useT();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ code?: MessageKey; password?: MessageKey; repeat?: MessageKey; form?: MessageKey }>({});
  const strength = password ? passwordStrength(password) : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const digits = toLatinDigits(code).replace(/\s/g, '');
    const next: typeof errors = {};
    if (!/^\d{6}$/.test(digits)) next.code = 'admin.signin.errors.codeFormat';
    const problem = newPasswordProblem(password, repeat);
    if (problem === 'length') next.password = 'admin.signin.initial.errors.length';
    else if (problem === 'repeat') next.repeat = 'admin.signin.initial.errors.repeat';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const answer = await flow.auth.call('auth.password_set_initial', {
        interaction_id: flow.interactionId,
        code: digits,
        new_password: password,
      });
      // No key yet: the same code opens the enrolment, so it is carried over. With a key: the key step.
      if (answer.next === 'enrol_passkey') flow.go({ name: 'enrol', code: digits });
      else if (answer.next === 'mfa') flow.go({ name: 'mfa', added: false, passwordChanged: true });
      else flow.next(answer);
    } catch (err) {
      const refusal = newPasswordRefusal(err);
      if (refusal) return setErrors({ password: refusal });
      // Five wrong codes end the interaction (410): the expired step.
      const outcome = flow.fail(err, 'admin.signin.errors.codeWrong');
      if (outcome.kind === 'message')
        setErrors(outcome.message === 'admin.signin.errors.codeWrong' ? { code: outcome.message } : { form: outcome.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="adm-auth-step" onSubmit={submit} noValidate data-testid="change-password">
      <StepTitle>{t('admin.signin.initial.title')}</StepTitle>
      <p className="adm-auth-text">{t('admin.signin.initial.why')}</p>
      <Banner tone="info" icon="doc" text={t('admin.signin.initial.sent')} />
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
        error={errors.code ? t(errors.code) : undefined}
        required
      />
      <div className="adm-auth-rules">
        <p className="adm-auth-text">{t('admin.signin.initial.rulesTitle')}</p>
        <ul>
          <li>{t('admin.signin.initial.rules.length')}</li>
          <li>{t('admin.signin.initial.rules.breached')}</li>
          <li>{t('admin.signin.initial.rules.initial')}</li>
        </ul>
        <p className="adm-auth-text">{t('admin.signin.initial.rules.tip')}</p>
      </div>
      <TextField
        label={t('admin.signin.initial.new')}
        type={shown ? 'text' : 'password'}
        name="new-password"
        autoComplete="new-password"
        spellCheck={false}
        dir="ltr"
        maxLength={NEW_PASSWORD_MAX}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.password ? t(errors.password) : undefined}
        hint={strength ? t(`admin.signin.initial.strength.${strength}`) : undefined}
        end={<RevealButton shown={shown} onToggle={() => setShown((v) => !v)} />}
        required
      />
      <TextField
        label={t('admin.signin.initial.repeat')}
        type={shown ? 'text' : 'password'}
        name="repeat-password"
        autoComplete="new-password"
        spellCheck={false}
        dir="ltr"
        maxLength={NEW_PASSWORD_MAX}
        value={repeat}
        onChange={(e) => setRepeat(e.target.value)}
        error={errors.repeat ? t(errors.repeat) : undefined}
        required
      />
      <FormError message={errors.form ? t(errors.form) : null} />
      <Button type="submit" variant="primary" block loading={busy}>
        {t('admin.signin.initial.save')}
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

// ---------------------------------------------------------------- first security key (BR-03, SEC-ADM-2)

function EnrolStep({ flow, restartUrl, code: carried }: { flow: Flow; restartUrl: string; code?: string | undefined }) {
  const t = useT();
  // After the first-sign-in password change the same emailed code opens the enrolment (backend S26a): prefilled.
  const [code, setCode] = useState(carried ?? '');
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
      {carried ? <Banner tone="success" text={t('admin.signin.initial.changed')} /> : null}
      <p className="adm-auth-text">{t('admin.signin.enrol.why')}</p>
      <Banner tone="info" icon="doc" text={t(carried ? 'admin.signin.enrol.sameCode' : 'admin.signin.enrol.sent')} />
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

function KeyStep({
  flow,
  added,
  passwordChanged,
  restartUrl,
}: {
  flow: Flow;
  added: boolean;
  passwordChanged: boolean;
  restartUrl: string;
}) {
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
      {passwordChanged ? <Banner tone="success" text={t('admin.signin.initial.changed')} /> : null}
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

// ---------------------------------------------------------------- recovery codes, once (AC10b.T1)

function CodesStep({ flow, codes, then, added }: { flow: Flow; codes: readonly string[]; then: AuthNext; added: boolean }) {
  const t = useT();
  return (
    <div className="adm-auth-step">
      <StepTitle>{t('admin.signin.codes.title')}</StepTitle>
      <RecoveryCodes codes={codes} doneLabel={t('admin.signin.continue')} onDone={() => flow.next(then, added)} />
    </div>
  );
}

// ---------------------------------------------------------------- lost security key (AC10b.T3)

/** A recovery code as typed: XXXX-XXXX-XXXX-XXXX-XXXX (Crockford base32), upper case, spaces dropped. */
export function normalizeRecoveryCode(raw: string): string {
  return toLatinDigits(raw).replace(/\s+/g, '').toUpperCase();
}

const RECOVERY_CODE = /^[0-9A-Z-]{20,40}$/;

function RecoverStep({ flow, initialEmail }: { flow: Flow; initialEmail: string }) {
  const t = useT();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [forgotten, setForgotten] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ email?: MessageKey; password?: MessageKey; code?: MessageKey; form?: MessageKey }>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    const recoveryCode = normalizeRecoveryCode(code);
    const next: typeof errors = {};
    if (!EMAIL.test(address)) next.email = 'admin.signin.errors.emailMissing';
    if (!forgotten && !password) next.password = 'admin.signin.errors.passwordMissing';
    if (!RECOVERY_CODE.test(recoveryCode)) next.code = 'admin.signin.recover.errors.codeFormat';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      await flow.auth.call('auth.staff_recovery_start', {
        interaction_id: flow.interactionId,
        email: address,
        password_forgotten: forgotten,
        recovery_code: recoveryCode,
        ...(forgotten ? {} : { password }),
      });
      flow.go({ name: 'recoverCode' });
    } catch (err) {
      const outcome = flow.fail(err, 'admin.signin.recover.errors.details');
      if (outcome.kind === 'message') setErrors({ form: outcome.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="adm-auth-step" onSubmit={submit} noValidate data-testid="recover-start">
      <StepTitle>{t('admin.signin.recover.title')}</StepTitle>
      <p className="adm-auth-text">{t('admin.signin.recover.intro')}</p>
      <TextField
        label={t('admin.signin.email')}
        type="email"
        name="username"
        autoComplete="username"
        dir="ltr"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={errors.email ? t(errors.email) : undefined}
        required
      />
      <TextField
        label={t('admin.signin.password')}
        type="password"
        name="password"
        autoComplete="current-password"
        dir="ltr"
        value={forgotten ? '' : password}
        disabled={forgotten}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.password ? t(errors.password) : undefined}
        required={!forgotten}
      />
      <Check checked={forgotten} onChange={(e) => setForgotten(e.target.checked)}>
        {t('admin.signin.recover.forgotten')}
      </Check>
      <TextField
        label={t('admin.signin.recover.code')}
        hint={t('admin.signin.recover.codeHint')}
        name="recovery-code"
        autoComplete="off"
        spellCheck={false}
        dir="ltr"
        maxLength={40}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        error={errors.code ? t(errors.code) : undefined}
        required
      />
      <FormError message={errors.form ? t(errors.form) : null} />
      <Button type="submit" variant="primary" block loading={busy}>
        {t('admin.signin.recover.start')}
      </Button>
      <button type="button" className="adm-link adm-auth-aside" onClick={() => flow.go({ name: 'signin' })}>
        {t('admin.signin.forgot.back')}
      </button>
    </form>
  );
}

function RecoverCodeStep({ flow }: { flow: Flow }) {
  const t = useT();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const digits = toLatinDigits(code).replace(/\s/g, '');
    if (!/^\d{6}$/.test(digits)) return setError('admin.signin.errors.codeFormat');
    setBusy(true);
    try {
      const status = await flow.auth.call('auth.staff_recovery_verify', { interaction_id: flow.interactionId, code: digits });
      flow.go({ name: 'recoverWait', status });
    } catch (err) {
      const outcome = flow.fail(err, 'admin.signin.errors.codeWrong');
      if (outcome.kind === 'message') setError(outcome.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="adm-auth-step" onSubmit={submit} noValidate data-testid="recover-code">
      <StepTitle>{t('admin.signin.recover.codeTitle')}</StepTitle>
      <Banner tone="info" icon="doc" text={t('admin.signin.recover.sent')} />
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
      <Button type="submit" variant="primary" block loading={busy}>
        {t('admin.signin.recover.verify')}
      </Button>
      <button type="button" className="adm-link adm-auth-aside" onClick={() => flow.go({ name: 'recover', email: '' })}>
        {t('admin.signin.recover.again')}
      </button>
    </form>
  );
}

/** How often the waiting step asks for the request's state (auth.staff_recovery_status is RL public.read). */
export const RECOVERY_POLL_MS = 30_000;

const ENDED: readonly StaffRecoveryStatus['status'][] = ['rejected', 'expired', 'completed'];

function RecoverWaitStep({ flow, initial }: { flow: Flow; initial: StaffRecoveryStatus | null }) {
  const t = useT();
  const f = useFormat();
  const [status, setStatus] = useState<StaffRecoveryStatus | null>(initial);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [checking, setChecking] = useState(false);
  const { auth, fail } = flow;
  const failRef = useRef(fail);
  useEffect(() => {
    failRef.current = fail;
  });

  const check = useMemo(
    () => async () => {
      setChecking(true);
      try {
        setStatus(await auth.call('auth.staff_recovery_status', {}));
        setError(null);
      } catch (err) {
        const outcome = failRef.current(err);
        if (outcome.kind === 'message') {
          if (outcome.message === 'admin.signin.recover.errors.notFound') setGone(true);
          else setError(outcome.message);
        }
      } finally {
        setChecking(false);
      }
    },
    [auth],
  );

  const waiting = !gone && (status === null || status.status === 'awaiting_approvals');
  useEffect(() => {
    if (!waiting) return;
    // Opened on this step from a recovery on file: ask at once (from a timer, not during the effect), then poll.
    const first = status === null ? setTimeout(() => void check(), 0) : undefined;
    const timer = setInterval(() => void check(), RECOVERY_POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [waiting, status, check]);

  const back = (
    <button type="button" className="adm-link adm-auth-aside" onClick={() => flow.go({ name: 'signin' })}>
      {t('admin.signin.forgot.back')}
    </button>
  );

  if (gone || (status && ENDED.includes(status.status))) {
    const key = gone ? 'gone' : (status!.status as 'rejected' | 'expired' | 'completed');
    return (
      <div className="adm-auth-step" data-testid="recover-ended" data-state={key}>
        <StepTitle>{t('admin.signin.recover.title')}</StepTitle>
        <Banner tone={key === 'completed' ? 'success' : 'warn'} text={t(`admin.signin.recover.ended.${key}`)} />
        <Button block onClick={() => flow.go({ name: 'signin' })}>
          {t('admin.signin.forgot.back')}
        </Button>
      </div>
    );
  }

  if (status?.status === 'approved') {
    return (
      <div className="adm-auth-step" data-testid="recover-approved">
        <StepTitle>{t('admin.signin.recover.approvedTitle')}</StepTitle>
        <Banner tone="success" text={t('admin.signin.recover.approved')} />
        <Button
          variant="primary"
          icon="lock"
          block
          onClick={() => flow.go({ name: 'recoverKey', passwordForgotten: status.password_forgotten })}
        >
          {t('admin.signin.recover.continue')}
        </Button>
        {back}
      </div>
    );
  }

  return (
    <div className="adm-auth-step" data-testid="recover-wait" data-approvals={status?.approvals ?? ''}>
      <StepTitle>{t('admin.signin.recover.waitTitle')}</StepTitle>
      <p className="adm-auth-text">{t('admin.signin.recover.waitText')}</p>
      {status ? (
        <p className="adm-auth-text" role="status" aria-live="polite">
          {t('admin.signin.recover.approvals', { n: f.number(status.approvals) })}{' '}
          {t('admin.signin.recover.expires', { when: f.date(status.expires_at, 'dateTime') })}
        </p>
      ) : (
        <p className="adm-auth-text" role="status">
          {t('admin.signin.recover.checking')}
        </p>
      )}
      <Banner tone="info" text={t('admin.signin.recover.comeBack')} />
      <FormError message={error ? t(error) : null} />
      <Button block loading={checking} onClick={() => void check()}>
        {t('admin.signin.recover.refresh')}
      </Button>
      {back}
    </div>
  );
}

function RecoverKeyStep({ flow, passwordForgotten }: { flow: Flow; passwordForgotten: boolean }) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [passwordError, setPasswordError] = useState<MessageKey | null>(null);
  const canKey = useBrowserValue(passkeysSupported, true);
  // Options for a checked password are kept, so a cancelled browser prompt can try again.
  const options = useRef<{ password: string | null; value: PublicKeyCredentialCreationOptionsJSON } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setPasswordError(null);
    if (passwordForgotten) {
      if (password.length < NEW_PASSWORD_MIN || password.length > NEW_PASSWORD_MAX)
        return setPasswordError('admin.signin.recover.errors.passwordLength');
      if (password !== repeat) return setPasswordError('admin.signin.recover.errors.passwordRepeat');
    }
    if (!canKey) return setError('admin.signin.errors.unsupported');
    const newPassword = passwordForgotten ? password : null;
    setBusy(true);
    try {
      if (!options.current || options.current.password !== newPassword)
        options.current = { password: newPassword, value: await recoveryKeyOptions(flow.auth, flow.interactionId, newPassword) };
      flow.next(await completeRecovery(flow.auth, flow.interactionId, options.current.value), true);
    } catch (err) {
      if (passkeyCancelled(err)) return;
      if (passkeyAlreadyRegistered(err)) return setError('admin.signin.errors.alreadyRegistered');
      options.current = null;
      const outcome = flow.fail(err, 'admin.signin.recover.errors.password');
      if (outcome.kind === 'message') {
        if (outcome.message === 'admin.signin.recover.errors.password') setPasswordError(outcome.message);
        else setError(outcome.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="adm-auth-step" onSubmit={submit} noValidate data-testid="recover-key">
      <StepTitle>{t('admin.signin.recover.keyTitle')}</StepTitle>
      <p className="adm-auth-text">{t('admin.signin.recover.keyText')}</p>
      {passwordForgotten ? (
        <>
          <TextField
            label={t('admin.signin.recover.newPassword')}
            hint={t('admin.signin.recover.newPasswordHint', { n: NEW_PASSWORD_MIN })}
            type="password"
            name="new-password"
            autoComplete="new-password"
            dir="ltr"
            maxLength={NEW_PASSWORD_MAX}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={passwordError ? t(passwordError) : undefined}
            required
          />
          <TextField
            label={t('admin.signin.recover.repeatPassword')}
            type="password"
            name="repeat-password"
            autoComplete="new-password"
            dir="ltr"
            maxLength={NEW_PASSWORD_MAX}
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            required
          />
        </>
      ) : null}
      <FormError message={error ? t(error) : null} />
      <Button type="submit" variant="primary" icon="lock" block loading={busy}>
        {t('admin.signin.enrol.create')}
      </Button>
    </form>
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

function Expired({ restartUrl, note }: { restartUrl: string; note?: MessageKey | undefined }) {
  const t = useT();
  return (
    <div className="adm-auth-step" data-step="expired">
      <StepTitle>{t('admin.signin.expired.title')}</StepTitle>
      <p className="adm-auth-text">{t('admin.signin.expired.text')}</p>
      {note ? <Banner tone="info" text={t(note)} /> : null}
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
