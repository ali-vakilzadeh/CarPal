// P4.T1-T5: the hosted sign-in's steps with the real providers and a fake typed client (auth operations on the auth
// host): sign-up → verify by code → complete; password → second factor; phone → code by text; lock; expiry; reset.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp, type Handlers } from '../../../tests/support/render-app';
import { navigation } from '../../../tests/support/next-navigation';
import { ApiProblem } from '@/lib/api/problem';
import { goTo } from '@/lib/browser-nav';
import { HostedSignIn, type HostedSignInProps } from './hosted-sign-in';
import { takeSignupChoices } from './storage';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));
vi.mock('next/link', () => import('../../../tests/support/next-link'));
vi.mock('@/lib/browser-nav', () => ({ goTo: vi.fn() }));

const RESUME = '/id/oauth/authorize?state=st';
const props = (over: Partial<HostedSignInProps> = {}): HostedSignInProps => ({
  interactionId: 'ia-1',
  resumeUrl: RESUME,
  restartUrl: '/bff/login/restart?state=st',
  screen: 'signin',
  context: null,
  termsVersion: '2026-10',
  privacyVersion: '2026-10',
  ...over,
});

beforeEach(() => {
  navigation.reset('/id/signin');
  vi.mocked(goTo).mockClear();
  sessionStorage.clear();
  localStorage.clear();
  document.cookie = 'cp_keep=; Max-Age=0; Path=/';
});

afterEach(() => {
  vi.useRealTimers();
});

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const pasteCode = (code: string) =>
  fireEvent.paste(screen.getAllByRole('textbox', { name: /Digit 1 of 6/ })[0]!, { clipboardData: { getData: () => code } });

describe('sign up (S-AUTH-03) → verify by code (S-AUTH-07) → back to the authorize request', () => {
  it('sends the account with the policy versions, then the verification code, then completes', async () => {
    const handlers: Handlers = {
      'auth.signup': () => ({ next: 'verify_email' }),
      'auth.otp_start': () => ({}),
      'auth.otp_verify': () => ({ next: 'complete' }),
    };
    const { api } = renderApp(<HostedSignIn {...props({ screen: 'signup', context: 'Sign in to follow Reza' })} />, {
      locale: 'en',
      handlers,
    });
    expect(screen.getByRole('heading', { name: 'Create account' })).toBeInTheDocument();
    expect(screen.getByText('Sign in to follow Reza')).toBeInTheDocument();

    // Required boxes are checked on submit and named.
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Please agree to the Terms to create an account.')).toBeInTheDocument();
    expect(api.calls).toEqual([]);

    type('Full name', 'Sara Mohammadi');
    type('Email', 'sara@test.carpal.app');
    type('Password (optional)', 'silver-e90-2012');
    fireEvent.click(screen.getByLabelText('I agree to the Terms'));
    fireEvent.click(screen.getByLabelText('I have read the Privacy Policy'));
    fireEvent.click(screen.getByLabelText('Send me news and offers'));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('heading', { name: 'Verify your email' })).toBeInTheDocument();
    expect(api.calls[0]).toEqual({
      opId: 'auth.signup',
      args: {
        body: {
          interaction_id: 'ia-1',
          full_name: 'Sara Mohammadi',
          email: 'sara@test.carpal.app',
          password: 'silver-e90-2012',
          locale: 'en',
          terms_version: '2026-10',
          privacy_policy_version: '2026-10',
        },
      },
    });
    expect(api.calls[1]).toEqual({
      opId: 'auth.otp_start',
      args: { body: { interaction_id: 'ia-1', channel: 'email', destination: 'sara@test.carpal.app', purpose: 'verify' } },
    });
    expect(screen.getByText(/We sent a 6-digit code to .*s\*\*\*@test\.carpal\.app/)).toBeInTheDocument();
    // The resend waits 60 s (SEC-AU-8).
    expect(screen.getByRole('button', { name: /Send a new code in/ })).toBeDisabled();

    pasteCode('48 19 27');
    await waitFor(() => expect(goTo).toHaveBeenCalledWith(RESUME));
    expect(api.calls[2]).toEqual({ opId: 'auth.otp_verify', args: { body: { interaction_id: 'ia-1', code: '481927' } } });
    // Optional choices wait for the signed-in account (DI-30); "Keep me signed in" is on for new accounts.
    expect(takeSignupChoices()).toMatchObject({ marketing: true, aiPersonalization: false, policyVersion: '2026-10' });
    expect(document.cookie).not.toContain('cp_keep=0');
  });

  it('shows the breached-password message from the auth host under the field', async () => {
    const handlers: Handlers = {
      'auth.signup': () => {
        throw new ApiProblem(422, { code: 'VALIDATION_FAILED', errors: [{ pointer: '/password', code: 'pattern' }] });
      },
    };
    renderApp(<HostedSignIn {...props({ screen: 'signup' })} />, { locale: 'en', handlers });
    type('Full name', 'Sara Mohammadi');
    type('Email', 'sara@test.carpal.app');
    type('Password (optional)', 'password1234');
    fireEvent.click(screen.getByLabelText('I agree to the Terms'));
    fireEvent.click(screen.getByLabelText('I have read the Privacy Policy'));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(
      (await screen.findAllByText('This password is too common or has appeared in a data leak. Choose a less common password.')).length,
    ).toBeGreaterThan(0);
  });
});

describe('sign in (S-AUTH-02)', () => {
  it('password: the same message for any failure, then the second factor (TOTP or recovery code)', async () => {
    let attempts = 0;
    const handlers: Handlers = {
      'auth.signin_password': () => {
        attempts += 1;
        if (attempts === 1) throw new ApiProblem(401, { code: 'INVALID_CREDENTIALS' });
        return { next: 'mfa', mfa_methods: ['totp_mfa'] };
      },
      'auth.mfa_verify': (args) => {
        const body = args.body as { method: string };
        if (body.method === 'totp_mfa') throw new ApiProblem(401, { code: 'INVALID_CREDENTIALS' });
        return { next: 'complete' };
      },
    };
    const { api } = renderApp(<HostedSignIn {...props()} />, { locale: 'en', handlers });
    type('Mobile number or email', 'sara@test.carpal.app');
    fireEvent.click(screen.getByRole('button', { name: 'Use password' }));
    type('Password', 'wrong password');
    fireEvent.click(screen.getByLabelText('Keep me signed in on this device'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Email or password is not correct.')).toBeInTheDocument();
    expect(document.cookie).toContain('cp_keep=0');

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Two-step sign-in' })).toBeInTheDocument();
    pasteCode('123456');
    expect(await screen.findByText('That code is not right. Try again.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    type('Recovery code', 'ABCD-EFGH-1234');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith(RESUME));
    expect(api.calls.at(-1)).toEqual({
      opId: 'auth.mfa_verify',
      args: { body: { interaction_id: 'ia-1', method: 'recovery_code', recovery_code: 'ABCD-EFGH-1234' } },
    });
    expect(localStorage.getItem('cp:signin-method')).toBe('password');
  });

  it('phone: a code by text in E.164, enumeration-safe wording; passwords need the email', async () => {
    const handlers: Handlers = { 'auth.otp_start': () => ({}), 'auth.otp_verify': () => ({ next: 'complete' }) };
    const { api } = renderApp(<HostedSignIn {...props()} />, { locale: 'en', handlers });
    type('Mobile number or email', '0912 345 4567');
    expect(screen.getByRole('button', { name: 'Use password' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Enter your code' })).toBeInTheDocument();
    expect(api.calls[0]!.args).toEqual({
      body: { interaction_id: 'ia-1', channel: 'sms', destination: '+989123454567', purpose: 'signin' },
    });
    expect(screen.getByText(/If .*\+98 912 \*\*\* 4567.* belongs to a CarPal account/)).toBeInTheDocument();
    // "Change" goes back to the form.
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });

  it('refuses numbers outside the region before sending (BA-13)', async () => {
    const { api } = renderApp(<HostedSignIn {...props()} />, { locale: 'en' });
    type('Mobile number or email', '+49 30 1234567');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('We can’t send text messages to this country yet. Use your email address.')).toBeInTheDocument();
    expect(api.calls).toEqual([]);
  });

  it('a wrong code clears the boxes and says so', async () => {
    const handlers: Handlers = {
      'auth.otp_start': () => ({}),
      'auth.otp_verify': () => {
        throw new ApiProblem(422, { code: 'CODE_INVALID' });
      },
    };
    renderApp(<HostedSignIn {...props()} />, { locale: 'en', handlers });
    type('Mobile number or email', 'sara@test.carpal.app');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Enter your code' });
    pasteCode('111111');
    expect(await screen.findByText('That code is not right or has expired. Try again, or send a new code.')).toBeInTheDocument();
    for (const box of screen.getAllByRole('textbox', { name: /Digit \d of 6/ })) expect(box).toHaveValue('');
  });

  it('a timed lock (429) shows the countdown; an expired interaction (410) offers a restart', async () => {
    const handlers: Handlers = {
      'auth.signin_password': () => {
        throw new ApiProblem(429, { code: 'RATE_LIMITED' }, { retryAfterMs: 125_000 });
      },
      'auth.otp_start': () => {
        throw new ApiProblem(410, { code: 'LINK_EXPIRED' });
      },
    };
    renderApp(<HostedSignIn {...props()} />, { locale: 'en', handlers });
    type('Mobile number or email', 'sara@test.carpal.app');
    fireEvent.click(screen.getByRole('button', { name: 'Use password' }));
    type('Password', 'x');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Sign-in is paused' })).toBeInTheDocument();
    expect(screen.getByText(/^2:0\d$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to log in' }));

    fireEvent.click(screen.getByRole('button', { name: 'Send me a code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'This sign-in page expired' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start again' })).toHaveAttribute('href', '/bff/login/restart?state=st');
  });

  it('without a known interaction the page is "expired" from the start', () => {
    renderApp(<HostedSignIn {...props({ resumeUrl: null })} />, { locale: 'fa' });
    expect(screen.getByRole('heading', { name: 'این صفحه ورود منقضی شد' })).toBeInTheDocument();
  });
});

describe('forgot password (S-AUTH-08)', () => {
  it('always the same answer', async () => {
    const handlers: Handlers = { 'auth.password_reset_start': () => ({}) };
    const { api } = renderApp(<HostedSignIn {...props()} />, { locale: 'en', handlers });
    type('Mobile number or email', 'nobody@test.carpal.app');
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(screen.getByLabelText('Email')).toHaveValue('nobody@test.carpal.app');
    fireEvent.click(screen.getByRole('button', { name: 'Send link' }));
    expect(await screen.findByText(/If this email belongs to an account, we sent it a link/)).toBeInTheDocument();
    expect(api.calls).toEqual([{ opId: 'auth.password_reset_start', args: { body: { email: 'nobody@test.carpal.app' } } }]);
  });
});
