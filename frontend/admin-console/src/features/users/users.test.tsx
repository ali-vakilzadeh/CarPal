// AC10.T1-T3 DOM tests of the user screens: the lookup needs a work item and finds by one identifier (Persian digits,
// purpose header, masked results, the purpose carried on); the user page read for its purpose with masked contacts
// and Reveal, a timed suspension (BR-07), the role-gated actions (sign out everywhere, reset onboarding), staff roles
// for ADMs (grant by four-eyes, revoke at once with the reason header), a record outside the work item, a deleted
// account; axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Membership, StaffUserView } from '@carpal/api-contracts';
import { axeViolations, page, problem, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { UserPage } from './user-page';
import { UsersPage } from './users-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const U1 = '0193a3c4-5d6e-7f80-9a1b-0000000000b1';
const D1 = '0193a3c4-5d6e-7f80-9a1b-0000000000d1';
const PURPOSE = `dsr:${D1}`;
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

const membership = (role: Membership['role'], o: Partial<Membership> = {}): Membership => ({
  id: `0193a3c4-5d6e-7f80-9a1b-${role.length.toString().padStart(12, '0')}`,
  created_at: ago(100),
  updated_at: ago(100),
  version: 1,
  organization: null,
  role,
  status: 'active',
  joined_at: ago(100),
  ...o,
});

function user(o: Partial<StaffUserView> = {}): StaffUserView {
  return {
    id: U1,
    full_name: 'Sara Ahmadi',
    display_name: 'Sara A.',
    email: 'sara.ahmadi@example.com',
    phone: '+989123456789',
    status: 'active',
    email_verified_at: ago(90),
    phone_verified_at: null,
    mfa_enabled: false,
    created_at: ago(100),
    last_active_at: ago(1),
    memberships: [membership('individual')],
    subscription: { plan_key: 'free_individual', status: 'active', max_vehicles: 3, active_vehicles: 1, trial_ends_at: null },
    trusted_user: false,
    counts: { reviews: 4, reports_against: 1, open_disputes: 0 },
    suspended_until: null,
    ...o,
  } as StaffUserView;
}

const reason = (dialog: HTMLElement, code: string, note?: string) => {
  fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: code } });
  if (note !== undefined) fireEvent.change(within(dialog).getByLabelText(/^Note/), { target: { value: note } });
};

beforeEach(() => resetNav('/users'));
afterEach(() => vi.unstubAllGlobals());

describe('User lookup (AC10.T1)', () => {
  it('needs a work item: without a purpose nothing is searched', async () => {
    const { transport, calls } = scriptedTransport({});
    renderConsole(<UsersPage />, { transport, roles: ['SUP'] });
    expect(await screen.findByText('Open this from a work item')).toBeInTheDocument();
    expect(screen.queryByRole('search')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('finds by one identifier within the work item; results are masked and keep the purpose', async () => {
    resetNav(`/users?purpose=${encodeURIComponent(PURPOSE)}`);
    const { transport, calls } = scriptedTransport({ 'admin.users_search': () => page([user()]) });
    renderConsole(<UsersPage />, { transport, roles: ['SUP'] });
    expect(await screen.findByTestId('users-purpose')).toHaveTextContent('Read for this work item: a privacy request.');
    fireEvent.change(screen.getByLabelText('Find by'), { target: { value: 'phone' } });
    fireEvent.change(screen.getByLabelText('Search for'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(screen.getByText('This does not look right for the chosen kind.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Search for'), { target: { value: '۰۹۱۲ ۳۴۵ ۶۷۸۹' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    const link = await screen.findByTestId('user-result');
    expect(calls[0]!.body).toEqual({ phone: '+989123456789' });
    expect(calls[0]!.headers.get('carpal-access-purpose')).toBe(PURPOSE);
    expect(link).toHaveAttribute('href', `/users/${U1}?purpose=${encodeURIComponent(PURPOSE)}`);
    const results = screen.getByTestId('users-results');
    expect(results).not.toHaveTextContent('sara.ahmadi@example.com');
    expect(results).not.toHaveTextContent('+989123456789');
  });

  it('says so when nobody in the work item matches', async () => {
    resetNav(`/users?purpose=${encodeURIComponent(PURPOSE)}`);
    const { transport } = scriptedTransport({ 'admin.users_search': () => page([]) });
    renderConsole(<UsersPage />, { transport, roles: ['MOD'] });
    fireEvent.change(await screen.findByLabelText('Search for'), { target: { value: 'nobody@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByTestId('users-none')).toBeInTheDocument();
  });
});

describe('User detail (AC10.T2/T3)', () => {
  beforeEach(() => resetNav(`/users/${U1}?purpose=${encodeURIComponent(PURPOSE)}`));

  it('reads the user for the purpose; contacts are masked until Reveal (a re-read)', async () => {
    const { transport, calls } = scriptedTransport({ 'admin.user_get': () => Response.json(user()) });
    renderConsole(<UserPage userId={U1} />, { transport, roles: ['SUP'] });
    const overview = await screen.findByTestId('user-overview');
    expect(calls[0]!.headers.get('carpal-access-purpose')).toBe(PURPOSE);
    expect(screen.getByTestId('user-name')).toHaveTextContent('Sara A.');
    expect(overview).not.toHaveTextContent('sara.ahmadi@example.com');
    fireEvent.click(within(overview).getAllByRole('button', { name: 'Reveal' })[1]!);
    expect(await within(overview).findByText('sara.ahmadi@example.com')).toBeInTheDocument();
    expect(calls.filter((c) => c.opId === 'admin.user_get')).toHaveLength(2);
  });

  it('actions follow the roles: support signs out and resets onboarding but cannot suspend; no staff roles', async () => {
    const { transport, calls } = scriptedTransport({
      'admin.user_get': () => Response.json(user()),
      'admin.user_sessions_revoke': () => Response.json({ ok: true }),
    });
    renderConsole(<UserPage userId={U1} />, { transport, roles: ['SUP'] });
    await screen.findByTestId('user-overview');
    expect(screen.queryByRole('button', { name: 'Suspend the account' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reset onboarding' })).toBeInTheDocument();
    expect(screen.queryByTestId('staff-roles')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign this user out everywhere' });
    reason(dialog, 'account_compromise');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    expect(await screen.findByText('The user is signed out on every device.')).toBeInTheDocument();
    const call = calls.find((c) => c.opId === 'admin.user_sessions_revoke')!;
    expect(call.body).toEqual({ reason: 'account_compromise' });
    // Not purpose-bound (RSN only).
    expect(call.headers.get('carpal-access-purpose')).toBeNull();
  });

  it('a moderator suspends for 7 days: the end is sent and shown (BR-07)', async () => {
    let suspended = false;
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const { transport, calls } = scriptedTransport({
      'admin.user_get': () => Response.json(suspended ? user({ status: 'suspended', suspended_until: until }) : user()),
      'admin.user_status': () => {
        suspended = true;
        return Response.json(user({ status: 'suspended', suspended_until: until }));
      },
    });
    renderConsole(<UserPage userId={U1} />, { transport, roles: ['MOD'] });
    await screen.findByTestId('user-overview');
    expect(screen.queryByRole('button', { name: 'Sign out everywhere' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend the account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Suspend this account' });
    fireEvent.change(within(dialog).getByLabelText('Suspend for'), { target: { value: '7d' } });
    expect(within(dialog).getByTestId('suspend-summary')).toHaveTextContent('reactivated automatically on');
    reason(dialog, 'repeated_violations', 'third report this week');
    fireEvent.click(within(dialog).getByLabelText('I understand, and I want to go ahead'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspend the account' }));
    expect(await screen.findByText('The account is suspended and signed out everywhere.')).toBeInTheDocument();
    const body = calls.find((c) => c.opId === 'admin.user_status')!.body as { suspend_until: string };
    expect(body).toEqual({ status: 'suspended', reason: 'repeated_violations: third report this week', suspend_until: expect.any(String) });
    await waitFor(() => expect(screen.getByTestId('user-suspended-until')).toHaveTextContent('Suspended until'));
    expect(screen.getByRole('button', { name: 'Reactivate the account' })).toBeInTheDocument();
  });

  it('platform admins grant a staff role by four-eyes and revoke one at once', async () => {
    const { transport, calls } = scriptedTransport({
      'admin.user_get': () => Response.json(user({ memberships: [membership('individual'), membership('platform_support')] })),
      'admin.platform_role_grant': () =>
        Response.json(
          {
            change_id: D1,
            op_id: 'admin.platform_role_grant',
            summary: 'Grant platform_moderator to Sara A.',
            requested_by_display: 'Ali Admin',
            requested_at: ago(0),
            reason: 'new_staff: pilot moderator',
            status: 'pending',
            expires_at: ago(-3),
            decided_by_display: null,
            decided_at: null,
            decision_reason: null,
            job_id: null,
          },
          { status: 202 },
        ),
      'admin.platform_role_revoke': () => Response.json({ ok: true }),
    });
    renderConsole(<UserPage userId={U1} />, { transport, roles: ['ADM'] });
    const roles = await screen.findByTestId('staff-roles');
    expect(within(roles).getByTestId('staff-role')).toHaveTextContent('Support');
    const select = within(roles).getByLabelText('Role to give');
    expect(within(select).queryByRole('option', { name: 'Support' })).toBeNull();
    fireEvent.change(select, { target: { value: 'platform_moderator' } });
    fireEvent.click(within(roles).getByRole('button', { name: 'Request the role' }));
    let dialog = await screen.findByRole('dialog', { name: 'Give the role Moderator' });
    reason(dialog, 'new_staff', 'pilot moderator');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request the role' }));
    expect(await within(roles).findByText('Waiting for a second staff member')).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.platform_role_grant')!.body).toEqual({
      role: 'platform_moderator',
      reason: 'new_staff: pilot moderator',
    });

    fireEvent.click(within(roles).getByRole('button', { name: 'Remove the role' }));
    dialog = await screen.findByRole('dialog', { name: 'Remove the role Support' });
    reason(dialog, 'staff_left', 'moved to another team');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove the role' }));
    expect(await within(roles).findByText('Support removed.')).toBeInTheDocument();
    const revoke = calls.find((c) => c.opId === 'admin.platform_role_revoke')!;
    expect(revoke.method).toBe('DELETE');
    expect(revoke.path).toBe(`/v1/admin/users/${U1}/platform-roles/platform_support`);
    expect(revoke.headers.get('carpal-reason')).toBeTruthy();
  });

  it('a record outside the work item is explained (PURPOSE_RECORD_MISMATCH)', async () => {
    const { transport } = scriptedTransport({ 'admin.user_get': () => problem(403, 'PURPOSE_RECORD_MISMATCH') });
    renderConsole(<UserPage userId={U1} />, { transport, roles: ['SUP'] });
    expect(await screen.findByTestId('user-unavailable')).toHaveTextContent('not part of the work item');
  });

  it('a deleted account takes no actions', async () => {
    const { transport } = scriptedTransport({ 'admin.user_get': () => Response.json(user({ status: 'deleted' })) });
    renderConsole(<UserPage userId={U1} />, { transport, roles: ['ADM'] });
    expect(await screen.findByText('This account is deleted. Nothing can be changed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suspend the account' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out everywhere' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request the role' })).toBeNull();
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      const { transport } = scriptedTransport({
        'admin.user_get': () => Response.json(user({ memberships: [membership('platform_support')] })),
      });
      renderConsole(<UserPage userId={U1} />, { transport, roles: ['ADM'], locale });
      await screen.findByTestId('user-overview');
      expect(await axeViolations()).toEqual([]);
    });
  }
});
