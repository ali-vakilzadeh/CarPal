// AC9.T1/T2/T3/T5 DOM tests of the organization screens: the search list (no contact data, search by id, a row opens
// with the organization's pending verification as its purpose), the page without a purpose (header from the search,
// work items to open it for), the page read for a purpose (tabs, masked contact data), a location correction with the
// coordinates typed (the map's keyboard alternative), suspend with its second confirmation, an assist session with its
// banner; axe in EN and FA.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Location, OrganizationVerification, StaffOrgView } from '@carpal/api-contracts';
import { axeViolations, page, renderConsole, scriptedTransport } from '../../../tests/support/console-harness';
import { nav, resetNav } from '../../../tests/support/navigation-mock';
import type { Locale } from '@/lib/i18n/locales';
import { AssistBanner, assistStore } from './assist';
import { OrgPage } from './org-page';
import { OrgsPage } from './orgs-page';

vi.mock('next/navigation', async () => (await import('../../../tests/support/navigation-mock')).navigationMock());

const id = (n: number) => `0193a3c4-5d6e-7f80-9a1b-${String(n).padStart(12, '0')}`;
const ORG = id(21);
const LOC = id(51);
const V1 = id(61);
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function location(o: Partial<Location> = {}): Location {
  return {
    id: LOC,
    created_at: ago(200),
    updated_at: ago(200),
    version: 1,
    name: 'Main shop',
    address_line_1: 'Valiasr St 12',
    city: 'Tehran',
    country: 'IR',
    public_address_visibility: 'exact',
    timezone: 'Asia/Tehran',
    service_radius_km: 5,
    is_primary: true,
    status: 'active',
    organization_id: ORG,
    latitude: 35.7,
    longitude: 51.4,
    public_point: { lat: 35.7, lng: 51.4 },
    geo_source: 'user_pin',
    geo_address_distance_m: 1200,
    location_check_status: 'far_apart',
    location_verified_at: null,
    hours: { weekly: [{ day_of_week: 6, open: '09:00', close: '18:00' }] },
    ...o,
  } as Location;
}

function check(o: Partial<OrganizationVerification> = {}): OrganizationVerification {
  return {
    id: V1,
    created_at: ago(20),
    updated_at: ago(20),
    version: 1,
    verification_type: 'location',
    status: 'pending',
    submitted_document_ids: [],
    reviewed_at: null,
    rejection_reason: null,
    expires_at: null,
    ...o,
  } as OrganizationVerification;
}

function org(o: Partial<StaffOrgView> = {}): StaffOrgView {
  return {
    id: ORG,
    created_at: ago(300),
    updated_at: ago(2),
    version: 3,
    name: 'Asa Auto',
    legal_name: 'Asa Khodro Co.',
    organization_type: 'provider',
    verification_status: 'pending',
    primary_location_id: LOC,
    contact_email: 'owner@asa-auto.ir',
    contact_phone: '+989121234567',
    website: 'https://asa-auto.ir',
    description_translations: { fa: 'تعمیرگاه تخصصی' },
    slug: 'asa-auto',
    trust_score: 72,
    status: 'active',
    merged_into_organization_id: null,
    my_role: 'platform_moderator',
    locations: [location()],
    verifications: [check()],
    subscription: {
      id: id(71),
      created_at: ago(300),
      updated_at: ago(300),
      version: 1,
      plan: { plan_key: 'provider_basic' },
      status: 'trial',
      billing_mode: 'manual',
      started_at: ago(300),
      trial_ends_at: ago(-100),
      expires_at: null,
      effective_entitlements: [],
      usage: {},
    },
    member_count: 3,
    open_cases: 1,
    ...o,
  } as unknown as StaffOrgView;
}

const reason = (dialog: HTMLElement, code: string, note?: string) => {
  fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: code } });
  if (note !== undefined) fireEvent.change(within(dialog).getByLabelText(/^Note/), { target: { value: note } });
};

beforeEach(() => {
  resetNav('/orgs');
  assistStore.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('Organizations list (AC9.T1)', () => {
  it('lists organizations without contact data and opens one for its pending verification', async () => {
    const { transport, calls } = scriptedTransport({ 'admin.orgs_search': () => page([org()]) });
    renderConsole(<OrgsPage />, { transport, roles: ['MOD'] });
    const table = await screen.findByRole('table', { name: 'Organizations' });
    const row = (await within(table).findByRole('button', { name: 'Asa Auto' })).closest('tr')!;
    expect(within(row).getByText('Service provider')).toBeInTheDocument();
    expect(within(row).getByText('Tehran')).toBeInTheDocument();
    expect(within(row).getByText('Provider Basic')).toBeInTheDocument();
    expect(within(row).getByText('Verification pending')).toBeInTheDocument();
    expect(screen.queryByText(/owner@asa-auto\.ir/)).toBeNull();
    expect(screen.queryByText(/989121234567/)).toBeNull();
    expect(calls[0]!.body).toEqual({ limit: 50 });
    fireEvent.click(within(row).getByRole('button', { name: 'Asa Auto' }));
    expect(nav.pushed.at(-1)).toBe(`/orgs/${ORG}?purpose=${encodeURIComponent(`verification:${V1}`)}`);
  });

  it('searches by id and refuses an id that is not one; the saved views are links', async () => {
    const { transport, calls } = scriptedTransport({ 'admin.orgs_search': () => page([]) });
    renderConsole(<OrgsPage />, { transport, roles: ['SUP'] });
    await screen.findByText('No organization matches.');
    fireEvent.change(screen.getByLabelText('Search in'), { target: { value: 'id' } });
    fireEvent.change(screen.getByLabelText('Search for'), { target: { value: 'not-an-id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByText(/An organization id looks like/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search for'), { target: { value: ORG.toUpperCase() } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(calls.at(-1)!.body).toEqual({ organization_id: ORG, limit: 50 }));
    expect(screen.getByRole('link', { name: 'Pending verification' })).toHaveAttribute('href', '/orgs?verification_status=pending');
    expect(screen.getByRole('link', { name: 'Suspended' })).toHaveAttribute('href', '/orgs?status=suspended');
  });
});

describe('Organization page (AC9.T2, T5)', () => {
  it('without a purpose shows the header from the search and the work items to open it for', async () => {
    resetNav(`/orgs/${ORG}`);
    const { transport, calls } = scriptedTransport({ 'admin.orgs_search': () => page([org()]) });
    renderConsole(<OrgPage orgId={ORG} mapStyleUrl={null} publicWeb="https://pwa.carpals.ir" />, { transport, roles: ['MOD'] });
    expect(await screen.findByRole('heading', { name: 'Asa Auto', level: 1 })).toBeInTheDocument();
    expect(calls.some((c) => c.opId === 'admin.org_get')).toBe(false);
    const choose = screen.getByTestId('org-choose-item');
    expect(within(choose).getByRole('link', { name: /Location check, submitted/ })).toHaveAttribute(
      'href',
      `/orgs/${ORG}?purpose=${encodeURIComponent(`verification:${V1}`)}`,
    );
    expect(screen.getByTestId('public-profile')).toHaveAttribute('href', 'https://pwa.carpals.ir/en/shop/asa-auto');
    expect(screen.queryByText(/owner@asa-auto/)).toBeNull();
    // Moderators may suspend; assisting is for support staff and admins; plans for admins.
    expect(screen.getByRole('button', { name: 'Suspend' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assist onboarding' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Change plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Merge/ })).toBeNull();
  });

  it('reads the organization for its purpose: tabs, masked contact data, the missing tabs', async () => {
    resetNav(`/orgs/${ORG}?purpose=verification:${V1}`);
    const { transport, calls } = scriptedTransport({ 'admin.org_get': () => Response.json(org()) });
    renderConsole(<OrgPage orgId={ORG} mapStyleUrl={null} />, { transport, roles: ['ADM'] });
    const tabs = await screen.findByRole('tablist', { name: 'Organization details' });
    const get = calls.find((c) => c.opId === 'admin.org_get')!;
    expect(get.path).toBe(`/v1/admin/orgs/${ORG}`);
    expect(get.headers.get('carpal-access-purpose')).toBe(`verification:${V1}`);
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((x) => x.textContent),
    ).toEqual(['Profile', 'Locations', 'Verification', 'Plan']);
    const profile = screen.getByTestId('profile-tab');
    expect(within(profile).queryByText('owner@asa-auto.ir')).toBeNull();
    expect(within(profile).getAllByRole('button', { name: 'Reveal' })).toHaveLength(2);
    fireEvent.click(within(profile).getAllByRole('button', { name: 'Reveal' })[0]!);
    expect(await within(profile).findByText('owner@asa-auto.ir')).toBeInTheDocument();
    expect(calls.filter((c) => c.opId === 'admin.org_get')).toHaveLength(2);
    expect(screen.getByText('Capabilities & badges')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change plan' })).toHaveAttribute('href', `/plans?subscriber=organization:${ORG}#assign`);
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Verification' }));
    expect(nav.search).toContain('tab=verification');
    expect(await screen.findByTestId('verification-tab')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute(
      'href',
      `/verification?verification=${V1}&purpose=${encodeURIComponent(`verification:${V1}`)}`,
    );
    expect(screen.getByTestId('badge-panel')).toBeInTheDocument();
  });

  it('says so when the work item is closed and falls back to the search', async () => {
    resetNav(`/orgs/${ORG}?purpose=verification:${V1}`);
    const { transport } = scriptedTransport({
      'admin.org_get': () => Response.json({ code: 'NOT_FOUND' }, { status: 404, headers: { 'content-type': 'application/problem+json' } }),
      'admin.orgs_search': () => page([org({ verifications: [] })]),
    });
    renderConsole(<OrgPage orgId={ORG} mapStyleUrl={null} />, { transport, roles: ['MOD'] });
    expect(await screen.findByText('That work item is closed or taken by someone else')).toBeInTheDocument();
    expect(screen.getByText(/has no pending verification/)).toBeInTheDocument();
  });

  it('suspends with a reason and a second confirmation', async () => {
    resetNav(`/orgs/${ORG}`);
    let status = 'active';
    const { transport, calls } = scriptedTransport({
      'admin.orgs_search': () => page([org({ status: status as StaffOrgView['status'] })]),
      'admin.org_status': (_r, body) => {
        status = String(body!.status);
        return Response.json(org({ status: 'suspended' }));
      },
    });
    renderConsole(<OrgPage orgId={ORG} mapStyleUrl={null} />, { transport, roles: ['MOD'] });
    fireEvent.click(await screen.findByRole('button', { name: 'Suspend' }));
    const dialog = await screen.findByRole('dialog', { name: 'Suspend this organization' });
    expect(within(dialog).getByText(/leave search and the map/)).toBeInTheDocument();
    reason(dialog, 'fraud', 'Fake reviews ring');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    expect(within(dialog).getByText(/Tick the box/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    expect(await screen.findByText('The organization is suspended.')).toBeInTheDocument();
    const call = calls.find((c) => c.opId === 'admin.org_status')!;
    expect(call.path).toBe(`/v1/admin/orgs/${ORG}/status`);
    expect(call.body).toEqual({ status: 'suspended', reason: 'fraud: Fake reviews ring' });
    expect(await screen.findByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  it('starts an assist session, shows the banner and ends it', async () => {
    resetNav(`/orgs/${ORG}`);
    const until = new Date(Date.now() + 4 * 3_600_000).toISOString();
    const { transport, calls } = scriptedTransport({
      'admin.orgs_search': () => page([org({ organization_type: 'hybrid_provider_vendor' })]),
      'admin.assist_session_start': () => Response.json({ assist_session_id: id(81), expires_at: until }, { status: 201 }),
      'admin.assist_session_end': () => Response.json({ ok: true }),
    });
    renderConsole(
      <>
        <AssistBanner />
        <OrgPage orgId={ORG} mapStyleUrl={null} />
      </>,
      { transport, roles: ['SUP'] },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Assist onboarding' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start an assisted onboarding session' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Parts seller' }));
    reason(dialog, 'owner_requested');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assist onboarding' }));
    const banner = await screen.findByTestId('assist-banner');
    expect(calls.find((c) => c.opId === 'admin.assist_session_start')!.body).toEqual({ flow_type: 'vendor', reason: 'owner_requested' });
    expect(within(banner).getByText(/Parts seller onboarding until/)).toBeInTheDocument();
    expect(within(banner).getByRole('link', { name: 'Asa Auto' })).toHaveAttribute('href', `/orgs/${ORG}`);
    fireEvent.click(within(banner).getByRole('button', { name: 'End the session' }));
    const end = await screen.findByRole('dialog', { name: 'End the assist session' });
    reason(end, 'onboarding_done');
    fireEvent.click(within(end).getByRole('button', { name: 'End the session' }));
    await waitFor(() => expect(screen.queryByTestId('assist-banner')).toBeNull());
    const call = calls.find((c) => c.opId === 'admin.assist_session_end')!;
    expect(call.path).toBe(`/v1/admin/assist-sessions/${id(81)}/end`);
    expect(call.body).toEqual({ reason: 'onboarding_done' });
  });
});

describe('Locations tab (AC9.T3)', () => {
  it('shows the pin check and corrects the pin with typed coordinates', async () => {
    resetNav(`/orgs/${ORG}?tab=locations&purpose=verification:${V1}`);
    let corrected = false;
    const { transport, calls } = scriptedTransport({
      'admin.org_get': () =>
        Response.json(
          org({
            locations: [
              corrected
                ? location({
                    latitude: 35.701,
                    longitude: 51.402,
                    geo_source: 'admin_corrected',
                    location_check_status: 'consistent',
                    geo_address_distance_m: 40,
                    version: 2,
                  })
                : location(),
            ],
          }),
        ),
      'admin.location_correct': () => {
        corrected = true;
        return Response.json(
          location({ latitude: 35.701, longitude: 51.402, geo_source: 'admin_corrected', location_check_status: 'consistent' }),
        );
      },
    });
    renderConsole(<OrgPage orgId={ORG} mapStyleUrl={null} />, { transport, roles: ['MOD'] });
    const tab = await screen.findByTestId('locations-tab');
    expect(within(tab).getByTestId('pin-verdict')).toHaveTextContent('Pin far from address');
    expect(within(tab).getByTestId('pin-distance')).toHaveTextContent('about 1.2 km (threshold 300 m)');
    expect(within(tab).getByTestId('pin-coords')).toHaveTextContent('35.7, 51.4');
    // jsdom has no WebGL: the map says so and the form still works (keyboard alternative).
    expect(await within(tab).findByTestId('map-failed')).toBeInTheDocument();
    fireEvent.click(within(tab).getByRole('button', { name: 'Correct pin or address' }));
    const form = within(tab).getByRole('form', { name: 'Correct the location' });
    fireEvent.click(within(form).getByRole('button', { name: 'Save the correction' }));
    expect(within(form).getByText('Nothing changed yet.')).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Latitude'), { target: { value: '35.701' } });
    fireEvent.change(within(form).getByLabelText('Longitude'), { target: { value: '51.402' } });
    expect(within(form).getByTestId('move-size')).toHaveTextContent('The pin moves by about 200 m.');
    fireEvent.click(within(form).getByRole('button', { name: 'Save the correction' }));
    const dialog = await screen.findByRole('dialog', { name: 'Correct this location' });
    expect(within(dialog).getByTestId('correct-summary')).toHaveTextContent('Pin');
    reason(dialog, 'owner_pin_wrong');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the correction' }));
    await waitFor(() => expect(calls.some((c) => c.opId === 'admin.location_correct')).toBe(true));
    const call = calls.find((c) => c.opId === 'admin.location_correct')!;
    expect(call.path).toBe(`/v1/admin/orgs/${ORG}/locations/${LOC}/correct`);
    expect(call.body).toEqual({ pin: { lat: 35.701, lng: 51.402 }, reason: 'owner_pin_wrong' });
    await waitFor(() => expect(screen.getByTestId('pin-verdict')).toHaveTextContent('Pin matches address'));
    expect(screen.getByText('Corrected by CarPal')).toBeInTheDocument();
  });

  it('hides the correction from support staff', async () => {
    resetNav(`/orgs/${ORG}?tab=locations&purpose=verification:${V1}`);
    const { transport } = scriptedTransport({ 'admin.org_get': () => Response.json(org()) });
    renderConsole(<OrgPage orgId={ORG} mapStyleUrl={null} />, { transport, roles: ['SUP'] });
    await screen.findByTestId('locations-tab');
    expect(screen.queryByRole('button', { name: 'Correct pin or address' })).toBeNull();
  });
});

describe('Organization a11y (AC9.T6)', () => {
  for (const locale of ['en', 'fa'] as Locale[])
    it(`has no axe violations on the organization page and its locations (${locale})`, async () => {
      resetNav(`/orgs/${ORG}?tab=locations&purpose=verification:${V1}`);
      const { transport } = scriptedTransport({ 'admin.org_get': () => Response.json(org()) });
      const { container } = renderConsole(<OrgPage orgId={ORG} mapStyleUrl={null} />, { transport, roles: ['ADM'], locale });
      await screen.findByTestId('locations-tab');
      await screen.findByTestId('map-failed');
      expect(await axeViolations(container)).toEqual([]);
    });

  it('has no axe violations on the list (fa)', async () => {
    const { transport } = scriptedTransport({ 'admin.orgs_search': () => page([org()]) });
    const { container } = renderConsole(<OrgsPage />, { transport, roles: ['MOD'], locale: 'fa' });
    await screen.findByRole('table');
    await screen.findByText('Asa Auto');
    expect(await axeViolations(container)).toEqual([]);
  });
});
