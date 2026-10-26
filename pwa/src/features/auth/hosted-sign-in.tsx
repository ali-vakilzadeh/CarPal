'use client';
// W-AUTH-01 Sign In / Sign Up — the hosted sign-in (GD-05, P4.T1-T5; mirrors S-AUTH-02, 03, 07, 08, 09). One page
// under /id/signin?interaction_id=… whose steps are client state: identify (mobile number or email; a code by default,
// or the password for an email) → code or password → second factor when the account has one → complete. Account
// creation, verification by code, passkeys, "Forgot password" and the timed lock are steps of the same page, so the
// interaction (cookie-bound on the auth host) and the typed values survive between them. Every call goes to
// /id/v1/auth/* through the typed client (same origin, Origin and Sec-Fetch-Site sent by the browser); ATT operations
// solve the proof of work when the auth host asks. On "complete" the browser re-requests the authorize URL that
// started the interaction (resumeUrl, BA-12) and the BFF finishes the sign-in. An unknown or expired interaction
// (410) shows "This sign-in page expired" with a restart that keeps the return URL.
import type { AuthNext } from '@carpal/api-contracts';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { Chip } from '@/components/ds/chip';
import { Icon } from '@/components/ds/icon';
import { TextField } from '@/components/ds/text-field';
import { Dialog } from '@/components/shell/dialog';
import { StateView } from '@/components/shell/states';
import type { ApiClient } from '@/lib/api/client';
import { useApiClient } from '@/lib/api/query';
import { useRegion } from '@/lib/config/client';
import { goTo } from '@/lib/browser-nav';
import { isolate } from '@/lib/format/bidi';
import { useBrowserValue } from '@/lib/browser-value';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { CodeInput, PasswordField } from './fields';
import { isEmail, maskDestination, normalizePhone, parseIdentifier, smsAllowed } from './identifier';
import { passkeyCancelled, passkeysSupported, verifyWithPasskey } from './passkey';
import { passwordError } from './password';
import { authOutcome, type AuthOutcome } from './problems';
import {
  clearSignupDraft,
  lastMethod,
  loadSignupDraft,
  rememberMethod,
  saveSignupChoices,
  saveSignupDraft,
  setKeepSignedIn,
  type SigninMethod,
} from './storage';

export interface HostedSignInProps {
  /** From the query; null when the page was opened without one. */
  interactionId: string | null;
  /** The authorize URL to re-request on completion (from the /id proxy's resume cookie); null = unknown interaction. */
  resumeUrl: string | null;
  /** "Start again" after the interaction expired. */
  restartUrl: string;
  /** The screen /bff/login asked for (screen=signup). */
  screen: 'signin' | 'signup';
  /** The gated action's label ("Sign in to follow Reza Auto Suspension"), plain text. */
  context: string | null;
  termsVersion: string;
  privacyVersion: string;
}

/** Where a one-time code goes and what it proves. */
interface CodeTarget {
  purpose: 'signin' | 'verify';
  channel: 'email' | 'sms';
  destination: string;
  /** The account's email and phone typed in this flow (for "get the code by email/text instead"). */
  email?: string;
  phone?: string;
  /** "Change" goes back here. */
  from: 'signin' | 'signup';
}

type Step =
  | { name: 'signin' }
  | { name: 'signup' }
  | { name: 'code'; target: CodeTarget; sentAt: number; resends: number }
  | { name: 'mfa'; methods: ('totp_mfa' | 'webauthn')[] }
  | { name: 'forgot'; email: string }
  | { name: 'forgotSent' }
  | { name: 'locked'; until: number }
  | { name: 'expired' }
  | { name: 'finishing' };

/** What every step can do. */
interface Flow {
  api: ApiClient;
  interactionId: string;
  countryCodes: readonly string[];
  go: (step: Step) => void;
  /** Acts on an AuthNext (complete → back to the authorize URL; mfa; verify → sends the code). */
  next: (n: AuthNext, who: { email?: string; phone?: string; from: 'signin' | 'signup' }) => Promise<void>;
  /** Sends a one-time code and opens the code step; false when it failed (the outcome is then shown). */
  sendCode: (target: CodeTarget, resends?: number) => Promise<AuthOutcome | null>;
  /** Expired and locked outcomes move to their steps; the outcome is returned for the form to show the rest. */
  fail: (err: unknown, credentials?: MessageKey) => AuthOutcome;
}

/** The time of an event (a code sent, a lock started); only ever called from event handlers, never while rendering. */
const eventTime = (): number => Date.now();

/** Seconds a code must wait before another can be sent (SEC-AU-8: resend after 60 s). */
export const RESEND_AFTER_S = 60;

export function HostedSignIn(props: HostedSignInProps) {
  const api = useApiClient();
  const region = useRegion();
  // The typed identifier outlives the steps (back from a code, a lock or a reset keeps it).
  const [identifier, setIdentifier] = useState('');
  const [step, setStep] = useState<Step>(() =>
    props.interactionId && props.resumeUrl ? { name: props.screen === 'signup' ? 'signup' : 'signin' } : { name: 'expired' },
  );

  if (!props.interactionId || !props.resumeUrl || step.name === 'expired') return <Expired restartUrl={props.restartUrl} />;
  const interactionId = props.interactionId;
  const resumeUrl = props.resumeUrl;

  const finish = () => {
    setStep({ name: 'finishing' });
    goTo(resumeUrl);
  };

  const flow: Flow = {
    api,
    interactionId,
    countryCodes: region.sms_country_codes,
    go: setStep,
    fail(err, credentials) {
      const outcome = authOutcome(err, credentials);
      if (outcome.kind === 'expired') setStep({ name: 'expired' });
      else if (outcome.kind === 'locked') setStep({ name: 'locked', until: eventTime() + outcome.retryAfterMs });
      return outcome;
    },
    async sendCode(target, resends = 0) {
      try {
        await api.api('auth.otp_start', {
          body: { interaction_id: interactionId, channel: target.channel, destination: target.destination, purpose: target.purpose },
        });
        setStep({ name: 'code', target, sentAt: eventTime(), resends });
        return null;
      } catch (err) {
        return flow.fail(err);
      }
    },
    async next(n, who) {
      if (n.next === 'complete' || n.next === 'consent') return finish();
      if (n.next === 'mfa') return setStep({ name: 'mfa', methods: n.mfa_methods?.length ? n.mfa_methods : ['totp_mfa'] });
      const channel = n.next === 'verify_phone' && who.phone ? 'sms' : 'email';
      const destination = channel === 'sms' ? who.phone : who.email;
      if (!destination) return setStep(formStep(who.from));
      await flow.sendCode({ purpose: 'verify', channel, destination, from: who.from, ...pick(who) });
    },
  };

  return (
    <div className="flex flex-col gap-5">
      {props.context && (step.name === 'signin' || step.name === 'signup') ? <Banner tone="info" icon="lock" text={props.context} /> : null}
      {step.name === 'signin' ? <SigninStep flow={flow} identifier={identifier} onIdentifier={setIdentifier} /> : null}
      {step.name === 'signup' ? <SignupStep flow={flow} termsVersion={props.termsVersion} privacyVersion={props.privacyVersion} /> : null}
      {step.name === 'code' ? <CodeStep key={`${step.target.destination}-${step.sentAt}`} flow={flow} step={step} /> : null}
      {step.name === 'mfa' ? <MfaStep flow={flow} methods={step.methods} /> : null}
      {step.name === 'forgot' ? <ForgotStep flow={flow} initialEmail={step.email} /> : null}
      {step.name === 'forgotSent' ? <ForgotSent flow={flow} /> : null}
      {step.name === 'locked' ? <Locked flow={flow} until={step.until} /> : null}
      {step.name === 'finishing' ? <Finishing /> : null}
    </div>
  );
}

/** The form a code or second factor came from. */
const formStep = (from: 'signin' | 'signup'): Step => (from === 'signup' ? { name: 'signup' } : { name: 'signin' });

const pick = (who: { email?: string; phone?: string }) => ({
  ...(who.email ? { email: who.email } : {}),
  ...(who.phone ? { phone: who.phone } : {}),
});

/** The step's heading takes focus when the step opens, so screen readers hear where they are. */
function StepTitle({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (document.activeElement === document.body || document.activeElement === null) return;
    ref.current?.focus();
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1} className="pwa-auth-title">
      {children}
    </h1>
  );
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="cp-field-hint pwa-error-text" role="alert">
      <Icon name="alert" size={16} />
      {message}
    </p>
  );
}

// ---------------------------------------------------------------- sign in (S-AUTH-02)

function SigninStep({
  flow,
  identifier,
  onIdentifier: setIdentifier,
}: {
  flow: Flow;
  identifier: string;
  onIdentifier: (v: string) => void;
}) {
  const t = useT();
  const [method, setMethod] = useState<SigninMethod>(() => lastMethod() ?? 'code');
  const [password, setPassword] = useState('');
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<MessageKey | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const canPasskey = useBrowserValue(passkeysSupported, false);

  const parsed = parseIdentifier(identifier, flow.countryCodes);
  const phone = parsed.kind === 'phone';
  // Passwords belong to the email address (auth.signin_password takes an email); phones sign in with a code.
  const effective: SigninMethod = phone ? 'code' : method;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldError(null);
    if (parsed.kind === 'empty' || parsed.kind === 'invalid') return setFieldError('auth.signin.identifierInvalid');
    if (parsed.kind === 'phone' && !parsed.smsAllowed) return setFieldError('auth.errors.smsCountry');
    if (effective === 'password' && !password) return setError('auth.signin.passwordMissing');
    setBusy(true);
    setKeepSignedIn(keep);
    rememberMethod(effective);
    try {
      if (effective === 'code') {
        const outcome = await flow.sendCode({
          purpose: 'signin',
          channel: parsed.kind === 'email' ? 'email' : 'sms',
          destination: parsed.value,
          from: 'signin',
        });
        if (outcome?.kind === 'fields') setFieldError(outcome.message);
        else if (outcome?.kind === 'message') setError(outcome.message);
        return;
      }
      const email = parsed.kind === 'email' ? parsed.value : '';
      const n = await flow.api.api('auth.signin_password', { body: { interaction_id: flow.interactionId, email, password } });
      await flow.next(n, { email, from: 'signin' });
    } catch (err) {
      const outcome = flow.fail(err, 'auth.signin.invalid');
      if (outcome.kind === 'message' || outcome.kind === 'fields') setError(outcome.message);
    } finally {
      setBusy(false);
    }
  };

  const passkey = async () => {
    setError(null);
    setPasskeyBusy(true);
    setKeepSignedIn(keep);
    try {
      const n = await verifyWithPasskey(flow.api, flow.interactionId, 'signin');
      await flow.next(n, { from: 'signin' });
    } catch (err) {
      if (passkeyCancelled(err)) return;
      const outcome = flow.fail(err, 'auth.signin.passkeyFailed');
      if (outcome.kind === 'message' || outcome.kind === 'fields')
        setError(outcome.message === 'auth.errors.generic' ? 'auth.signin.passkeyFailed' : outcome.message);
    } finally {
      setPasskeyBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
      <StepTitle>{t('auth.signin.welcome')}</StepTitle>
      <TextField
        label={t('auth.signin.identifier')}
        value={identifier}
        onChange={(e) => setIdentifier(e.target.value)}
        autoComplete="username"
        inputMode={phone || /^[\d۰-۹٠-٩+\s()-]+$/.test(identifier) ? 'tel' : 'email'}
        name="username"
        error={fieldError ? t(fieldError) : undefined}
        hint={t('auth.signin.identifierHint')}
        required
      />
      <div className="flex flex-col gap-2">
        <span className="cp-field-label" id="signin-method">
          {t('auth.signin.method')}
        </span>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="signin-method">
          <Chip selected={effective === 'code'} onClick={() => setMethod('code')}>
            {t('auth.signin.methodCode')}
          </Chip>
          <Chip selected={effective === 'password'} disabled={phone} onClick={() => setMethod('password')}>
            {t('auth.signin.methodPassword')}
          </Chip>
        </div>
        {phone ? <p className="pwa-text-caption">{t('auth.signin.passwordNeedsEmail')}</p> : null}
      </div>
      {effective === 'password' ? (
        <PasswordField
          label={t('auth.signin.password')}
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          name="password"
        />
      ) : null}
      <Check checked={keep} onChange={(e) => setKeep(e.target.checked)} hint={t('auth.signin.keepHint')}>
        {t('auth.signin.keep')}
      </Check>
      <FormError message={error ? t(error) : null} />
      <Button type="submit" variant="primary" block loading={busy}>
        {t('auth.signin.continue')}
      </Button>
      {canPasskey ? (
        <Button icon="lock" block loading={passkeyBusy} onClick={() => void passkey()}>
          {t('auth.signin.passkey')}
        </Button>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          className="pwa-link"
          onClick={() => flow.go({ name: 'forgot', email: parsed.kind === 'email' ? parsed.value : '' })}
        >
          {t('auth.signin.forgot')}
        </button>
        <p className="pwa-text-body">
          {t('auth.signin.newHere')}{' '}
          <button type="button" className="pwa-link" onClick={() => flow.go({ name: 'signup' })}>
            {t('auth.signin.signUp')}
          </button>
        </p>
      </div>
      <p className="pwa-text-caption">{t('auth.signin.legal')}</p>
    </form>
  );
}

// ---------------------------------------------------------------- sign up (S-AUTH-03)

function SignupStep({ flow, termsVersion, privacyVersion }: { flow: Flow; termsVersion: string; privacyVersion: string }) {
  const t = useT();
  const locale = useLocale();
  const [draft] = useState(loadSignupDraft);
  const [fullName, setFullName] = useState(draft.fullName ?? '');
  const [email, setEmail] = useState(draft.email ?? '');
  const [phone, setPhone] = useState(draft.phone ?? '');
  const [password, setPassword] = useState('');
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [ai, setAi] = useState(false);
  const [legal, setLegal] = useState<'terms' | 'privacy' | null>(null);
  const [errors, setErrors] = useState<Record<string, MessageKey>>({});
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => saveSignupDraft({ fullName, email, phone }), [fullName, email, phone]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const found: Record<string, MessageKey> = {};
    const name = fullName.trim();
    if (name.length < 2 || name.length > 100) found['/full_name'] = 'auth.errors.fullName';
    if (!isEmail(email)) found['/email'] = 'auth.errors.email';
    const e164 = phone.trim() ? normalizePhone(phone, flow.countryCodes) : null;
    if (phone.trim() && !e164) found['/phone'] = 'auth.errors.phone';
    else if (e164 && !smsAllowed(e164, flow.countryCodes)) found['/phone'] = 'auth.errors.smsCountry';
    const pw = passwordError(password, false);
    if (pw) found['/password'] = pw;
    if (!terms) found['/terms'] = 'auth.signup.termsRequired';
    if (!privacy) found['/privacy'] = 'auth.signup.privacyRequired';
    setErrors(found);
    if (Object.keys(found).length) return setError('auth.errors.check');

    setBusy(true);
    setKeepSignedIn(true);
    saveSignupChoices({ marketing, aiPersonalization: ai, policyVersion: privacyVersion });
    try {
      const n = await flow.api.api('auth.signup', {
        body: {
          interaction_id: flow.interactionId,
          full_name: name,
          email: email.trim(),
          ...(password ? { password } : {}),
          ...(e164 ? { phone: e164 } : {}),
          locale,
          terms_version: termsVersion,
          privacy_policy_version: privacyVersion,
        },
      });
      clearSignupDraft();
      await flow.next(n, { email: email.trim(), ...(e164 ? { phone: e164 } : {}), from: 'signup' });
    } catch (err) {
      const outcome = flow.fail(err);
      if (outcome.kind === 'fields') setErrors(outcome.fields);
      if (outcome.kind === 'fields' || outcome.kind === 'message') setError(outcome.message);
    } finally {
      setBusy(false);
    }
  };

  const err = (pointer: string) => (errors[pointer] ? t(errors[pointer]) : undefined);
  return (
    <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
      <StepTitle>{t('auth.signup.title')}</StepTitle>
      <TextField
        label={t('auth.signup.fullName')}
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        autoComplete="name"
        maxLength={100}
        hint={t('auth.signup.fullNameHint')}
        error={err('/full_name')}
        required
      />
      <TextField
        label={t('auth.signup.email')}
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="email"
        dir="ltr"
        error={err('/email')}
        required
      />
      <TextField
        label={t('auth.signup.phone')}
        type="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        autoComplete="tel"
        inputMode="tel"
        dir="ltr"
        hint={t('auth.signup.phoneHint')}
        error={err('/phone')}
      />
      <PasswordField
        label={t('auth.signup.password')}
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        hint={t('auth.signup.passwordHint')}
        error={err('/password')}
        strength={{ contacts: [email, phone] }}
      />
      <fieldset className="pwa-fieldset">
        <legend className="pwa-text-caption">{t('auth.signup.required')}</legend>
        <Check
          checked={terms}
          onChange={(e) => setTerms(e.target.checked)}
          aria-invalid={errors['/terms'] ? true : undefined}
          hint={err('/terms')}
          end={
            <Button size="sm" variant="ghost" onClick={() => setLegal('terms')}>
              {t('auth.signup.read')}
            </Button>
          }
        >
          {t('auth.signup.terms')}
        </Check>
        <Check
          checked={privacy}
          onChange={(e) => setPrivacy(e.target.checked)}
          aria-invalid={errors['/privacy'] ? true : undefined}
          hint={err('/privacy')}
          end={
            <Button size="sm" variant="ghost" onClick={() => setLegal('privacy')}>
              {t('auth.signup.read')}
            </Button>
          }
        >
          {t('auth.signup.privacy')}
        </Check>
      </fieldset>
      <fieldset className="pwa-fieldset">
        <legend className="pwa-text-caption">{t('auth.signup.optional')}</legend>
        <Check checked={marketing} onChange={(e) => setMarketing(e.target.checked)}>
          {t('auth.signup.marketing')}
        </Check>
        <Check checked={ai} onChange={(e) => setAi(e.target.checked)} hint={t('auth.signup.aiHint')}>
          {t('auth.signup.ai')}
        </Check>
      </fieldset>
      <FormError message={error ? t(error) : null} />
      <Button type="submit" variant="primary" block loading={busy}>
        {t('auth.signup.create')}
      </Button>
      <p className="pwa-text-body">
        {t('auth.signup.haveAccount')}{' '}
        <button type="button" className="pwa-link" onClick={() => flow.go({ name: 'signin' })}>
          {t('auth.signup.logIn')}
        </button>
      </p>
      <Dialog
        name="legal"
        open={legal !== null}
        onClose={() => setLegal(null)}
        title={legal === 'privacy' ? t('auth.signup.privacyTitle') : t('auth.signup.termsTitle')}
      >
        <p className="pwa-text-body">{t('auth.signup.legalPending', { version: legal === 'privacy' ? privacyVersion : termsVersion })}</p>
      </Dialog>
    </form>
  );
}

// ---------------------------------------------------------------- one-time code (S-AUTH-07)

function useCountdown(untilMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (untilMs <= now) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [untilMs, now]);
  return Math.max(0, Math.ceil((untilMs - now) / 1000));
}

function clock(seconds: number, digits: (v: string) => string): string {
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return digits(`${m}:${s}`);
}

function CodeStep({ flow, step }: { flow: Flow; step: Extract<Step, { name: 'code' }> }) {
  const t = useT();
  const f = useFormat();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [notice, setNotice] = useState<MessageKey | null>(step.resends > 0 ? 'auth.code.resent' : null);
  const wait = useCountdown(step.sentAt + RESEND_AFTER_S * 1000);
  const { target } = step;
  const masked = maskDestination(target.destination, flow.countryCodes);

  const verify = async (value: string) => {
    if (busy || value.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const n = await flow.api.api('auth.otp_verify', { body: { interaction_id: flow.interactionId, code: value } });
      await flow.next(n, { ...pick(target), from: target.from });
    } catch (err) {
      const outcome = flow.fail(err, 'auth.code.wrong');
      if (outcome.kind === 'message' || outcome.kind === 'fields') {
        setError(outcome.message);
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  };

  const resend = async (next: CodeTarget = target) => {
    setNotice(null);
    setError(null);
    const outcome = await flow.sendCode(next, step.resends + 1);
    if (outcome?.kind === 'message' || outcome?.kind === 'fields') setError(outcome.message);
  };

  // Docs/21 S-AUTH-07: after 3 resends by text, offer the email address (and the reverse for a new account).
  const other: CodeTarget | null =
    target.channel === 'sms' && target.email && step.resends >= 3
      ? { ...target, channel: 'email', destination: target.email }
      : target.channel === 'email' && target.purpose === 'verify' && target.phone && smsAllowed(target.phone, flow.countryCodes)
        ? { ...target, channel: 'sms', destination: target.phone }
        : null;

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void verify(code);
      }}
      noValidate
    >
      <StepTitle>
        {target.purpose === 'signin'
          ? t('auth.code.titleSignin')
          : target.channel === 'sms'
            ? t('auth.code.titleVerifyPhone')
            : t('auth.code.titleVerify')}
      </StepTitle>
      <p className="pwa-text-body">
        {t(target.purpose === 'signin' ? 'auth.code.sentIfAccount' : 'auth.code.sent', { destination: isolate(masked, true) })}{' '}
        <button type="button" className="pwa-link" onClick={() => flow.go(formStep(target.from))}>
          {t('auth.code.change')}
        </button>
      </p>
      {notice ? <Banner tone="success" text={t(notice)} /> : null}
      <CodeInput
        value={code}
        onChange={setCode}
        onComplete={(c) => void verify(c)}
        error={error ? t(error) : null}
        disabled={busy}
        label={t('auth.code.label')}
        autoFocus
      />
      <Button type="submit" variant="primary" block loading={busy} disabled={code.length !== 6}>
        {t('auth.code.verify')}
      </Button>
      <div className="flex flex-col items-center gap-2">
        <Button variant="ghost" disabled={wait > 0} onClick={() => void resend()}>
          {wait > 0 ? t('auth.code.resendIn', { time: clock(wait, f.digits) }) : t('auth.code.resend')}
        </Button>
        {other ? (
          <button type="button" className="pwa-link" onClick={() => void resend(other)}>
            {other.channel === 'email' ? t('auth.code.byEmail') : t('auth.code.bySms')}
          </button>
        ) : null}
        <p className="pwa-text-caption text-center">
          {target.purpose === 'signin' ? t('auth.code.noCode') : target.channel === 'email' ? t('auth.code.linkAlso') : null}
        </p>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- second factor (S-AUTH-07 MFA mode, P4.T4)

function MfaStep({ flow, methods }: { flow: Flow; methods: ('totp_mfa' | 'webauthn')[] }) {
  const t = useT();
  const hasTotp = methods.includes('totp_mfa');
  const hasPasskey = methods.includes('webauthn');
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const canPasskey = useBrowserValue(passkeysSupported, false);

  const send = async (body: { method: 'totp_mfa'; code: string } | { method: 'recovery_code'; recovery_code: string }) => {
    setBusy(true);
    setError(null);
    try {
      const n = await flow.api.api('auth.mfa_verify', { body: { interaction_id: flow.interactionId, ...body } });
      await flow.next(n, { from: 'signin' });
    } catch (err) {
      const outcome = flow.fail(err, 'auth.mfa.wrong');
      if (outcome.kind === 'message' || outcome.kind === 'fields') {
        setError(outcome.message);
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  };

  const passkey = async () => {
    setBusy(true);
    setError(null);
    try {
      const n = await verifyWithPasskey(flow.api, flow.interactionId, 'mfa');
      await flow.next(n, { from: 'signin' });
    } catch (err) {
      if (!passkeyCancelled(err)) {
        const outcome = flow.fail(err, 'auth.mfa.wrong');
        if (outcome.kind === 'message' || outcome.kind === 'fields') setError(outcome.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (mode === 'recovery') void send({ method: 'recovery_code', recovery_code: recovery.trim() });
        else if (code.length === 6) void send({ method: 'totp_mfa', code });
      }}
      noValidate
    >
      <StepTitle>{t('auth.mfa.title')}</StepTitle>
      {hasTotp && mode === 'totp' ? (
        <>
          <p className="pwa-text-body">{t('auth.mfa.text')}</p>
          <CodeInput
            value={code}
            onChange={setCode}
            onComplete={(c) => void send({ method: 'totp_mfa', code: c })}
            error={error ? t(error) : null}
            disabled={busy}
            label={t('auth.code.label')}
            autoFocus
          />
        </>
      ) : null}
      {mode === 'recovery' || !hasTotp ? (
        <TextField
          label={t('auth.mfa.recovery')}
          value={recovery}
          onChange={(e) => setRecovery(e.target.value)}
          autoComplete="one-time-code"
          dir="ltr"
          maxLength={20}
          hint={t('auth.mfa.recoveryHint')}
          error={error ? t(error) : undefined}
        />
      ) : null}
      <Button type="submit" variant="primary" block loading={busy}>
        {t('auth.code.verify')}
      </Button>
      {hasPasskey && canPasskey ? (
        <Button icon="lock" block disabled={busy} onClick={() => void passkey()}>
          {t('auth.mfa.passkey')}
        </Button>
      ) : null}
      {hasTotp ? (
        <button
          type="button"
          className="pwa-link self-start"
          onClick={() => {
            setError(null);
            setMode(mode === 'totp' ? 'recovery' : 'totp');
          }}
        >
          {mode === 'totp' ? t('auth.mfa.useRecovery') : t('auth.mfa.useCode')}
        </button>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------- forgot password (S-AUTH-08, P4.T5)

function ForgotStep({ flow, initialEmail }: { flow: Flow; initialEmail: string }) {
  const t = useT();
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isEmail(email)) return setError('auth.errors.email');
    setBusy(true);
    setError(null);
    try {
      await flow.api.api('auth.password_reset_start', { body: { email: email.trim() } });
      flow.go({ name: 'forgotSent' });
    } catch (err) {
      const outcome = flow.fail(err);
      if (outcome.kind === 'message' || outcome.kind === 'fields') setError(outcome.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
      <StepTitle>{t('auth.forgot.title')}</StepTitle>
      <p className="pwa-text-body">{t('auth.forgot.text')}</p>
      <TextField
        label={t('auth.forgot.email')}
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="email"
        dir="ltr"
        error={error ? t(error) : undefined}
      />
      <Button type="submit" variant="primary" block loading={busy}>
        {t('auth.forgot.send')}
      </Button>
      <button type="button" className="pwa-link self-start" onClick={() => flow.go({ name: 'signin' })}>
        {t('auth.forgot.back')}
      </button>
    </form>
  );
}

function ForgotSent({ flow }: { flow: Flow }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-5">
      <StepTitle>{t('auth.forgot.title')}</StepTitle>
      <Banner tone="plain" text={t('auth.forgot.sent')} />
      <Button block onClick={() => flow.go({ name: 'signin' })}>
        {t('auth.forgot.back')}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- locked, expired, finishing (S-AUTH-09)

function Locked({ flow, until }: { flow: Flow; until: number }) {
  const t = useT();
  const f = useFormat();
  const left = useCountdown(until);
  return (
    <div className="flex flex-col gap-5">
      <StateView
        kind="rateLimited"
        t={t}
        title={t('auth.locked.title')}
        text={left > 0 ? t('auth.locked.text') : t('auth.locked.ready')}
        action={
          left > 0 ? (
            <p className="pwa-countdown" aria-live="polite">
              {clock(left, f.digits)}
            </p>
          ) : undefined
        }
      />
      <Button variant={left > 0 ? 'secondary' : 'primary'} block onClick={() => flow.go({ name: 'signin' })}>
        {t('auth.locked.back')}
      </Button>
      <Button variant="ghost" block onClick={() => flow.go({ name: 'forgot', email: '' })}>
        {t('auth.locked.reset')}
      </Button>
    </div>
  );
}

function Expired({ restartUrl }: { restartUrl: string }) {
  const t = useT();
  return (
    <StateView
      kind="removed"
      t={t}
      title={t('auth.expired.title')}
      text={t('auth.expired.text')}
      action={
        <a href={restartUrl} className={buttonClass({ variant: 'primary' })}>
          <span className="cp-btn-label">{t('auth.expired.restart')}</span>
        </a>
      }
    />
  );
}

function Finishing() {
  const t = useT();
  return (
    <div className="pwa-state" role="status" aria-live="polite">
      <span className="pwa-state-mark" aria-hidden="true">
        <Icon name="check" size={40} />
      </span>
      <p className="pwa-state-title">{t('auth.finishing')}</p>
    </div>
  );
}
