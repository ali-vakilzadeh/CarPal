// AC10b.T1/T3 DOM tests: the recovery codes shown once after a new key, and "Lost my security key" from the request to
// the new key, against a fake auth client (the WebAuthn API is mocked; tests/e2e/recovery.spec.ts runs the real
// ceremony). The request handle never appears in the browser's calls: the /id proxy adds it (recovery.test.ts).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axeViolations } from '../../../tests/support/console-harness';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FormatProvider } from '@/lib/format/client';
import { I18nProvider } from '@/lib/i18n/client';
import { BUNDLED, pickNamespaces } from '@/lib/i18n/dictionary';
import type { Locale } from '@/lib/i18n/locales';
import { ApiProblem } from '@/lib/api/problem';
import type { AuthClient, AuthOperationId } from './auth-client';
import { normalizeRecoveryCode, StaffSignIn } from './staff-sign-in';

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
const CODES = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCCC-DDDD-EEE${i}`);
const status = (s: string, o: { approvals?: number; forgotten?: boolean } = {}) => ({
  status: s,
  password_forgotten: o.forgotten ?? false,
  approvals: o.approvals ?? 0,
  expires_at: '2026-11-21T10:00:00Z',
});

beforeEach(() => {
  goTo.mockReset();
  webauthn.startAuthentication.mockClear();
  webauthn.startRegistration.mockClear();
});

describe('recovery codes after the first key (AC10b.T1)', () => {
  it('shows the codes once and goes on only after "I have stored them"', async () => {
    const { auth } = fakeAuth({
      'auth.signin_password': [{ next: 'enrol_passkey' }],
      'auth.passkey_enrol_options': [{ challenge: 'reg' }],
      'auth.passkey_enrol': [{ next: 'mfa', mfa_methods: ['webauthn'], recovery_codes: CODES }],
      'auth.webauthn_options': [{ challenge: 'c' }],
      'auth.mfa_verify': [{ next: 'complete' }],
    });
    const { container } = render(wrap(<StaffSignIn {...PROPS} auth={auth} />));
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'adm1@staff.carpals.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('Code from the email'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create security key' }));

    await screen.findByRole('heading', { level: 1, name: 'Store your recovery codes' });
    expect(screen.getAllByTestId('recovery-code').map((c) => c.textContent)).toEqual(CODES);
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tick "I have stored them" first.');
    fireEvent.click(screen.getByLabelText('I have stored them'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // The codes are gone from the page; the new key signs in.
    await screen.findByText('Security key added. Now confirm with it once to finish signing in.');
    expect(screen.queryAllByTestId('recovery-code')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Use security key' }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/id/oauth/authorize?state=s'));
  });

  it('says the new key is kept when the page expires before the key step', async () => {
    const { auth } = fakeAuth({
      'auth.signin_password': [{ next: 'enrol_passkey' }],
      'auth.passkey_enrol_options': [{ challenge: 'reg' }],
      'auth.passkey_enrol': [{ next: 'mfa', recovery_codes: CODES }],
      'auth.webauthn_options': [new ApiProblem(410, { code: 'LINK_EXPIRED' })],
    });
    render(wrap(<StaffSignIn {...PROPS} auth={auth} />));
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'adm1@staff.carpals.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('Code from the email'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create security key' }));
    fireEvent.click(await screen.findByLabelText('I have stored them'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use security key' }));
    await screen.findByText('Your new security key was saved. Start again and sign in with it.');
  });
});

describe('lost security key (AC10b.T3)', () => {
  it('asks for a recovery, checks the emailed code, waits, then makes the new key and shows the new codes', async () => {
    const { auth, calls } = fakeAuth({
      'auth.staff_recovery_start': [{}],
      'auth.staff_recovery_verify': [status('awaiting_approvals')],
      'auth.staff_recovery_status': [status('awaiting_approvals', { approvals: 1 }), status('approved', { approvals: 2 })],
      'auth.staff_recovery_complete_options': [{ challenge: 'reg' }],
      'auth.staff_recovery_complete': [{ next: 'mfa', mfa_methods: ['webauthn'], recovery_codes: CODES }],
      'auth.webauthn_options': [{ challenge: 'c' }],
      'auth.mfa_verify': [{ next: 'complete' }],
    });
    render(wrap(<StaffSignIn {...PROPS} auth={auth} />));
    fireEvent.click(screen.getByRole('button', { name: 'Lost your security key?' }));
    await screen.findByRole('heading', { level: 1, name: 'Recover your staff account' });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for a recovery' }));
    expect(screen.getByText('Enter your work email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter one of your recovery codes, e.g. ABCD-EFGH-JKMN-PQRS-TVWX.')).toBeInTheDocument();
    expect(calls).toEqual([]);

    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'sara@staff.carpals.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: ' aaaa-bbbb-cccc-dddd-eee0 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for a recovery' }));
    await screen.findByRole('heading', { level: 1, name: 'Check your email' });
    expect(calls[0]).toEqual({
      op: 'auth.staff_recovery_start',
      body: {
        interaction_id: 'ia-1',
        email: 'sara@staff.carpals.test',
        password: 'pw',
        password_forgotten: false,
        recovery_code: 'AAAA-BBBB-CCCC-DDDD-EEE0',
      },
    });

    fireEvent.change(screen.getByLabelText('Code from the email'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send the request' }));
    await screen.findByRole('heading', { level: 1, name: 'Waiting for two administrators' });
    expect(calls[1]).toEqual({ op: 'auth.staff_recovery_verify', body: { interaction_id: 'ia-1', code: '654321' } });
    expect(screen.getByText(/0 of 2 approved/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByText(/1 of 2 approved/);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByRole('heading', { level: 1, name: 'Recovery approved' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('heading', { level: 1, name: 'Set up your new security key' });
    expect(screen.queryByLabelText('New password')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create security key' }));
    await screen.findByRole('heading', { level: 1, name: 'Store your recovery codes' });
    expect(calls.find((c) => c.op === 'auth.staff_recovery_complete_options')!.body).toEqual({ interaction_id: 'ia-1' });
    expect(calls.find((c) => c.op === 'auth.staff_recovery_complete')!.body).toEqual({
      interaction_id: 'ia-1',
      attestation: { id: 'new-cred', type: 'public-key' },
    });
    // No call carries a request handle (the /id proxy adds it).
    expect(calls.some((c) => 'request_handle' in c.body)).toBe(false);

    fireEvent.click(screen.getByLabelText('I have stored them'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use security key' }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('/id/oauth/authorize?state=s'));
  });

  it('continues an approved recovery in a new sign-in, with a new password when it was forgotten', async () => {
    const { auth, calls } = fakeAuth({
      'auth.staff_recovery_status': [status('approved', { approvals: 2, forgotten: true })],
      'auth.staff_recovery_complete_options': [
        new ApiProblem(422, { code: 'VALIDATION_FAILED', errors: [{ pointer: '/new_password', code: 'breached_password' }] }),
        { challenge: 'reg' },
      ],
      'auth.staff_recovery_complete': [{ next: 'mfa', recovery_codes: CODES }],
    });
    render(wrap(<StaffSignIn {...PROPS} recoveryPending auth={auth} />));
    await screen.findByRole('heading', { level: 1, name: 'Recovery approved' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create security key' }));
    expect(screen.getByText('The new password must have 12 to 128 characters.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a-long-new-password' } });
    fireEvent.change(screen.getByLabelText('Repeat the new password'), { target: { value: 'another-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create security key' }));
    expect(screen.getByText('The two passwords are not the same.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Repeat the new password'), { target: { value: 'a-long-new-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create security key' }));
    await screen.findByText('This password cannot be used. Choose a longer one that you have not used before.');
    fireEvent.click(screen.getByRole('button', { name: 'Create security key' }));
    await screen.findByRole('heading', { level: 1, name: 'Store your recovery codes' });
    expect(calls.filter((c) => c.op === 'auth.staff_recovery_complete_options').map((c) => c.body)).toEqual([
      { interaction_id: 'ia-1', new_password: 'a-long-new-password' },
      { interaction_id: 'ia-1', new_password: 'a-long-new-password' },
    ]);
  });

  it('says when this browser has no open request, or it was rejected', async () => {
    const gone = fakeAuth({ 'auth.staff_recovery_status': [new ApiProblem(404, { code: 'NOT_FOUND' })] });
    const { unmount } = render(wrap(<StaffSignIn {...PROPS} recoveryPending auth={gone.auth} />));
    expect(await screen.findByTestId('recover-ended')).toHaveAttribute('data-state', 'gone');
    unmount();
    const rejected = fakeAuth({ 'auth.staff_recovery_status': [status('rejected', { approvals: 1 })] });
    render(wrap(<StaffSignIn {...PROPS} recoveryPending auth={rejected.auth} />, 'fa'));
    expect(await screen.findByTestId('recover-ended')).toHaveAttribute('data-state', 'rejected');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'بازگشت به ورود' }));
    });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('never offers a recovery on a step-up sign-in', () => {
    const { auth } = fakeAuth({});
    render(wrap(<StaffSignIn {...PROPS} stepUp recoveryPending auth={auth} />));
    expect(screen.queryByRole('button', { name: 'Lost your security key?' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: "Confirm it's you" })).toBeInTheDocument();
  });

  it('normalizes a typed recovery code', () => {
    expect(normalizeRecoveryCode(' abcd-efgh jkmn-pqrs-tvwx ')).toBe('ABCD-EFGHJKMN-PQRS-TVWX');
    expect(normalizeRecoveryCode('۱۲۳۴-abcd')).toBe('1234-ABCD');
  });
});
