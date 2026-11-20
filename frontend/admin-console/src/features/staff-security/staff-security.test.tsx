// AC10b.T2/T4 DOM tests: the Security keys and recovery codes page (own keys, a backup key through the browser's key
// prompt, removing one, new recovery codes shown once; after a step-up the action is not repeated by itself), the
// Recovery requests queue (approve with the verification method and a note for "other", reject, the server's refusals
// explained), the account notices (post-recovery restriction, no codes left), and axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffMe, StaffPasskey, StaffRecoveryRequest } from '@carpal/api-contracts';
import { axeViolations, page, problem, renderConsole, scriptedTransport, staffView } from '../../../tests/support/console-harness';
import { nav, resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { approveBody, checkApprove, recoveryActions, roleCodes } from './recovery-logic';
import { RecoveriesPage } from './recoveries-page';
import { SecurityPage, sortKeys } from './security-page';
import { StaffAccountNotices } from './staff-me';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const webauthn = vi.hoisted(() => ({ startRegistration: vi.fn(async () => ({ id: 'new-cred', type: 'public-key' })) }));
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startAuthentication: vi.fn(),
  startRegistration: webauthn.startRegistration,
}));

const R1 = '0193a3c4-5d6e-7f80-9a1b-0000000000a1';
const R2 = '0193a3c4-5d6e-7f80-9a1b-0000000000a2';
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const soon = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const STEP_UP = { 'www-authenticate': 'DPoP error="insufficient_user_authentication", acr_values="aal3", max_age=300' };

function key(id: string, o: Partial<StaffPasskey> = {}): StaffPasskey {
  return { id, label: `Key ${id}`, created_at: ago(48), last_used_at: ago(1), device_bound: true, aaguid: null, ...o };
}

function me(o: Partial<StaffMe> = {}): StaffMe {
  return {
    user_id: 'staff-1',
    display_name: 'Sara Staff',
    email: 'sara@staff.carpals.test',
    locale: 'en',
    timezone: 'Asia/Tehran',
    platform_roles: ['platform_admin'],
    acr: 'aal3',
    auth_time: ago(0.01),
    session_expires_at: soon(8),
    recovery_codes_remaining: 10,
    restricted_until: null,
    ...o,
  };
}

function request(id: string, o: Partial<StaffRecoveryRequest> = {}): StaffRecoveryRequest {
  return {
    id,
    user_id: 'u-9',
    display_name: 'Reza Moderator',
    email_masked: 'r***@staff.carpals.test',
    platform_roles: ['platform_moderator'],
    status: 'awaiting_approvals',
    password_forgotten: false,
    requested_at: ago(2),
    expires_at: soon(22),
    ip_country: null,
    approvals: 0,
    approved_by_me: false,
    decisions: [],
    completed_at: null,
    restricted_until: null,
    ...o,
  };
}

const CODES = Array.from({ length: 10 }, (_, i) => `QQQQ-WWWW-EEEE-RRRR-TTT${i}`);

beforeEach(() => {
  resetNav('/security');
  webauthn.startRegistration.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('Security keys and recovery codes (AC10b.T2)', () => {
  it('lists own keys (sign-in keys first) and the codes left; the only sign-in key cannot be removed', async () => {
    const { transport } = scriptedTransport({
      'admin.staff_passkeys_list': () => Response.json({ passkeys: [key('k2', { device_bound: false, label: 'Synced' }), key('k1')] }),
      'admin.staff_me': () => Response.json(me({ recovery_codes_remaining: 7 })),
    });
    renderConsole(<SecurityPage />, { transport, roles: ['MOD'] });
    const keys = await screen.findAllByTestId('security-key');
    expect(keys.map((k) => k.getAttribute('data-key'))).toEqual(['k1', 'k2']);
    expect(within(keys[0]!).getByRole('button', { name: 'Remove Key k1' })).toBeDisabled();
    expect(within(keys[1]!).getByText('This key syncs across devices and cannot sign in to the admin console.')).toBeInTheDocument();
    expect(
      screen.getByText('You have one key that can sign in. Add a backup key, so a lost key does not lock you out.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Unused recovery codes: 7 of 10.')).toBeInTheDocument();
  });

  it('adds a backup key: a name, the browser prompt, then stored; no reason is asked', async () => {
    const sent: { op: string; body: unknown }[] = [];
    let list = [key('k1')];
    const { transport } = scriptedTransport({
      'admin.staff_passkeys_list': () => Response.json({ passkeys: list }),
      'admin.staff_me': () => Response.json(me()),
      'admin.staff_passkey_register_options': (_r, body) => {
        sent.push({ op: 'options', body });
        return Response.json({ challenge: 'c', rp: { id: 'localhost' } });
      },
      'admin.staff_passkey_register': (_r, body) => {
        sent.push({ op: 'register', body });
        list = [key('k1'), key('k3', { label: 'Blue USB key' })];
        return Response.json(key('k3', { label: 'Blue USB key' }), { status: 201 });
      },
    });
    renderConsole(<SecurityPage />, { transport });
    await screen.findAllByTestId('security-key');
    fireEvent.click(screen.getByRole('button', { name: 'Add backup key' }));
    expect(screen.getByText('Give the key a name.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name of the key'), { target: { value: ' Blue USB key ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add backup key' }));
    expect(await screen.findByTestId('security-added')).toHaveTextContent('Backup key "Blue USB key" added. Your other sessions ended.');
    expect(sent).toEqual([
      { op: 'options', body: { label: 'Blue USB key' } },
      { op: 'register', body: { attestation: { id: 'new-cred', type: 'public-key' } } },
    ]);
    expect(webauthn.startRegistration).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getAllByTestId('security-key')).toHaveLength(2));
  });

  it('a stale sign-in asks for the key; back on the page nothing is sent again until the button is pressed', async () => {
    const sent: string[] = [];
    const { transport } = scriptedTransport({
      'admin.staff_passkeys_list': () => Response.json({ passkeys: [key('k1')] }),
      'admin.staff_me': () => Response.json(me()),
      'admin.staff_passkey_register_options': () => {
        sent.push('options');
        return problem(401, 'STEP_UP_REQUIRED', STEP_UP);
      },
    });
    const first = renderConsole(<SecurityPage />, { transport });
    await screen.findAllByTestId('security-key');
    fireEvent.change(screen.getByLabelText('Name of the key'), { target: { value: 'Spare key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add backup key' }));
    expect(await screen.findByRole('dialog', { name: "Confirm it's you" })).toBeInTheDocument();
    expect(webauthn.startRegistration).not.toHaveBeenCalled();
    first.unmount();

    // Back from /bff/reauth: the saved action is taken once and only arms the page.
    const intent = { id: 'i-1', type: 'security.add_key', target: null, return_to: '/' };
    renderConsole(<SecurityPage />, {
      transport,
      session: staffView(['ADM'], { intents: [intent] }),
      consume: () => ({ ...intent, draft: { label: 'Spare key' } }),
    });
    expect(await screen.findByTestId('security-armed')).toHaveTextContent('Press "Add backup key" again within 5 minutes.');
    expect(screen.getByLabelText('Name of the key')).toHaveValue('Spare key');
    expect(sent).toEqual(['options']);
  });

  it('new recovery codes: confirm, shown once, then gone; the codes left are read again', async () => {
    let remaining = 0;
    const { transport, calls } = scriptedTransport({
      'admin.staff_passkeys_list': () => Response.json({ passkeys: [key('k1'), key('k2')] }),
      'admin.staff_me': () => Response.json(me({ recovery_codes_remaining: remaining })),
      'admin.staff_recovery_codes_regenerate': () => {
        remaining = 10;
        return Response.json({ recovery_codes: CODES, created_at: new Date().toISOString() });
      },
    });
    renderConsole(<SecurityPage />, { transport });
    await screen.findByText('Unused recovery codes: 0 of 10.');
    fireEvent.click(screen.getByRole('button', { name: 'New recovery codes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Make new recovery codes?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'New recovery codes' }));
    expect((await screen.findAllByTestId('recovery-code')).map((c) => c.textContent)).toEqual(CODES);
    expect(calls.find((c) => c.opId === 'admin.staff_recovery_codes_regenerate')!.body).toBeNull();
    fireEvent.click(screen.getByLabelText('I have stored them'));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Unused recovery codes: 10 of 10.')).toBeInTheDocument();
    expect(screen.queryAllByTestId('recovery-code')).toEqual([]);
  });

  it('explains LAST_PASSKEY and the key limit', async () => {
    const { transport } = scriptedTransport({
      'admin.staff_passkeys_list': () => Response.json({ passkeys: [key('k1'), key('k2', { device_bound: false })] }),
      'admin.staff_me': () => Response.json(me()),
      'admin.staff_passkey_remove': () => problem(409, 'LAST_PASSKEY'),
      'admin.staff_passkey_register_options': () =>
        Response.json({ code: 'INVALID_TRANSITION', title: 'x', detail: 'passkey_limit' }, { status: 409 }),
    });
    renderConsole(<SecurityPage />, { transport });
    const keys = await screen.findAllByTestId('security-key');
    fireEvent.click(within(keys[1]!).getByRole('button', { name: /Remove/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove this security key?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByTestId('security-failed')).toHaveTextContent('This is your only security key that can sign in.');
    fireEvent.change(screen.getByLabelText('Name of the key'), { target: { value: 'Eleventh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add backup key' }));
    await waitFor(() =>
      expect(screen.getByTestId('security-failed')).toHaveTextContent('You have 10 keys, the most an account can have. Remove one first.'),
    );
  });

  it.each<Locale>(['en', 'fa'])('axe: no violations (%s)', async (locale) => {
    const { transport } = scriptedTransport({
      'admin.staff_passkeys_list': () => Response.json({ passkeys: [key('k1'), key('k2')] }),
      'admin.staff_me': () => Response.json(me()),
    });
    renderConsole(<SecurityPage />, { transport, locale });
    await screen.findAllByTestId('security-key');
    expect(await axeViolations()).toEqual([]);
  });

  it('sorts keys: sign-in keys first, newest first', () => {
    const keys = [
      key('a', { created_at: ago(5) }),
      key('b', { created_at: ago(1), device_bound: false }),
      key('c', { created_at: ago(1) }),
    ];
    expect(sortKeys(keys).map((k) => k.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('Recovery requests (AC10b.T4)', () => {
  beforeEach(() => resetNav('/recoveries'));

  it('lists waiting requests; approving needs the check method, a note for "other" and a reason', async () => {
    resetNav(`/recoveries?request=${R1}`);
    let approved = false;
    const sent: unknown[] = [];
    const { transport, calls } = scriptedTransport({
      'admin.staff_me': () => Response.json(me()),
      'admin.staff_recoveries_list': () => page([request(R1, approved ? { approvals: 1, approved_by_me: true } : {}), request(R2)]),
      'admin.staff_recovery_get': () =>
        Response.json(
          approved
            ? request(R1, {
                approvals: 1,
                approved_by_me: true,
                decisions: [
                  {
                    decided_by_display: 'Sara Staff',
                    decision: 'approve',
                    reason: 'identity_verified',
                    verification_method: 'other',
                    note: 'Met at the office gate',
                    decided_at: new Date().toISOString(),
                  },
                ],
              })
            : request(R1),
        ),
      'admin.staff_recovery_approve': (_r, body) => {
        sent.push(body);
        approved = true;
        return Response.json(request(R1, { approvals: 1, approved_by_me: true }));
      },
    });
    renderConsole(<RecoveriesPage />, { transport, roles: ['ADM'] });
    const table = await screen.findByRole('table', { name: 'Recovery requests' });
    expect(await within(table).findAllByRole('button', { name: 'Reza Moderator' })).toHaveLength(2);
    expect(calls.find((c) => c.opId === 'admin.staff_recoveries_list')!.search).toBe('?status=awaiting_approvals&limit=50');
    const detail = await screen.findByTestId('recovery-detail');
    expect(within(detail).getByText('r***@staff.carpals.test')).toBeInTheDocument();
    expect(within(detail).getByText('Moderator')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve the recovery' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(within(dialog).getByText('Choose how you checked the person.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText('Other (describe it)'));
    expect(within(dialog).getByText('Describe how you checked the person.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Note on the check (required)'), { target: { value: 'Met at the office gate' } });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'identity_verified' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approval recorded.')).toBeInTheDocument();
    expect(sent).toEqual([{ reason: 'identity_verified', verification_method: 'other', note: 'Met at the office gate' }]);
    expect(await screen.findByTestId('recovery-mine')).toHaveTextContent('You approved this request.');
    expect(within(screen.getByTestId('recovery-decisions')).getByText(/Met at the office gate/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('explains the server refusals: own request, post-recovery restriction', async () => {
    resetNav(`/recoveries?request=${R1}`);
    let answer = problem(403, 'SELF_APPROVAL_FORBIDDEN');
    const { transport } = scriptedTransport({
      'admin.staff_me': () => Response.json(me({ restricted_until: soon(10) })),
      'admin.staff_recoveries_list': () => page([request(R1)]),
      'admin.staff_recovery_get': () => Response.json(request(R1)),
      'admin.staff_recovery_reject': () => answer,
    });
    renderConsole(<RecoveriesPage />, { transport, roles: ['ADM'] });
    await screen.findByTestId('recovery-detail');
    expect(await screen.findByText(/approvals, role changes and staff re-enabling are blocked/)).toBeInTheDocument();
    const reject = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
      const dialog = await screen.findByRole('dialog', { name: 'Reject the recovery' });
      fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'suspicious_request' } });
      fireEvent.change(within(dialog).getByLabelText('Note (required)'), { target: { value: 'Nobody called us' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    };
    await reject();
    expect(await screen.findByText('This is your own recovery request: other administrators decide it.')).toBeInTheDocument();
    answer = problem(403, 'STAFF_RECOVERY_RESTRICTED');
    await reject();
    await waitFor(() => expect(screen.getAllByText(/approvals, role changes and staff re-enabling are blocked/).length).toBeGreaterThan(1));
  });

  it('a closed request offers nothing; a request not found says so', async () => {
    resetNav(`/recoveries?request=${R2}`);
    const { transport } = scriptedTransport({
      'admin.staff_me': () => Response.json(me()),
      'admin.staff_recoveries_list': () => page([]),
      'admin.staff_recovery_get': () =>
        Response.json(request(R2, { status: 'completed', completed_at: ago(1), restricted_until: soon(71) })),
    });
    renderConsole(<RecoveriesPage />, { transport, roles: ['ADM'] });
    expect(await screen.findByText('This request is Completed; nothing more to decide.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(nav.search).toBe(`request=${R2}`);
  });

  it.each<Locale>(['en', 'fa'])('axe: no violations (%s)', async (locale) => {
    resetNav(`/recoveries?request=${R1}`);
    const { transport } = scriptedTransport({
      'admin.staff_me': () => Response.json(me()),
      'admin.staff_recoveries_list': () => page([request(R1)]),
      'admin.staff_recovery_get': () => Response.json(request(R1)),
    });
    renderConsole(<RecoveriesPage />, { transport, locale, roles: ['ADM'] });
    await screen.findByTestId('recovery-detail');
    expect(await axeViolations()).toEqual([]);
  });

  it('rules: actions by state, approve body, role codes', () => {
    expect(recoveryActions({ status: 'awaiting_approvals', approved_by_me: false })).toEqual({ approve: true, reject: true });
    expect(recoveryActions({ status: 'awaiting_approvals', approved_by_me: true })).toEqual({ approve: false, reject: true });
    expect(recoveryActions({ status: 'approved', approved_by_me: true })).toEqual({ approve: false, reject: true });
    expect(recoveryActions({ status: 'completed', approved_by_me: false })).toEqual({ approve: false, reject: false });
    expect(checkApprove({ method: '', note: '' })).toEqual({ method: 'required' });
    expect(checkApprove({ method: 'other', note: ' ' })).toEqual({ note: 'required' });
    expect(checkApprove({ method: 'in_person', note: '' })).toEqual({});
    expect(approveBody({ method: 'video_call', note: '  ' }, 'identity_verified')).toEqual({
      reason: 'identity_verified',
      verification_method: 'video_call',
    });
    expect(roleCodes(['platform_admin', 'platform_x', 'platform_community_reviewer'])).toEqual(['ADM', 'CRV']);
  });
});

describe('account notices (AC10b.T1/T4)', () => {
  it('shows the restriction while it runs and a prompt when no recovery code is left', async () => {
    resetNav('/');
    const { transport } = scriptedTransport({
      'admin.staff_me': () => Response.json(me({ restricted_until: soon(70), recovery_codes_remaining: 0 })),
    });
    renderConsole(<StaffAccountNotices />, { transport });
    expect(await screen.findByTestId('restricted-banner')).toHaveTextContent('Your account was recovered recently');
    const prompt = screen.getByTestId('no-codes-banner');
    expect(within(prompt).getByRole('link', { name: 'Make new recovery codes' })).toHaveAttribute('href', '/security');
  });

  it('shows nothing for a member with codes and no restriction', async () => {
    resetNav('/');
    const { transport, calls } = scriptedTransport({ 'admin.staff_me': () => Response.json(me({ restricted_until: ago(1) })) });
    renderConsole(<StaffAccountNotices />, { transport });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByTestId('account-notices')).toBeNull();
  });
});
