// AC4.T1/T2 DOM tests of the staff sign-in steps against a fake auth client (the browser's WebAuthn API is mocked;
// the real ceremony runs in tests/e2e/signin.spec.ts with Chrome's virtual authenticator).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FormatProvider } from '@/lib/format/client';
import { I18nProvider } from '@/lib/i18n/client';
import { BUNDLED, pickNamespaces } from '@/lib/i18n/dictionary';
import type { Locale } from '@/lib/i18n/locales';
import { ApiProblem } from '@/lib/api/problem';
import type { AuthClient, AuthOperationId } from './auth-client';
import { StaffSignIn } from './staff-sign-in';

const goTo = vi.fn();
vi.mock('@/lib/browser', async (importOriginal) => ({ ...(await importOriginal<object>()), goTo: (url: string) => goTo(url) }));

const webauthn = vi.hoisted(() => ({
  startAuthentication: vi.fn(async () => ({ id: 'cred', type: 'public-key' })),
  startRegistration: vi.fn(async () => ({ id: 'new-cred', type: 'public-key' })),
}));
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startAuthentication: webauthn.startAuthentication,
  startRegistration: webauthn.startRegistration,
}));

type Answer = unknown | ((body: Record<string, unknown>) => unknown);

function fakeAuth(answers: Partial<Record<AuthOperationId, Answer[]>>) {
  const calls: { op: AuthOperationId; body: Record<string, unknown> }[] = [];
  const auth: AuthClient = {
    call: (async (op: AuthOperationId, body: Record<string, unknown>) => {
      calls.push({ op, body });
      const next = answers[op]?.shift();
      if (next === undefined) throw new Error(`unexpected ${op}`);
      const value = typeof next === 'function' ? (next as (b: Record<string, unknown>) => unknown)(body) : next;
      if (value instanceof Error) throw value;
      return value;
    }) as AuthClient['call'],
  };
  return { auth, calls };
}

function wrap(children: ReactNode, locale: Locale = 'en') {
  return (
    <I18nProvider locale={locale} resources={pickNamespaces(BUNDLED[locale])}>
      <FormatProvider timeZone="Asia/Tehran" distanceUnit="km">
        {children}
      </FormatProvider>
    </I18nProvider>
  );
}

const PROPS = { interactionId: 'ia-1', resumeUrl: '/id/oauth/authorize?state=s', restartUrl: '/bff/login/restart?state=s', stepUp: false };

async function typePassword(email = 'adm1@staff.carpals.test', password = 'carpal-staff-dev-password') {
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

beforeEach(() => {
  goTo.mockReset();
  webauthn.startAuthentication.mockClear();
  webauthn.startRegistration.mockClear();
});

describe('staff sign-in (A-AUTH-01)', () => {
  it('password, then the security key, then back to the authorize request', async () => {
    const { auth, calls } = fakeAuth({
      'auth.signin_password': [{ next: 'mfa', mfa_methods: ['webauthn'] }],
      'auth.webauthn_options': [{ challenge: 'c' }],
      'auth.mfa_verify': [{ next: 'complete' }],
    });
    render(wrap(<StaffSignIn {...PROPS} auth={auth} />));
    expect(screen.getByRole('heading', { level: 1, name: 'Staff sign-in' })).toBeInTheDocument();
    await typePassword();
    fireEvent.click(await screen.findByRole('button', { name: 'Use security key' }));
    await screen.findByText('Signing you in…');
    expect(goTo).toHaveBeenCalledWith('/id/oauth/authorize?state=s');
    expect(calls.map((c) => c.op)).toEqual(['auth.signin_password', 'auth.webauthn_options', 'auth.mfa_verify']);
    expect(calls[1]!.body).toEqual({ interaction_id: 'ia-1', purpose: 'mfa' });
    expect(calls[2]!.body).toMatchObject({ interaction_id: 'ia-1', method: 'webauthn', assertion: { id: 'cred' } });
  });

  it('enrols the first security key with the emailed code, then signs in with it (BR-03)', async () => {
    const { auth, calls } = fakeAuth({
      'auth.signin_password': [{ next: 'enrol_passkey' }],
      'auth.passkey_enrol_options': [new ApiProblem(422, { code: 'CODE_INVALID' }), { challenge: 'reg', rp: { id: 'localhost' } }],
      'auth.passkey_enrol': [{ next: 'mfa', mfa_methods: ['webauthn'] }],
      'auth.webauthn_options': [{ challenge: 'c' }],
      'auth.mfa_verify': [{ next: 'complete' }],
    });
    render(wrap(<StaffSignIn {...PROPS} auth={auth} />));
    await typePassword();
    expect(await screen.findByRole('heading', { name: 'Set up your security key' })).toBeInTheDocument();
    expect(screen.getByText(/Passkeys that sync to a phone or a cloud account are not accepted/)).toBeInTheDocument();

    const code = screen.getByLabelText('Code from the email');
    fireEvent.change(code, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create security key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the 6-digit code from the email.');

    fireEvent.change(code, { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create security key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The code is not correct.');

    // Persian digits are accepted and sent as Latin digits.
    fireEvent.change(code, { target: { value: '۱۲۳۴۵۶' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create security key' }));
    expect(await screen.findByText('Security key added. Now confirm with it once to finish signing in.')).toBeInTheDocument();
    expect(calls.find((c) => c.op === 'auth.passkey_enrol_options' && c.body.code === '123456')).toBeTruthy();
    expect(webauthn.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'reg', rp: { id: 'localhost' } } });

    fireEvent.click(screen.getByRole('button', { name: 'Use security key' }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/id/oauth/authorize?state=s'));
  });

  it('explains a synced passkey and lets a cancelled prompt try again without a new code', async () => {
    const { auth, calls } = fakeAuth({
      'auth.signin_password': [{ next: 'enrol_passkey' }],
      'auth.passkey_enrol_options': [{ challenge: 'reg' }],
      'auth.passkey_enrol': [new ApiProblem(422, { code: 'PASSKEY_NOT_DEVICE_BOUND' })],
    });
    render(wrap(<StaffSignIn {...PROPS} auth={auth} />));
    await typePassword();
    fireEvent.change(await screen.findByLabelText('Code from the email'), { target: { value: '123456' } });
    webauthn.startRegistration.mockRejectedValueOnce(Object.assign(new Error('closed'), { name: 'NotAllowedError' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create security key' }));
    await waitFor(() => expect(webauthn.startRegistration).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create security key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Staff sign-in accepts only a key bound to one device');
    // The checked code's options were reused: one options call for two prompts.
    expect(calls.filter((c) => c.op === 'auth.passkey_enrol_options')).toHaveLength(1);
  });

  it('wrong credentials stay generic and mention a disabled account (SEC-AU-11)', async () => {
    const { auth } = fakeAuth({ 'auth.signin_password': [new ApiProblem(401, { code: 'INVALID_CREDENTIALS' })] });
    render(wrap(<StaffSignIn {...PROPS} auth={auth} />));
    await typePassword();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The email or password is not correct. If your staff account was disabled, ask a platform admin.',
    );
  });

  it('checks the fields before calling the auth host', async () => {
    const { auth, calls } = fakeAuth({});
    render(wrap(<StaffSignIn {...PROPS} auth={auth} />));
    await typePassword('not-an-email', '');
    expect(await screen.findByText('Enter your work email address.')).toBeInTheDocument();
    await typePassword('adm1@staff.carpals.test', '');
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter your password.');
    expect(calls).toHaveLength(0);
  });

  it('a pause shows the countdown; the network gate and an expired interaction have their own page', async () => {
    const paused = fakeAuth({ 'auth.signin_password': [new ApiProblem(429, { code: 'RATE_LIMITED' }, { retryAfterMs: 125_000 })] });
    const { unmount } = render(wrap(<StaffSignIn {...PROPS} auth={paused.auth} />));
    await typePassword();
    expect(await screen.findByRole('heading', { name: 'Sign-in is paused' })).toBeInTheDocument();
    expect(screen.getByText('2:05')).toBeInTheDocument();
    unmount();

    const gate = fakeAuth({ 'auth.signin_password': [new ApiProblem(403, { code: 'HTTP_403' })] });
    const second = render(wrap(<StaffSignIn {...PROPS} auth={gate.auth} />));
    await typePassword();
    expect(await screen.findByRole('heading', { name: 'Use the company network' })).toBeInTheDocument();
    second.unmount();

    const expired = fakeAuth({ 'auth.signin_password': [new ApiProblem(410, { code: 'LINK_EXPIRED' })] });
    render(wrap(<StaffSignIn {...PROPS} auth={expired.auth} />));
    await typePassword();
    expect(await screen.findByRole('heading', { name: 'This sign-in page has expired' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start again' })).toHaveAttribute('href', '/bff/login/restart?state=s');
  });

  it('without an interaction the page offers a fresh start', () => {
    render(wrap(<StaffSignIn {...PROPS} interactionId={null} resumeUrl={null} restartUrl="/bff/login" auth={fakeAuth({}).auth} />));
    expect(screen.getByRole('heading', { name: 'This sign-in page has expired' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start again' })).toHaveAttribute('href', '/bff/login');
  });

  it('a step-up puts the security key first and signs in with it alone', async () => {
    const { auth, calls } = fakeAuth({ 'auth.webauthn_options': [{ challenge: 'c' }], 'auth.mfa_verify': [{ next: 'complete' }] });
    render(wrap(<StaffSignIn {...PROPS} stepUp auth={auth} />));
    expect(screen.getByRole('heading', { name: "Confirm it's you" })).toBeInTheDocument();
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons.indexOf('Sign in with a security key')).toBeLessThan(buttons.indexOf('Continue'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with a security key' }));
    await waitFor(() => expect(goTo).toHaveBeenCalled());
    expect(calls[0]!.body).toEqual({ interaction_id: 'ia-1', purpose: 'signin' });
  });

  it('forgot password sends the reset link and comes back', async () => {
    const { auth, calls } = fakeAuth({ 'auth.password_reset_start': [{}] });
    render(wrap(<StaffSignIn {...PROPS} auth={auth} />));
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'adm1@staff.carpals.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forgot your password?' }));
    expect(screen.getByLabelText('Work email')).toHaveValue('adm1@staff.carpals.test');
    fireEvent.click(screen.getByRole('button', { name: 'Send link' }));
    expect(await screen.findByText(/a link is on its way/)).toBeInTheDocument();
    expect(calls[0]).toEqual({ op: 'auth.password_reset_start', body: { email: 'adm1@staff.carpals.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign-in' }));
    expect(screen.getByRole('heading', { name: 'Staff sign-in' })).toBeInTheDocument();
  });

  it('speaks Persian', () => {
    render(wrap(<StaffSignIn {...PROPS} auth={fakeAuth({}).auth} />, 'fa'));
    expect(screen.getByRole('heading', { name: 'ورود کارکنان' })).toBeInTheDocument();
    expect(screen.getByLabelText('ایمیل کاری')).toHaveAttribute('autocomplete', 'username');
  });
});
