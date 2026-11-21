// AC14b.T2 DOM tests of the first sign-in password change (contract 1.5.0, backend S26a): a seeded staff account gets
// next 'change_password' after its initial password, enters the emailed code and its own password twice
// (auth.password_set_initial), then enrols its key with the same code (carried over) or confirms with its key. No way
// around the step; the server's field errors are explained; five wrong codes end the interaction (410); an expired
// initial password gets the generic answer and the line about a new initial password. axe in EN and FA.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from '../../../tests/support/console-harness';
import { FormatProvider } from '@/lib/format/client';
import { I18nProvider } from '@/lib/i18n/client';
import { BUNDLED, pickNamespaces } from '@/lib/i18n/dictionary';
import type { Locale } from '@/lib/i18n/locales';
import { ApiProblem } from '@/lib/api/problem';
import type { AuthClient, AuthOperationId } from './auth-client';
import { newPasswordProblem, newPasswordRefusal, passwordStrength } from './password-rules';
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

function fakeAuth(answers: Partial<Record<AuthOperationId, unknown[]>>) {
  const calls: { op: AuthOperationId; body: Record<string, unknown> }[] = [];
  const auth: AuthClient = {
    call: (async (op: AuthOperationId, body: Record<string, unknown>) => {
      calls.push({ op, body });
      const next = answers[op]?.shift();
      if (next === undefined) throw new Error(`unexpected ${op}`);
      if (next instanceof Error) throw next;
      return next;
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
const NEW = 'river lamp quiet orbit';
const invalid = (pointer: string, code: string) => new ApiProblem(422, { code: 'VALIDATION_FAILED', errors: [{ pointer, code }] });

async function signIn() {
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'admin100@carpals.ir' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'initial-password-from-owner' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: 'Choose your own password' });
}

function fill(code: string, password: string, repeat = password) {
  fireEvent.change(screen.getByLabelText('Code from the email'), { target: { value: code } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Repeat the new password'), { target: { value: repeat } });
  fireEvent.click(screen.getByRole('button', { name: 'Save password and continue' }));
}

beforeEach(() => {
  goTo.mockReset();
  webauthn.startAuthentication.mockClear();
  webauthn.startRegistration.mockClear();
});

describe('first sign-in password change (AC14b.T2)', () => {
  it('code + own password, then the key enrolment with the same code, then the key', async () => {
    const { auth, calls } = fakeAuth({
      'auth.signin_password': [{ next: 'change_password' }],
      'auth.password_set_initial': [{ next: 'enrol_passkey' }],
      'auth.passkey_enrol_options': [{ challenge: 'reg' }],
      'auth.passkey_enrol': [{ next: 'mfa', mfa_methods: ['webauthn'] }],
      'auth.webauthn_options': [{ challenge: 'c' }],
      'auth.mfa_verify': [{ next: 'complete' }],
    });
    render(wrap(<StaffSignIn {...PROPS} auth={auth} />));
    await signIn();
    // The rules are shown before typing; there is no way to skip the step (no key button, no "later").
    expect(screen.getByText('12 to 128 characters long')).toBeInTheDocument();
    expect(screen.getByText('different from the initial password')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /security key/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /skip|later/i })).toBeNull();

    fill('۱۲۳۴۵۶', NEW);
    expect(await screen.findByRole('heading', { name: 'Set up your security key' })).toBeInTheDocument();
    expect(calls[1]).toEqual({ op: 'auth.password_set_initial', body: { interaction_id: 'ia-1', code: '123456', new_password: NEW } });
    expect(screen.getByText('Your new password is saved.')).toBeInTheDocument();
    // The same code opens the enrolment: filled in, not typed again; the browser prompt waits for the click.
    expect(screen.getByLabelText('Code from the email')).toHaveValue('123456');
    expect(webauthn.startRegistration).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create security key' }));
    await screen.findByText('Security key added. Now confirm with it once to finish signing in.');
    expect(calls.find((c) => c.op === 'auth.passkey_enrol_options')!.body).toMatchObject({ code: '123456' });
    fireEvent.click(screen.getByRole('button', { name: 'Use security key' }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/id/oauth/authorize?state=s'));
  });

  it('an account that already has a key confirms with it after the change', async () => {
    const { auth } = fakeAuth({
      'auth.signin_password': [{ next: 'change_password' }],
      'auth.password_set_initial': [{ next: 'mfa', mfa_methods: ['webauthn'] }],
    });
    render(wrap(<StaffSignIn {...PROPS} auth={auth} />));
    await signIn();
    fill('123456', NEW);
    expect(await screen.findByRole('heading', { name: 'Confirm with your security key' })).toBeInTheDocument();
    expect(screen.getByText('Your new password is saved.')).toBeInTheDocument();
  });

  it('checks the fields first, then explains the server refusals in the right field', async () => {
    const { auth, calls } = fakeAuth({
      'auth.signin_password': [{ next: 'change_password' }],
      'auth.password_set_initial': [
        new ApiProblem(422, { code: 'CODE_INVALID' }),
        invalid('/new_password', 'pattern'),
        invalid('/new_password', 'not_unique'),
        invalid('/new_password', 'too_short'),
        { next: 'mfa', mfa_methods: ['webauthn'] },
      ],
    });
    render(wrap(<StaffSignIn {...PROPS} auth={auth} />));
    await signIn();
    fill('12', 'short');
    expect(await screen.findByText('Enter the 6-digit code from the email.')).toBeInTheDocument();
    expect(screen.getByText('The new password must be 12 to 128 characters long.')).toBeInTheDocument();
    fill('123456', NEW, `${NEW}!`);
    expect(await screen.findByText('The two passwords are not the same.')).toBeInTheDocument();
    expect(calls).toHaveLength(1);

    fill('123456', NEW);
    expect(await screen.findByText('The code is not correct. Check the latest email and try again.')).toBeInTheDocument();
    fill('123456', NEW);
    expect(await screen.findByText('This password is known from data breaches. Choose another one.')).toBeInTheDocument();
    fill('123456', NEW);
    expect(await screen.findByText('This is the initial password. Choose a password of your own.')).toBeInTheDocument();
    fill('123456', NEW);
    expect(await screen.findByText('The new password must be 12 to 128 characters long.')).toBeInTheDocument();
    fill('123456', NEW);
    await screen.findByRole('heading', { name: 'Confirm with your security key' });
  });

  it('show/hide and the strength hint', async () => {
    const { auth } = fakeAuth({ 'auth.signin_password': [{ next: 'change_password' }] });
    render(wrap(<StaffSignIn {...PROPS} auth={auth} />));
    await signIn();
    const field = screen.getByLabelText('New password');
    expect(field).toHaveAttribute('type', 'password');
    fireEvent.change(field, { target: { value: 'abc' } });
    expect(screen.getByText('Too short: at least 12 characters.')).toBeInTheDocument();
    fireEvent.change(field, { target: { value: NEW } });
    expect(screen.getByText('Strength: strong.')).toBeInTheDocument();
    const reveal = screen.getByRole('button', { name: 'Show password' });
    fireEvent.click(reveal);
    expect(reveal).toHaveAttribute('aria-pressed', 'true');
    expect(field).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('Repeat the new password')).toHaveAttribute('type', 'text');
  });

  it('five wrong codes end the interaction (410): start again', async () => {
    const { auth } = fakeAuth({
      'auth.signin_password': [{ next: 'change_password' }],
      'auth.password_set_initial': [new ApiProblem(410, { code: 'LINK_EXPIRED' })],
    });
    render(wrap(<StaffSignIn {...PROPS} auth={auth} />));
    await signIn();
    fill('123456', NEW);
    expect(await screen.findByRole('heading', { name: 'This sign-in page has expired' })).toBeInTheDocument();
  });

  it('the enrolment expiring after the change says to sign in with the new password', async () => {
    const { auth } = fakeAuth({
      'auth.signin_password': [{ next: 'change_password' }],
      'auth.password_set_initial': [{ next: 'enrol_passkey' }],
      'auth.passkey_enrol_options': [new ApiProblem(410, { code: 'LINK_EXPIRED' })],
    });
    render(wrap(<StaffSignIn {...PROPS} auth={auth} />));
    await signIn();
    fill('123456', NEW);
    fireEvent.click(await screen.findByRole('button', { name: 'Create security key' }));
    expect(await screen.findByRole('heading', { name: 'This sign-in page has expired' })).toBeInTheDocument();
    expect(screen.getByText(/Your new password is saved. Start again and sign in with it/)).toBeInTheDocument();
  });

  it('an expired initial password gets the generic answer and what to do about it', async () => {
    const { auth } = fakeAuth({ 'auth.signin_password': [new ApiProblem(401, { code: 'INVALID_CREDENTIALS' })] });
    render(wrap(<StaffSignIn {...PROPS} auth={auth} />));
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'admin100@carpals.ir' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'old-initial-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The email or password is not correct.');
    expect(screen.getByText(/ask the server operator for a new initial password/)).toBeInTheDocument();
  });

  it.each(['en', 'fa'] as const)('has no axe violations (%s)', async (locale) => {
    const { auth } = fakeAuth({ 'auth.signin_password': [{ next: 'change_password' }] });
    const { container } = render(wrap(<StaffSignIn {...PROPS} auth={auth} />, locale));
    fireEvent.change(container.querySelector('input[name="username"]')!, { target: { value: 'admin100@carpals.ir' } });
    fireEvent.change(container.querySelector('input[name="password"]')!, { target: { value: 'initial-password-from-owner' } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(container.querySelector('[data-testid="change-password"]')).not.toBeNull());
    fireEvent.change(container.querySelector('input[name="new-password"]')!, { target: { value: 'abc' } });
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('new password rules', () => {
  it('length and repeat before sending', () => {
    expect(newPasswordProblem('a'.repeat(11), 'a'.repeat(11))).toBe('length');
    expect(newPasswordProblem('a'.repeat(129), 'a'.repeat(129))).toBe('length');
    expect(newPasswordProblem('a'.repeat(12), 'b'.repeat(12))).toBe('repeat');
    expect(newPasswordProblem('a'.repeat(12), 'a'.repeat(12))).toBeNull();
  });

  it('strength from length and variety only', () => {
    expect(passwordStrength('Ab1!')).toBe('short');
    expect(passwordStrength('abcdefghijkl')).toBe('fair');
    expect(passwordStrength('abcdefghijklmn')).toBe('good');
    expect(passwordStrength('Abcdefghij1!')).toBe('good');
    expect(passwordStrength('Abcdefghijklmn1!')).toBe('strong');
    expect(passwordStrength('a'.repeat(20))).toBe('strong');
  });

  it('maps the server field codes', () => {
    expect(newPasswordRefusal(invalid('/new_password', 'pattern'))).toBe('admin.signin.initial.errors.breached');
    expect(newPasswordRefusal(invalid('/new_password', 'not_unique'))).toBe('admin.signin.initial.errors.same');
    expect(newPasswordRefusal(invalid('/new_password', 'too_long'))).toBe('admin.signin.initial.errors.length');
    expect(newPasswordRefusal(invalid('/code', 'pattern'))).toBeNull();
    expect(newPasswordRefusal(new ApiProblem(422, { code: 'CODE_INVALID' }))).toBeNull();
  });
});
