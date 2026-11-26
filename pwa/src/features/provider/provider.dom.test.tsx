// PW1 (DOM): CarPal Workshop shell and Today. A provider_staff member and a provider_owner both reach Today (staff
// never ask for the P+ reads); a user without a provider business sees no provider data, only the set-up entry; the
// business switch follows ?org= and the switch panel; the bell and the list read the active business's notifications
// only; the entry page offers the hosted sign-in to guests.
import type { Appointment, Membership } from '@carpal/api-contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '../../../tests/support/next-navigation';
import { guest, renderApp, signedIn, type Handlers } from '../../../tests/support/render-app';
import { AccountMenu } from '@/components/shell/header-menus';
import { BUNDLED } from '@/lib/i18n/dictionary';
import { WorkshopProvider } from './context';
import { WorkshopEntry } from './entry';
import { WorkshopNotifications } from './notifications';
import { WorkshopFrame, WorkshopGate } from './shell';
import { WorkshopToday } from './today';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));
vi.mock('next/link', () => import('../../../tests/support/next-link'));
vi.mock('@/lib/browser-nav', () => ({ goTo: vi.fn() }));

const EN = BUNDLED.en.provider;
const ORG_A = '0195f3b1-6a2b-7c3d-8e4f-0000000000a1';
const ORG_B = '0195f3b1-6a2b-7c3d-8e4f-0000000000b2';

const membership = (role: Membership['role'], orgId = ORG_A, name = 'Reza Auto Suspension'): Membership =>
  ({
    id: `m-${orgId}-${role}`,
    created_at: '',
    updated_at: '',
    version: 1,
    role,
    status: 'active',
    joined_at: '2026-11-01T10:00:00Z',
    organization: {
      id: orgId,
      name,
      organization_type: 'provider',
      slug: null,
      logo_url: null,
      status: 'active',
      verification_status: 'pending',
    },
  }) as Membership;

const appointment = (o: Partial<Appointment> = {}): Appointment =>
  ({
    id: 'apt-1',
    status: 'confirmed',
    safety_flag: false,
    urgency_level: 'medium',
    created_at: '2026-11-25T06:00:00Z',
    confirmed_start_at: '2026-11-26T08:00:00Z',
    proposed_start_at: null,
    estimated_duration_minutes: 180,
    vehicle: {
      id: 'v',
      brand: { text: 'BMW', locale: 'en' },
      model: { text: '320i', locale: 'en' },
      series: { text: 'E90', locale: 'en' },
      year: 2012,
      nickname: null,
    },
    service_task: { text: 'Rear shock absorbers', locale: 'en' },
    service_system: null,
    symptom: null,
    ...o,
  }) as Appointment;

/** The counter tile (a link) with this label; tab labels share some words. */
const tile = (label: string) =>
  screen
    .getAllByText(label)
    .map((el) => el.closest('a.bui-counter'))
    .find(Boolean) as HTMLElement;

const page = <T,>(items: T[], next: string | null = null) => ({ items, next_cursor: next });

function handlers(memberships: Membership[], extra: Handlers = {}): Handlers {
  return {
    'me.memberships_list': () => page(memberships),
    'provider.profile_get': () => ({ measured_response_time_minutes: 130, completeness_gaps: ['hours_set', 'reviews_received'] }),
    'provider.appointments_list': (a) => {
      const group = (a.query as { group?: string }).group;
      if (group === 'new')
        return page([
          appointment({ id: 'n1', status: 'requested', urgency_level: 'safety_critical', created_at: '2026-11-25T08:00:00Z' }),
          appointment({ id: 'n2', status: 'requested' }),
        ]);
      if (group === 'today')
        return page([
          appointment({ id: 't1', confirmed_start_at: '2026-11-26T10:00:00Z', service_task: { text: 'Inspection', locale: 'en' } }),
          appointment({ id: 't2', safety_flag: true, confirmed_start_at: '2026-11-26T12:00:00Z' }),
        ]);
      if (group === 'closed') return page([appointment({ id: 'c1', status: 'completed' })]);
      return page([]);
    },
    'reviews.org_list': () => page([{ id: 'r1' }]),
    'review_approvals.list': () => page([{ id: 'ap1' }]),
    'provider.portfolio_list': () => page([{ appointment_id: 'other', customer_consent_status: 'requested', status: 'draft' }]),
    'notifications.unread_count': () => ({ count: 2 }),
    ...extra,
  };
}

function renderWorkshop(memberships: Membership[], extra: Handlers = {}) {
  return renderApp(
    <WorkshopProvider>
      <WorkshopFrame>
        <WorkshopGate>
          <WorkshopToday />
        </WorkshopGate>
      </WorkshopFrame>
    </WorkshopProvider>,
    { locale: 'en', session: signedIn('Reza'), handlers: handlers(memberships, extra) },
  );
}

beforeEach(() => navigation.reset('/en/provider/today'));
afterEach(() => localStorage.clear());

describe('Today (PW-HOME-01)', () => {
  it('lets a provider_staff member reach Today without asking for the P+ reads', async () => {
    const { api } = renderWorkshop([membership('provider_staff')]);
    expect(await screen.findByRole('heading', { name: EN.today.title })).toBeTruthy();
    const opIds = () => api.calls.map((c) => c.opId);
    await waitFor(() => expect(opIds()).toContain('reviews.org_list'));
    expect(opIds()).not.toContain('review_approvals.list');
    expect(opIds()).not.toContain('provider.insights_get');
    // Every provider read names the active business.
    for (const c of api.calls.filter((x) => x.opId.startsWith('provider.') || x.opId.startsWith('review')))
      expect((c.args.path as { org_id: string }).org_id).toBe(ORG_A);
    expect((await screen.findByRole('button', { name: /Switch business/ })).textContent).toContain('Staff');
  });

  it('shows the counters, safety-critical first and the finish-your-profile card to an owner', async () => {
    renderWorkshop([membership('provider_owner')]);
    await screen.findByText(EN.today.newRequests);
    const newTile = tile(EN.today.newRequests);
    await waitFor(() => expect(within(newTile).getByText('2')).toBeTruthy());
    expect(within(newTile).getByText('1 safety-critical')).toBeTruthy();
    expect(within(newTile).getByText(/You usually reply in 2 h 10 min/)).toBeTruthy();
    expect(newTile.getAttribute('href')).toBe('/en/provider/requests');

    const replies = tile(EN.today.replies);
    await waitFor(() => expect(within(replies).getByText('1 review without a reply · 1 approval request')).toBeTruthy());

    const photos = tile(EN.today.photos);
    await waitFor(() => expect(within(photos).getByText('1 job ready for photos · 1 waiting for the customer')).toBeTruthy());

    const jobs = await screen.findByTestId('todays-jobs');
    const rows = within(jobs).getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain(EN.today.safetyMark);
    expect(rows[1]!.textContent).toContain('Inspection');

    expect(screen.getByRole('heading', { name: EN.today.finishTitle })).toBeTruthy();
    expect(screen.getByText(EN.today.finish.hours_set)).toBeTruthy();
    expect(screen.getByText(EN.today.verificationPending)).toBeTruthy();
  });

  it('keeps Today usable when one counter fails', async () => {
    renderWorkshop([membership('provider_owner')], {
      'reviews.org_list': () => {
        throw new Error('down');
      },
    });
    const replies = (await screen.findByText(EN.today.replies)).closest('a')!;
    await waitFor(() => expect(within(replies).getByText(EN.today.loadError)).toBeTruthy());
    expect(await screen.findByTestId('todays-jobs')).toBeTruthy();
  });
});

describe('business context (PW1.T3)', () => {
  it('shows no provider data to a user without a provider business', async () => {
    const { api } = renderWorkshop([membership('fleet_driver'), membership('vendor_staff', ORG_B, 'Parts shop')]);
    expect(await screen.findByRole('heading', { name: EN.gate.noBusinessTitle })).toBeTruthy();
    expect(screen.getByRole('link', { name: EN.gate.start }).getAttribute('href')).toBe('/en/provider/start');
    expect(api.calls.map((c) => c.opId)).toEqual(['me.memberships_list']);
    expect(screen.queryByRole('navigation', { name: EN.tabs.label })).toBeNull();
  });

  it('opens the business named in the address and switches from the top bar', async () => {
    navigation.reset(`/en/provider/today?org=${ORG_B}`);
    renderWorkshop([membership('provider_owner'), membership('provider_staff', ORG_B, 'Second Shop')]);
    const switchButton = await screen.findByRole('button', { name: /Switch business/ });
    expect(switchButton.textContent).toContain('Second Shop');
    fireEvent.click(switchButton);
    fireEvent.click(screen.getByRole('button', { name: /Reza Auto Suspension/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Switch business/ }).textContent).toContain('Reza Auto Suspension'));
    expect(screen.getByRole('link', { name: /Personal/ }).getAttribute('href')).toBe('/en/home');
  });

  it('has the four Workshop tabs and a bell that counts this business only', async () => {
    const { api } = renderWorkshop([membership('provider_owner')]);
    const tabs = await screen.findByRole('navigation', { name: EN.tabs.label });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/en/provider/today', '/en/provider/requests', '/en/provider/replies', '/en/provider/photos']);
    await waitFor(() => expect(api.calls.some((c) => c.opId === 'notifications.unread_count')).toBe(true));
    const unread = api.calls.find((c) => c.opId === 'notifications.unread_count')!;
    expect(unread.args.query).toEqual({ organization_id: ORG_A });
    expect(screen.getByRole('link', { name: /Notifications of Reza Auto Suspension/ }).getAttribute('href')).toBe(
      '/en/provider/notifications',
    );
  });

  it('opens the Web UI in a new tab with the business', async () => {
    renderWorkshop([membership('provider_owner')]);
    await screen.findByRole('button', { name: /Switch business/ });
    fireEvent.click(screen.getByRole('button', { name: EN.menu.label }));
    const link = screen.getByRole('link', { name: new RegExp(EN.menu.openWebUi) });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('href')).toContain(`/en/provider/dashboard?org=${ORG_A}`);
  });
});

describe('consumer account menu (PW1.T3)', () => {
  it('offers one CarPal Workshop entry per provider business once opened', async () => {
    const session = signedIn('Reza');
    const { api } = renderApp(<AccountMenu user={session.user!} />, {
      locale: 'en',
      session,
      handlers: handlers([
        membership('provider_owner'),
        membership('provider_staff', ORG_B, 'Second Shop'),
        membership('vendor_staff', 'v', 'Parts'),
      ]),
    });
    expect(api.calls.some((c) => c.opId === 'me.memberships_list')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Account menu|account/i }));
    const first = await screen.findByRole('link', { name: 'CarPal Workshop: Reza Auto Suspension' });
    expect(first.getAttribute('href')).toBe(`/en/provider/today?org=${ORG_A}`);
    expect(screen.getByRole('link', { name: 'CarPal Workshop: Second Shop' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /CarPal Workshop: Parts/ })).toBeNull();
  });
});

describe('business notifications (PW1.T6)', () => {
  it('lists this business only and opens Workshop pages', async () => {
    const { api } = renderApp(
      <WorkshopProvider>
        <WorkshopGate>
          <WorkshopNotifications />
        </WorkshopGate>
      </WorkshopProvider>,
      {
        locale: 'en',
        session: signedIn('Reza'),
        handlers: handlers([membership('provider_owner')], {
          'notifications.list': () =>
            page([
              {
                id: 'n1',
                event_type: 'appointment_request_received',
                category: 'appointments',
                priority: 'normal',
                template_key: 'appointment.request_received',
                template_params: {},
                locale: 'en',
                organization_context_id: ORG_A,
                reference: { type: 'appointment', id: 'apt-9' },
                read_at: null,
                created_at: '2026-11-25T08:00:00Z',
              },
            ]),
          'notifications.mark_read': () => ({ ok: true }),
        }),
      },
    );
    const list = await screen.findByTestId('workshop-notifications');
    expect(api.calls.find((c) => c.opId === 'notifications.list')!.args.query).toMatchObject({ organization_id: ORG_A });
    fireEvent.click(within(list).getByRole('button', { name: /New appointment request/ }));
    await waitFor(() => expect(navigation.pathname).toBe('/en/provider/requests/apt-9'));
    expect(api.calls.find((c) => c.opId === 'notifications.mark_read')!.args.body).toEqual({ ids: ['n1'] });
  });
});

describe('entry (PW-AUTH-01)', () => {
  it('offers the hosted sign-in to guests and returns them to Today, sign-up to the compact onboarding', () => {
    renderApp(<WorkshopEntry />, { locale: 'en', session: guest });
    const returnTo = (name: string) =>
      new URL(screen.getByRole('link', { name }).getAttribute('href')!, 'http://x').searchParams.get('return_to');
    // Straight back into the Workshop: not through the car owner's onboarding (PW2).
    expect(returnTo(EN.entry.signIn)).toBe('/en/provider/today');
    expect(returnTo(BUNDLED.en.shell.header.signUp)).toBe('/en/provider/start');
  });

  it('sends a signed-in user straight to Today', async () => {
    navigation.reset('/en/provider');
    renderApp(<WorkshopEntry />, { locale: 'en', session: signedIn('Reza') });
    await waitFor(() => expect(navigation.pathname).toBe('/en/provider/today'));
  });
});
