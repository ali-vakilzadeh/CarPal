// AC14-2 DOM tests of the A-USR-02 tabs on the backend S23 reads: each tab reads under the page's work item (purpose
// header), Vehicles masks the VIN and plate, Appointments links the business and pages on, Consents shows the active
// consents and the history with their state, Sessions & devices lists both without tokens; the tabs follow ?tab= and
// the arrow keys; consentState; axe in EN and FA on every tab.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsentRecord, StaffAppointmentRow, StaffUserView, StaffVehicleRow } from '@carpal/api-contracts';
import { axeViolations, page, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { nav, resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { consentState } from './user-logic';
import { UserPage } from './user-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const U1 = '0193a3c4-5d6e-7f80-9a1b-0000000000b1';
const D1 = '0193a3c4-5d6e-7f80-9a1b-0000000000d1';
const O1 = '0193a3c4-5d6e-7f80-9a1b-0000000000a1';
const PURPOSE = `dsr:${D1}`;
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const url = (tab?: string) => `/users/${U1}?purpose=${encodeURIComponent(PURPOSE)}${tab ? `&tab=${tab}` : ''}`;

const user = (): StaffUserView =>
  ({
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
    memberships: [],
    subscription: { plan_key: 'individual_free', status: 'active', max_vehicles: 3, active_vehicles: 1, trial_ends_at: null },
    trusted_user: false,
    counts: { reviews: 4, reports_against: 1, open_disputes: 0 },
    suspended_until: null,
  }) as unknown as StaffUserView;

const org = {
  id: O1,
  name: 'Pars Auto',
  organization_type: 'provider',
  slug: 'pars-auto',
  logo_url: null,
  status: 'active',
  verification_status: 'verified',
} as const;
const tx = (text: string) => ({ text, locale: 'en' as const });

const vehicle: StaffVehicleRow = {
  id: '0193a3c4-5d6e-7f80-9a1b-0000000000c1',
  brand: tx('Peugeot'),
  model: tx('206'),
  series: null,
  year: 2016,
  status: 'active',
  vin_last4: '4821',
  plate_masked: '•••• 42',
  created_at: ago(40),
};

const appointment: StaffAppointmentRow = {
  id: '0193a3c4-5d6e-7f80-9a1b-0000000000e1',
  provider: org,
  requester_type: 'user',
  requester_organization: null,
  vehicle: { id: vehicle.id, brand: tx('Peugeot'), model: tx('206'), year: 2016 },
  appointment_type: 'repair',
  service_mode: 'in_shop',
  service_system: null,
  source: 'direct_search',
  urgency_level: 'high',
  safety_flag: true,
  status: 'confirmed',
  cancelled_by: null,
  created_at: ago(3),
  confirmed_start_at: ago(-1),
  completed_at: null,
};

const consent = (o: Partial<ConsentRecord> = {}): ConsentRecord => ({
  id: '0193a3c4-5d6e-7f80-9a1b-0000000000f1',
  created_at: ago(20),
  updated_at: ago(20),
  version: 1,
  subject_type: 'user',
  subject_id: U1,
  consent_type: 'service_history_sharing',
  scope_entity_type: null,
  scope_entity_id: null,
  granted_to_type: 'organization',
  granted_to_id: O1,
  granted_to_organization: org,
  policy_version: 'consent-2026-11',
  policy_version_id: null,
  confirmed_policy_version: null,
  confirmed_at: null,
  reconsent_required: false,
  paused: false,
  granted: true,
  granted_at: ago(20),
  withdrawn_at: null,
  expires_at: null,
  source: 'ui',
  ...o,
});

const sessions = {
  sessions: [
    {
      id: '0193a3c4-5d6e-7f80-9a1b-000000000101',
      client_id: 'cp-mobile',
      device_label: 'Pixel 8',
      created_at: ago(2),
      last_seen_at: ago(0),
      country: 'IR',
      acr: 'aal2',
      staff: false,
    },
  ],
  sessions_total: 140,
  push_devices: [
    {
      id: '0193a3c4-5d6e-7f80-9a1b-000000000201',
      platform: 'android',
      app_version: '1.4.0',
      locale: 'fa',
      status: 'active',
      created_at: ago(30),
      last_seen_at: ago(1),
    },
  ],
};

const handlers = () =>
  scriptedTransport({
    'admin.user_get': () => Response.json(user()),
    'admin.user_vehicles': () => page([vehicle]),
    'admin.user_appointments': (req) =>
      req.search.includes('cursor=') ? page([{ ...appointment, id: 'x2', provider: null }]) : page([appointment], 'c2'),
    'admin.user_consents': (req) =>
      req.search.includes('active=true')
        ? page([consent()])
        : page([
            consent(),
            consent({
              id: 'w1',
              consent_type: 'marketing',
              granted_to_type: null,
              granted_to_organization: null,
              withdrawn_at: ago(5),
              source: 'admin',
            }),
          ]),
    'admin.user_sessions': () => Response.json(sessions),
  });

beforeEach(() => resetNav(url()));

describe('A-USR-02 tabs (AC14-2)', () => {
  it('opens on Overview; a tab follows ?tab= and the arrow keys', async () => {
    const { transport } = handlers();
    renderConsole(<UserPage userId={U1} />, { transport, roles: ['SUP'] });
    const tab = await screen.findByRole('tab', { name: 'Overview' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tab, { key: 'ArrowRight' });
    await waitFor(() => expect(nav.search).toContain('tab=roles'));
    expect(screen.getByRole('tab', { name: 'Roles & organizations' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('user-memberships')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Roles & organizations' }), { key: 'End' });
    expect(await screen.findByTestId('user-sessions')).toBeInTheDocument();
    expect(screen.getByText('Privacy requests')).toBeInTheDocument();
  });

  it('Vehicles: read for the purpose, VIN and plate masked', async () => {
    resetNav(url('vehicles'));
    const { transport, calls } = handlers();
    renderConsole(<UserPage userId={U1} />, { transport, roles: ['MOD'] });
    const tab = await screen.findByTestId('user-vehicles');
    const row = (await within(tab).findByText('Peugeot')).closest('tr')!;
    expect(row).toHaveTextContent('•••• 4821');
    expect(row).toHaveTextContent('•••• 42');
    expect(row).toHaveTextContent('Active');
    const call = calls.find((c) => c.opId === 'admin.user_vehicles')!;
    expect(call.headers.get('carpal-access-purpose')).toBe(PURPOSE);
    expect(call.path).toBe(`/v1/admin/users/${U1}/vehicles`);
  });

  it('Appointments: the business is a link, safety flagged, and the next page is read with the cursor', async () => {
    resetNav(url('appointments'));
    const { transport, calls } = handlers();
    renderConsole(<UserPage userId={U1} />, { transport, roles: ['ADM'] });
    const tab = await screen.findByTestId('user-appointments');
    const link = await within(tab).findByRole('link', { name: 'Pars Auto' });
    expect(link).toHaveAttribute('href', `/orgs/${O1}`);
    const row = link.closest('tr')!;
    expect(row).toHaveTextContent('Repair');
    expect(row).toHaveTextContent('Confirmed');
    expect(row).toHaveTextContent('Safety');
    fireEvent.click(within(tab).getByRole('button', { name: 'Next page' }));
    expect(await within(tab).findByText('Business no longer exists')).toBeInTheDocument();
    expect(calls.filter((c) => c.opId === 'admin.user_appointments').at(-1)!.search).toContain('cursor=c2');
  });

  it('Consents: active consents and the history, read only', async () => {
    resetNav(url('consents'));
    const { transport, calls } = handlers();
    renderConsole(<UserPage userId={U1} />, { transport, roles: ['SUP'] });
    const tab = await screen.findByTestId('user-consents');
    const current = await within(tab).findByRole('table', { name: 'Active consents' });
    expect(within(current).getByText('Pars Auto')).toBeInTheDocument();
    const history = within(tab).getByRole('table', { name: 'Consent history' });
    await within(history).findByText('Withdrawn', { selector: '.cp-badge' });
    expect(history).toHaveTextContent('Staff');
    expect(calls.filter((c) => c.opId === 'admin.user_consents').every((c) => c.headers.get('carpal-access-purpose') === PURPOSE)).toBe(
      true,
    );
    expect(within(tab).queryByRole('button', { name: /withdraw|give/i })).toBeNull();
  });

  it('Sessions & devices: sessions, the cap note and push devices', async () => {
    resetNav(url('sessions'));
    const { transport } = handlers();
    renderConsole(<UserPage userId={U1} />, { transport, roles: ['SUP'] });
    const tab = await screen.findByTestId('user-sessions');
    expect(await within(tab).findByText('Pixel 8')).toBeInTheDocument();
    expect(within(tab).getByText('Two steps')).toBeInTheDocument();
    expect(within(tab).getByTestId('sessions-more')).toHaveTextContent('The 1 newest of 140 sessions are listed.');
    const devices = within(tab).getByRole('table', { name: 'Push devices' });
    expect(devices).toHaveTextContent('Android');
    expect(devices).toHaveTextContent('Persian');
  });

  for (const locale of ['en', 'fa'] as Locale[]) {
    for (const tab of ['vehicles', 'appointments', 'consents', 'sessions']) {
      it(`axe: no violations on ${tab} (${locale})`, async () => {
        resetNav(url(tab));
        const { transport } = handlers();
        renderConsole(<UserPage userId={U1} />, { transport, roles: ['ADM'], locale });
        await screen.findByTestId(`user-${tab}`);
        await waitFor(() => expect(screen.queryByText(locale === 'en' ? 'Loading…' : /…/)).toBeNull());
        expect(await axeViolations()).toEqual([]);
      });
    }
  }
});

describe('consentState', () => {
  const base = { granted: true, withdrawn_at: null, expires_at: null, paused: false, reconsent_required: false };
  it('reads the record', () => {
    expect(consentState(base)).toBe('granted');
    expect(consentState({ ...base, reconsent_required: true })).toBe('reconsent');
    expect(consentState({ ...base, reconsent_required: true, paused: true })).toBe('paused');
    expect(consentState({ ...base, withdrawn_at: ago(1) })).toBe('withdrawn');
    expect(consentState({ ...base, expires_at: ago(1) })).toBe('expired');
    expect(consentState({ ...base, granted: false })).toBe('declined');
  });
});
