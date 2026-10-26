// P4.T3/T5: link-token pages read the token from the fragment, clear it from the address bar and POST it.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp, type Handlers } from '../../../tests/support/render-app';
import { ApiProblem } from '@/lib/api/problem';
import { EmailVerifyPage, forgetFragmentTokens, PasswordResetPage } from './link-pages';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));
vi.mock('next/link', () => import('../../../tests/support/next-link'));

const open = (url: string) => {
  forgetFragmentTokens();
  window.history.replaceState(null, '', url);
};

beforeEach(() => forgetFragmentTokens());

describe('/l/ev — email verification', () => {
  it('verifies once and takes the token out of the address bar', async () => {
    open('/l/ev#cp_ev_abcdefgh123');
    const verify = vi.fn(() => ({}));
    const { api } = renderApp(<EmailVerifyPage />, { locale: 'en', handlers: { 'auth.email_verify': verify } });
    expect(await screen.findByRole('heading', { name: 'Your email address is verified' })).toBeInTheDocument();
    expect(api.calls).toEqual([{ opId: 'auth.email_verify', args: { body: { token: 'cp_ev_abcdefgh123' } } }]);
    expect(window.location.hash).toBe('');
    expect(screen.getByRole('link', { name: 'Continue to CarPal' })).toHaveAttribute('href', '/en/login');
  });

  it.each([
    ['LINK_USED', 410, 'This link was already used.'],
    ['LINK_EXPIRED', 410, 'This link has expired. Log in and we will send you a new code.'],
    ['DUPLICATE', 409, 'This email address is now used by another account.'],
  ])('%s → its own message', async (code, status, text) => {
    open('/l/ev#cp_ev_abcdefgh123');
    const handlers: Handlers = {
      'auth.email_verify': () => {
        throw new ApiProblem(status, { code });
      },
    };
    renderApp(<EmailVerifyPage />, { locale: 'en', handlers });
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('an incomplete link says so without calling anything', async () => {
    open('/l/ev#x');
    const { api } = renderApp(<EmailVerifyPage />, { locale: 'en' });
    expect(await screen.findByText('This link is incomplete. Open it again from the email.')).toBeInTheDocument();
    expect(api.calls).toEqual([]);
  });
});

describe('/l/pr — password reset', () => {
  it('checks length and the confirmation, then sets the password', async () => {
    open('/l/pr#cp_pr_abcdefgh123');
    const { api } = renderApp(<PasswordResetPage />, { locale: 'en', handlers: { 'auth.password_reset_complete': () => ({}) } });
    const [pw, confirm] = await screen.findAllByLabelText(/password/i, { selector: 'input' });
    fireEvent.change(pw!, { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(screen.getByText('Use at least 12 characters.')).toBeInTheDocument();
    fireEvent.change(pw!, { target: { value: 'winter-tyres-2026' } });
    fireEvent.change(confirm!, { target: { value: 'winter-tyres-2025' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(screen.getByText('The passwords do not match.')).toBeInTheDocument();
    fireEvent.change(confirm!, { target: { value: 'winter-tyres-2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('heading', { name: 'Password changed' })).toBeInTheDocument();
    expect(screen.getByText('Other devices have been signed out.')).toBeInTheDocument();
    expect(api.calls).toEqual([
      { opId: 'auth.password_reset_complete', args: { body: { token: 'cp_pr_abcdefgh123', new_password: 'winter-tyres-2026' } } },
    ]);
  });

  it('a used or expired link and a breached password', async () => {
    open('/l/pr#cp_pr_abcdefgh123');
    let calls = 0;
    const handlers: Handlers = {
      'auth.password_reset_complete': () => {
        calls += 1;
        if (calls === 1) throw new ApiProblem(422, { code: 'VALIDATION_FAILED', errors: [{ pointer: '/new_password', code: 'pattern' }] });
        throw new ApiProblem(410, { code: 'LINK_USED' });
      },
    };
    renderApp(<PasswordResetPage />, { locale: 'en', handlers });
    const [pw, confirm] = await screen.findAllByLabelText(/password/i, { selector: 'input' });
    for (const el of [pw!, confirm!]) fireEvent.change(el, { target: { value: 'password1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(
      await screen.findByText('This password is too common or has appeared in a data leak. Choose a less common password.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(screen.getByText(/This reset link has expired or was already used/)).toBeInTheDocument());
  });
});
