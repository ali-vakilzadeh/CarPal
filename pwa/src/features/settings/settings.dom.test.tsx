// P9.T6 (DOM): notifications (bell dropdown, open = mark read + deep link, mark all, tab filters), the step-up of an AAL2
// action (redirect with the saved intent, and the replay after coming back), consent withdrawal reflected at once,
// the notification matrix (full put, marketing consent refusal with rollback), the data export request, the profile
// name preview, and My Activity's inquiry thread ("I picked it up").
import type { ConsentRecord, Notification, NotificationPreference, StockInquiry } from '@carpal/api-contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation, router } from '../../../tests/support/next-navigation';
import { renderApp, signedIn } from '../../../tests/support/render-app';
import { ActivityScreen, InquiryDetail } from '@/features/activity';
import { NotificationsBell, NotificationsScreen } from '@/features/notifications';
import { ApiProblem } from '@/lib/api/problem';
import { goTo } from '@/lib/browser-nav';
import { SettingsScreen } from './settings-screen';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));
vi.mock('next/link', () => import('../../../tests/support/next-link'));
vi.mock('@/lib/browser-nav', () => ({ goTo: vi.fn() }));

const ID = (n: number) => `0195f3b1-6a2b-7c3d-8e4f-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type FetchHandler = (url: string, init?: RequestInit) => Response;
let fetchHandler: FetchHandler;
let intents: { url: string; body: Record<string, unknown> }[];

beforeEach(() => {
  navigation.reset('/en/settings/security');
  window.history.replaceState(null, '', '/en/settings/security');
  intents = [];
  fetchHandler = (url, init) => {
    if (url === '/bff/csrf') return json({ csrf_token: 'csrf-1' });
    if (url === '/bff/intents') {
      intents.push({ url, body: JSON.parse(String(init?.body)) });
      return json({ intent_id: 'i1' }, 201);
    }
    return json({}, 404);
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(fetchHandler(String(input), init))),
  );
  vi.mocked(goTo).mockClear();
});

afterEach(() => vi.unstubAllGlobals());

const notification = (n: number, o: Partial<Notification> = {}): Notification => ({
  id: ID(n),
  event_type: 'appointment_alternative_proposed',
  category: 'appointments',
  priority: 'normal',
  template_key: 'appointment.alternative_proposed',
  template_params: {},
  locale: 'en',
  organization_context_id: null,
  reference: { type: 'appointment', id: ID(500 + n) },
  read_at: null,
  created_at: '2026-10-30T08:00:00Z',
  ...o,
});

const stepUpProblem = () =>
  new ApiProblem(
    401,
    { code: 'STEP_UP_REQUIRED' },
    { wwwAuthenticate: 'DPoP error="insufficient_user_authentication", acr_values="aal2", max_age=600' },
  );

describe('notifications', () => {
  it('bell: unread badge, the latest 10 in the dropdown, opening one marks it read and goes to its screen', async () => {
    navigation.reset('/en/home');
    const { api } = renderApp(<NotificationsBell />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'notifications.unread_count': () => ({ count: 2 }),
        'notifications.list': () => ({
          items: [
            notification(1),
            notification(2, {
              template_key: 'vehicle.reminder_due',
              category: 'service_reminders',
              read_at: '2026-10-30T09:00:00Z',
              template_params: { reminder_type: 'oil', status: 'overdue' },
              reference: null,
            }),
          ],
          next_cursor: null,
        }),
        'notifications.mark_read': () => ({ ok: true }),
      },
    });
    const bell = await screen.findByRole('button', { name: 'Notifications, 2 unread' });
    fireEvent.click(bell);
    expect(await screen.findByText('A new time was proposed')).toBeInTheDocument();
    expect(screen.getByText('A reminder for one of your cars (oil) is overdue.')).toBeInTheDocument();
    expect(api.calls.find((c) => c.opId === 'notifications.list')?.args).toMatchObject({ query: { limit: 10 } });
    fireEvent.click(screen.getByRole('button', { name: /A new time was proposed/ }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/en/appointments/${ID(501)}`));
    expect(api.calls.find((c) => c.opId === 'notifications.mark_read')?.args).toEqual({ body: { ids: [ID(1)] } });
  });

  it('page: Mark all as read sends up_to; the System tab filters several categories in the browser', async () => {
    navigation.reset('/en/notifications');
    const { api } = renderApp(<NotificationsScreen />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'notifications.unread_count': () => ({ count: 1 }),
        'notifications.list': () => ({
          items: [
            notification(1),
            notification(2, {
              template_key: 'moderation.action_taken',
              category: 'moderation',
              template_params: { action_type: 'remove', target_type: 'comment' },
              reference: { type: 'comment', id: ID(9) },
            }),
            notification(3, {
              template_key: 'system.security_alert',
              category: 'system',
              priority: 'critical',
              template_params: { kind: 'refresh_token_reuse' },
              reference: null,
            }),
          ],
          next_cursor: null,
        }),
        'notifications.mark_read': () => ({ ok: true }),
      },
    });
    expect(await screen.findByText('A new time was proposed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() =>
      expect((api.calls.find((c) => c.opId === 'notifications.mark_read')?.args as { body: { up_to?: string } }).body.up_to).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'System' }));
    await waitFor(() => expect(screen.queryByText('A new time was proposed')).toBeNull());
    expect(screen.getByText('An update from CarPal moderation')).toBeInTheDocument();
    expect(screen.getByText('Security alert')).toBeInTheDocument();
    expect(navigation.search).toBe('tab=system');
    fireEvent.click(screen.getByRole('tab', { name: 'Reminders' }));
    await waitFor(() =>
      expect(api.calls.some((c) => (c.args as { query?: { category?: string } }).query?.category === 'service_reminders')).toBe(true),
    );
  });
});

const session = {
  id: ID(70),
  client_id: 'cp-web-consumer',
  device_label: 'Chrome on Windows',
  created_at: '2026-10-01T00:00:00Z',
  last_seen_at: '2026-10-30T08:00:00Z',
  country: 'IR',
  acr: 'aal1' as const,
  current: false,
};

describe('step-up (AAL2)', () => {
  const security = {
    'me.mfa_list': () => ({ items: [], next_cursor: null }),
    'me.sessions_list': () => ({
      items: [{ ...session, id: ID(71), device_label: 'This browser', current: true }, session],
      next_cursor: null,
    }),
  };

  it('saves the action as an intent and re-authenticates at aal2, back to this page', async () => {
    renderApp(<SettingsScreen section="security" policyVersion="2026-10" appVersion="0.1.0" />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        ...security,
        'me.sessions_revoke_all': () => {
          throw stepUpProblem();
        },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out of all other devices' }));
    await waitFor(() =>
      expect(goTo).toHaveBeenCalledWith('/bff/login?return_to=%2Fen%2Fsettings%2Fsecurity&step_up=aal2&locale=en&intent=i1'),
    );
    expect(intents[0]!.body).toMatchObject({
      type: 'settings.sessions_revoke_all',
      return_to: '/en/settings/security',
      label: "Confirm it's you to sign out other devices",
    });
  });

  it('after the step-up sign-in the action runs once and says so', async () => {
    const consumed: string[] = [];
    fetchHandler = (url) => {
      if (url === '/bff/csrf') return json({ csrf_token: 'csrf-1' });
      if (url === '/bff/intents/i1/consume') {
        consumed.push(url);
        return json({ id: 'i1', type: 'settings.sessions_revoke_all', target: null, return_to: '/en/settings/security', draft: null });
      }
      if (url === '/bff/session') return json(signedIn());
      return json({}, 404);
    };
    const revoke = vi.fn(() => ({ ok: true }));
    renderApp(<SettingsScreen section="security" policyVersion="2026-10" appVersion="0.1.0" />, {
      locale: 'en',
      session: signedIn('Sara M.', [{ id: 'i1', type: 'settings.sessions_revoke_all', target: null, return_to: '/en/settings/security' }]),
      handlers: { ...security, 'me.sessions_revoke_all': revoke },
    });
    expect(await screen.findByText('Signed out of all other devices')).toBeInTheDocument();
    expect(revoke).toHaveBeenCalledOnce();
    expect(consumed).toEqual(['/bff/intents/i1/consume']);
  });
});

describe('privacy & consent', () => {
  it('withdrawing a consent shows at once, without reading the list again', async () => {
    navigation.reset('/en/settings/privacy');
    const active: ConsentRecord = {
      id: ID(1),
      created_at: '2026-09-23T10:00:00Z',
      updated_at: '2026-09-23T10:00:00Z',
      version: 1,
      subject_type: 'user',
      subject_id: ID(99),
      consent_type: 'ai_personalization',
      scope_entity_type: null,
      scope_entity_id: null,
      granted_to_type: 'platform',
      granted_to_id: null,
      policy_version: '2026-10',
      granted: true,
      granted_at: '2026-09-23T10:00:00Z',
      withdrawn_at: null,
      expires_at: null,
      source: 'ui',
    };
    const { api } = renderApp(<SettingsScreen section="privacy" policyVersion="2026-10" appVersion="0.1.0" />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'consents.list': () => ({ items: [active], next_cursor: null }),
        'consents.withdraw': () => ({ ...active, withdrawn_at: '2026-10-30T09:00:00Z' }),
        'me.preferences_get': () => ({}),
      },
    });
    const row = within(await screen.findByTestId('consent-ai_personalization'));
    const sw = row.getByRole('switch', { name: 'AI personalisation' });
    expect(sw).toBeChecked();
    fireEvent.click(sw);
    await waitFor(() => expect(row.getByRole('switch', { name: 'AI personalisation' })).not.toBeChecked());
    expect(row.getByText(/^Withdrawn/)).toBeInTheDocument();
    expect(api.calls.filter((c) => c.opId === 'consents.list')).toHaveLength(1);
    expect(api.calls.find((c) => c.opId === 'consents.withdraw')?.args).toEqual({ path: { consent_id: ID(1) } });
  });

  it('granting records the consent with the policy version and switches the preference on', async () => {
    navigation.reset('/en/settings/privacy');
    const { api } = renderApp(<SettingsScreen section="privacy" policyVersion="2026-10" appVersion="0.1.0" />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'consents.list': () => ({ items: [], next_cursor: null }),
        'consents.grant': (a) => ({
          id: ID(2),
          consent_type: (a.body as { consent_type: string }).consent_type,
          scope_entity_type: null,
          granted_to_type: 'platform',
          granted: true,
          granted_at: '2026-10-30T09:00:00Z',
          withdrawn_at: null,
          expires_at: null,
          policy_version: '2026-10',
          created_at: '2026-10-30T09:00:00Z',
        }),
        'me.preferences_get': () => ({}),
        'me.preferences_update': (a) => a.body,
      },
    });
    fireEvent.click(await screen.findByRole('switch', { name: 'News and offers' }));
    await waitFor(() => expect(api.calls.some((c) => c.opId === 'me.preferences_update')).toBe(true));
    expect(api.calls.find((c) => c.opId === 'consents.grant')?.args).toEqual({
      body: { consent_type: 'marketing', policy_version: '2026-10' },
    });
    expect(api.calls.find((c) => c.opId === 'me.preferences_update')?.args).toEqual({ body: { marketing_opt_in: true } });
    expect(screen.getByRole('switch', { name: 'News and offers' })).toBeChecked();
  });
});

describe('notification preferences', () => {
  const prefs: NotificationPreference[] = [
    { channel: 'push', category: 'appointments', enabled: true, frequency: 'immediate' },
    { channel: 'in_app', category: 'marketing', enabled: false, frequency: 'immediate' },
    { channel: 'push', category: 'fleet', enabled: true, frequency: 'immediate' },
  ];

  it('sends every row with the change; a marketing refusal rolls back and points to the consent', async () => {
    navigation.reset('/en/settings/notifications');
    const put = vi.fn((a: Record<string, unknown>) => {
      const items = (a.body as { items: NotificationPreference[] }).items;
      if (items.some((p) => p.category === 'marketing' && p.enabled))
        throw new ApiProblem(403, { code: 'CONSENT_REQUIRED', consent_type: 'marketing' });
      return { items };
    });
    renderApp(<SettingsScreen section="notifications" policyVersion="2026-10" appVersion="0.1.0" />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'notification_prefs.get': () => ({ items: prefs }),
        'notification_prefs.put': put,
        'me.preferences_get': () => ({ critical_alerts_only: false }),
      },
    });
    const push = await screen.findByRole('checkbox', { name: 'Appointments: Push (mobile app)' });
    fireEvent.click(push);
    await waitFor(() => expect(put).toHaveBeenCalledOnce());
    const sent = (put.mock.calls[0]![0].body as { items: NotificationPreference[] }).items;
    expect(sent).toHaveLength(3);
    expect(sent[0]).toEqual({ channel: 'push', category: 'appointments', enabled: false, frequency: 'immediate' });
    expect(sent[2]).toEqual(prefs[2]); // business rows are kept as they are
    const marketing = screen.getByRole('checkbox', { name: 'Marketing: In-app' });
    fireEvent.click(marketing);
    expect(await screen.findByText(/Marketing messages need your consent first/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Marketing: In-app' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Safety and security alerts: In-app' })).toBeDisabled();
  });
});

describe('data & account and profile', () => {
  it('requests a data export and shows it as received', async () => {
    navigation.reset('/en/settings/data');
    let created = false;
    const request = {
      id: ID(30),
      created_at: '2026-10-30T09:00:00Z',
      updated_at: '2026-10-30T09:00:00Z',
      version: 1,
      request_type: 'export',
      details: null,
      status: 'received',
      requested_at: '2026-10-30T09:00:00Z',
      due_at: '2026-11-29T09:00:00Z',
      rejection_reason: null,
      completed_at: null,
      export_available: false,
    };
    const { api } = renderApp(<SettingsScreen section="data" policyVersion="2026-10" appVersion="0.1.0" />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'dsr.list': () => ({ items: created ? [request] : [], next_cursor: null }),
        'dsr.create': () => ((created = true), request),
        'me.memberships_list': () => ({ items: [], next_cursor: null }),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Request my data' }));
    expect(await screen.findByTestId('export-status')).toHaveTextContent('Received');
    expect(api.calls.find((c) => c.opId === 'dsr.create')?.args).toEqual({ body: { request_type: 'export' } });
    expect(screen.getByTestId('dsr-table')).toHaveTextContent('Data export');
    // Deletion needs the typed word.
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete your account?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete my account' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Type DELETE to confirm'), { target: { value: 'delete' } });
    expect(confirm).toBeEnabled();
  });

  it('previews the public name while typing', async () => {
    navigation.reset('/en/settings/profile');
    renderApp(<SettingsScreen section="profile" policyVersion="2026-10" appVersion="0.1.0" />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'me.get': () => ({
          id: ID(99),
          full_name: 'Sara Mohammadi',
          display_name: null,
          email: 'sara@example.com',
          phone: null,
          email_verified_at: '2026-10-01T00:00:00Z',
          phone_verified_at: null,
          locale: 'en',
        }),
      },
    });
    expect(await screen.findByText('Your reviews show: Sara M.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Display name (public)'), { target: { value: 'Sara the driver' } });
    expect(screen.getByText('Your reviews show: Sara the driver')).toBeInTheDocument();
  });
});

describe('my activity', () => {
  const inquiry = {
    id: ID(40),
    created_at: '2026-10-28T09:00:00Z',
    updated_at: '2026-10-29T09:00:00Z',
    version: 2,
    inventory_item: { id: ID(41), name: { text: 'Control arm', locale: 'en' }, sku: 'CA-1' },
    vendor: {
      id: ID(42),
      name: 'Mina Parts',
      organization_type: 'vendor',
      slug: 'mina',
      logo_url: null,
      status: 'active',
      verification_status: 'verified',
    },
    requester_type: 'user',
    requester_display: 'Sara M.',
    vehicle_context_snapshot: null,
    quantity: 1,
    status: 'reserved',
    reserved_until: '2026-11-01T09:00:00Z',
    first_response_at: '2026-10-29T09:00:00Z',
    closed_at: null,
    closed_by_side: null,
    last_message_at: '2026-10-29T09:00:00Z',
    can_review: false,
  } as unknown as StockInquiry;

  it('lists inquiries with status and opens the thread', async () => {
    navigation.reset('/en/activity');
    renderApp(<ActivityScreen />, {
      locale: 'en',
      session: signedIn(),
      handlers: { 'inquiries.list': () => ({ items: [inquiry], next_cursor: null }) },
    });
    const row = within(await screen.findByTestId('inquiry-row'));
    expect(row.getByText('Control arm', { selector: '.pwa-text-label' })).toBeInTheDocument();
    expect(row.getByText('Reserved')).toBeInTheDocument();
    expect(row.getByRole('link', { name: /Open/ })).toHaveAttribute('href', `/en/activity/inquiries/${ID(40)}`);
    fireEvent.click(screen.getByRole('tab', { name: 'Questions & answers' }));
    expect(await screen.findByRole('link', { name: 'Open Community Q&A' })).toBeInTheDocument();
  });

  it('"I picked it up" completes the inquiry', async () => {
    navigation.reset(`/en/activity/inquiries/${ID(40)}`);
    const transition = vi.fn(() => ({ ...inquiry, status: 'completed', can_review: true }));
    renderApp(<InquiryDetail inquiryId={ID(40)} />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'inquiries.get': () => ({
          inquiry,
          messages: [
            {
              id: ID(43),
              author_side: 'vendor',
              author_display: 'Mina Parts',
              body: 'In stock, reserved for you until Saturday.',
              content_locale: 'en',
              created_at: '2026-10-29T09:00:00Z',
            },
          ],
        }),
        'inquiries.transition': transition,
      },
    });
    expect(await screen.findByText('In stock, reserved for you until Saturday.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'I picked it up' }));
    expect(await screen.findByText('Marked as picked up')).toBeInTheDocument();
    expect(transition).toHaveBeenCalledWith({ path: { inquiry_id: ID(40) }, body: { to: 'completed' } });
  });
});
