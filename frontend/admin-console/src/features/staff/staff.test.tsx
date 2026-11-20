// AC14.T2 tests of Staff & permissions: the directory with filters in the query, the missing invite and access
// requests said on screen, a disable with a reason that applies at once (never oneself), enabling filed for a second
// admin, role grant (four-eyes) and removal; axe in EN and FA.
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingChange, StaffMember } from '@carpal/api-contracts';
import { axeViolations, page, renderConsole, scriptedTransport, staffView } from '../../../tests/support/console-harness';
import { resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { missingRoles, StaffPage } from './staff-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const ME = '0193a3c4-5d6e-7f80-9a1b-0000000000a0';
const M1 = '0193a3c4-5d6e-7f80-9a1b-0000000000a1';
const M2 = '0193a3c4-5d6e-7f80-9a1b-0000000000a2';

const member = (user_id: string, o: Partial<StaffMember> = {}): StaffMember => ({
  user_id,
  display_name: 'Reza Moderator',
  platform_roles: ['platform_moderator'],
  status: 'active',
  email_masked: 'r***@carpal.test',
  account_status: 'active',
  passkey_count: 2,
  last_sign_in_at: new Date(Date.now() - 3_600_000).toISOString(),
  ...o,
});

const pending = (op_id: string): PendingChange => ({
  change_id: '0193a3c4-5d6e-7f80-9a1b-0000000000bb',
  op_id,
  summary: 'Enable staff',
  requested_by_display: 'Sara Staff',
  requested_at: new Date().toISOString(),
  reason: 'staff_returned: back from leave',
  status: 'pending',
  expires_at: new Date(Date.now() + 72 * 3_600_000).toISOString(),
  decided_by_display: null,
  decided_at: null,
  decision_reason: null,
  job_id: null,
});

const reason = (dialog: HTMLElement, code: string, note: string) => {
  fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: code } });
  fireEvent.change(within(dialog).getByLabelText(/^Note/), { target: { value: note } });
};

const session = staffView(['ADM'], { id: ME });

beforeEach(() => resetNav('/staff'));
afterEach(() => vi.unstubAllGlobals());

describe('Staff & permissions (AC14.T2)', () => {
  it('lists staff with filters and says what is not offered', async () => {
    resetNav('/staff?role=platform_admin&status=active');
    const { transport, calls } = scriptedTransport({
      'admin.staff_list': () =>
        page([
          member(ME, { display_name: 'Sara Staff', platform_roles: ['platform_admin'] }),
          member(M1, { passkey_count: 0, last_sign_in_at: null }),
        ]),
    });
    renderConsole(<StaffPage />, { transport, session });
    const table = await screen.findByRole('table', { name: 'Staff members' });
    expect(await within(table).findByText('(you)')).toBeInTheDocument();
    expect(within(table).getByText('No key')).toBeInTheDocument();
    expect(within(table).getByText('Never')).toBeInTheDocument();
    expect(within(table).getAllByText('r***@carpal.test')).toHaveLength(2);
    expect(screen.getByTestId('staff-gaps')).toHaveTextContent('Invitations and staff access requests');
    expect(screen.queryByRole('button', { name: /invite/i })).toBeNull();
    const q = new URLSearchParams(calls[0]!.search);
    expect(q.get('role')).toBe('platform_admin');
    expect(q.get('status')).toBe('active');
    expect(q.get('limit')).toBe('100');
  });

  it('cannot disable oneself', async () => {
    resetNav(`/staff?member=${ME}`);
    const { transport } = scriptedTransport({
      'admin.staff_list': () => page([member(ME, { display_name: 'Sara Staff', platform_roles: ['platform_admin'] })]),
    });
    renderConsole(<StaffPage />, { transport, session });
    const panel = await screen.findByTestId('staff-member');
    expect(within(panel).getByTestId('staff-self')).toHaveTextContent('You cannot disable your own account');
    expect(within(panel).queryByRole('button', { name: 'Disable' })).toBeNull();
  });

  it('disables a member at once with a reason and a note', async () => {
    resetNav(`/staff?member=${M1}`);
    const { transport, calls } = scriptedTransport({
      'admin.staff_list': () => page([member(M1)]),
      'admin.staff_disable': () => Response.json(member(M1, { status: 'disabled' })),
    });
    renderConsole(<StaffPage />, { transport, session });
    const panel = await screen.findByTestId('staff-member');
    fireEvent.click(within(panel).getByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disable Reza Moderator' });
    expect(within(dialog).getByText(/requester disabled/)).toBeInTheDocument();
    reason(dialog, 'staff_left', 'Contract ended');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable' }));
    expect(await within(panel).findByText('Reza Moderator is disabled.')).toBeInTheDocument();
    const post = calls.find((c) => c.opId === 'admin.staff_disable')!;
    expect(post.method).toBe('POST');
    expect(post.path).toBe(`/v1/admin/staff/${M1}/disable`);
    expect(post.body).toEqual({ reason: 'staff_left: Contract ended' });
  });

  it('asks a second admin to enable a disabled member; roles of a disabled member cannot be changed', async () => {
    resetNav(`/staff?member=${M2}`);
    const { transport, calls } = scriptedTransport({
      'admin.staff_list': () => page([member(M2, { status: 'disabled' })]),
      'admin.staff_enable': () => Response.json(pending('admin.staff_enable'), { status: 202 }),
    });
    renderConsole(<StaffPage />, { transport, session });
    const panel = await screen.findByTestId('staff-member');
    expect(within(panel).getByText(/Moderator \(suspended\)/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Remove the role' })).toBeNull();
    expect(within(panel).queryByLabelText('Role to give')).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Request enable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Enable Reza Moderator again' });
    reason(dialog, 'staff_returned', 'Back from leave');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request enable' }));
    expect(await within(panel).findByText('Waiting for a second staff member')).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.staff_enable')!.path).toBe(`/v1/admin/staff/${M2}/enable`);
  });

  it('grants a role by four-eyes and removes one at once', async () => {
    resetNav(`/staff?member=${M1}`);
    const { transport, calls } = scriptedTransport({
      'admin.staff_list': () => page([member(M1)]),
      'admin.platform_role_grant': () => Response.json(pending('admin.platform_role_grant'), { status: 202 }),
      'admin.platform_role_revoke': () => Response.json({}),
    });
    renderConsole(<StaffPage />, { transport, session });
    const panel = await screen.findByTestId('staff-member');
    const select = within(panel).getByLabelText('Role to give');
    expect(within(select).queryByRole('option', { name: 'Moderator' })).toBeNull();
    fireEvent.change(select, { target: { value: 'platform_support' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Request the role' }));
    let dialog = await screen.findByRole('dialog', { name: 'Give the role Support' });
    reason(dialog, 'role_change', 'Covers the support inbox');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request the role' }));
    expect(await within(panel).findByText('Waiting for a second staff member')).toBeInTheDocument();
    expect(calls.find((c) => c.opId === 'admin.platform_role_grant')!.body).toEqual({
      role: 'platform_support',
      reason: 'role_change: Covers the support inbox',
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove the role' }));
    dialog = await screen.findByRole('dialog', { name: 'Remove the role Moderator' });
    reason(dialog, 'role_change', 'Moves to support');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove the role' }));
    expect(await within(panel).findByText('Moderator removed.')).toBeInTheDocument();
    const del = calls.find((c) => c.opId === 'admin.platform_role_revoke')!;
    expect(del.method).toBe('DELETE');
    expect(del.path).toBe(`/v1/admin/users/${M1}/platform-roles/platform_moderator`);
  });

  it('missingRoles keeps the contract order', () => {
    expect(missingRoles({ platform_roles: ['platform_support'] })).toEqual([
      'platform_admin',
      'platform_moderator',
      'platform_community_reviewer',
    ]);
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    it(`axe: no violations (${locale})`, async () => {
      resetNav(`/staff?member=${M1}`);
      const { transport } = scriptedTransport({ 'admin.staff_list': () => page([member(M1), member(M2, { status: 'disabled' })]) });
      renderConsole(<StaffPage />, { transport, session, locale });
      await screen.findByTestId('staff-member');
      expect(await axeViolations()).toEqual([]);
    });
  }
});

describe('a linked member (AC14.T2)', () => {
  it('is looked up across pages when not on the page on screen', async () => {
    resetNav(`/staff?member=${M2}`);
    const { transport, calls } = scriptedTransport({
      'admin.staff_list': (req) =>
        req.search.includes('cursor=p2') ? page([member(M2, { display_name: 'Late Joiner' })]) : page([member(M1)], 'p2'),
    });
    renderConsole(<StaffPage />, { transport, session });
    const panel = await screen.findByTestId('staff-member');
    expect(panel).toHaveAttribute('data-member', M2);
    expect(calls.some((c) => c.search.includes('cursor=p2'))).toBe(true);
  });

  it('says so when nobody has the link', async () => {
    resetNav(`/staff?member=${ME}`);
    const { transport } = scriptedTransport({ 'admin.staff_list': () => page([member(M1)]) });
    renderConsole(<StaffPage />, { transport, session });
    expect(await screen.findByTestId('staff-not-found')).toBeInTheDocument();
  });
});
