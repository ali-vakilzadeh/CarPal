// PW2 (DOM): the compact onboarding at /provider/start. A new business is created at step 1 (one idempotency key,
// profile, step saved, terms recorded after the save, optional AI consent); a returning owner resumes at the saved
// step (leaving after step 2 comes back at step 3); without WebGL the location step offers the phone's position only;
// publish problems are shown in plain words with a way to the step; a publish ends on the result screen with the
// public profile link; Today offers 'Continue setting up' for an unpublished business.
import type { Membership, TaxonomyNode, TaxonomyType } from '@carpal/api-contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '../../../tests/support/next-navigation';
import { renderApp, signedIn, type Handlers } from '../../../tests/support/render-app';
import { ApiProblem } from '@/lib/api/problem';
import { BUNDLED } from '@/lib/i18n/dictionary';
import { WorkshopProvider } from './context';
import { WorkshopOnboarding, profileWrite } from './onboarding';
import { WorkshopGate } from './shell';
import { WorkshopToday } from './today';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));
vi.mock('next/link', () => import('../../../tests/support/next-link'));
vi.mock('@/lib/browser-nav', () => ({ goTo: vi.fn() }));

const EN = BUNDLED.en.provider.onboarding;
const ORG = '0195f3b1-6a2b-7c3d-8e4f-0000000000c3';

const page = <T,>(items: T[]) => ({ items, next_cursor: null });

const membership = (status: 'draft' | 'active' = 'draft', role: Membership['role'] = 'provider_owner'): Membership =>
  ({
    id: 'm1',
    role,
    status: 'active',
    organization: {
      id: ORG,
      name: 'Reza Auto',
      organization_type: 'provider',
      slug: null,
      logo_url: null,
      status,
      verification_status: 'unverified',
    },
  }) as Membership;

const org = (o: Record<string, unknown> = {}) => ({
  id: ORG,
  version: 1,
  name: 'Reza Auto',
  contact_email: 'reza@test.carpal.app',
  contact_phone: '+989123456789',
  organization_type: 'provider',
  verification_status: 'unverified',
  status: 'draft',
  slug: null,
  ...o,
});
const profile = {
  version: 1,
  provider_type: 'garage',
  service_modes: ['in_shop'],
  price_tier: 'unspecified',
  warranty_offered: false,
  contact_channels: [],
};
const location = {
  id: 'loc-1',
  version: 2,
  address_line_1: 'Azadi 12',
  city: 'Tehran',
  country: 'IR',
  is_primary: true,
  status: 'active',
  public_address_visibility: 'exact',
  latitude: 35.7,
  longitude: 51.4,
};
const flow = (current_step: string, version = 3) => ({
  id: 'f1',
  version,
  flow_type: 'provider',
  current_step,
  completed_steps: [],
  status: 'in_progress',
});

const node = (id: string, type: TaxonomyType, name: string): TaxonomyNode =>
  ({
    id,
    type,
    parent_id: null,
    name: { text: name, locale: 'en' },
    description: null,
    slug: id,
    regions: [],
    attributes: null,
    sort_order: 0,
    status: 'active',
    merged_into_id: null,
  }) as TaxonomyNode;
const NODES = [
  node('sys-brakes', 'service_system', 'Brakes'),
  node('sys-susp', 'service_system', 'Suspension'),
  node('bmw', 'vehicle_brand', 'BMW'),
  node('kia', 'vehicle_brand', 'Kia'),
];

/** A draft business with what the server holds for it. */
function draftHandlers(
  o: { step: string; locations?: unknown[]; categories?: unknown[]; coverage?: unknown[]; rules?: unknown[] },
  extra: Handlers = {},
): Handlers {
  return {
    'me.memberships_list': () => page([membership()]),
    'onboarding.list': () => page([flow(o.step)]),
    'org.get': () => org(),
    'provider.profile_get': () => profile,
    'org.locations_list': () => page(o.locations ?? []),
    'provider.service_categories_list': () => page(o.categories ?? []),
    'provider.coverage_list': () => page(o.coverage ?? []),
    'availability.rules_list': () => page(o.rules ?? []),
    'onboarding.update': (a) => flow((a.body as { current_step: string }).current_step, 4),
    'taxonomy.snapshot': ({ query }) => page(NODES.filter((n) => n.type === (query as { type: string }).type)),
    ...extra,
  };
}

function renderStart(handlers: Handlers) {
  return renderApp(
    <WorkshopProvider>
      <WorkshopOnboarding styleUrl={null} />
    </WorkshopProvider>,
    {
      locale: 'en',
      session: signedIn('Reza'),
      // The set-up keeps the account's time zone in step with the phone (syncTimeZone).
      handlers: {
        'me.get': () => ({ email: 'reza@test.carpal.app', phone: '+989123456789', timezone: 'Europe/Paris' }),
        'me.update': () => ({}),
        ...handlers,
      },
    },
  );
}

beforeEach(() => navigation.reset('/en/provider/start'));
afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('a sign-up that came straight into the Workshop', () => {
  it('records the choices made at sign-up and the time zone of the phone', async () => {
    sessionStorage.setItem(
      'cp:signup-choices',
      JSON.stringify({ marketing: true, aiPersonalization: false, policyVersion: 'p-3', at: Date.now() }),
    );
    const { api } = renderStart({
      'me.memberships_list': () => page([]),
      'onboarding.list': () => page([]),
      'consents.grant': () => ({}),
      'me.preferences_get': () => ({}),
      'me.preferences_update': () => ({}),
    });
    await waitFor(() => expect(api.calls.some((c) => c.opId === 'me.preferences_update')).toBe(true));
    expect(api.calls.find((c) => c.opId === 'consents.grant')!.args.body).toEqual({ consent_type: 'marketing', policy_version: 'p-3' });
    expect(sessionStorage.getItem('cp:signup-choices')).toBeNull();
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone !== 'Europe/Paris')
      await waitFor(() => expect(api.calls.find((c) => c.opId === 'me.update')?.args.body).toEqual({ timezone: zone }));
  });
});

describe('step 1: start a business (PW-ONB-01)', () => {
  it('creates the business, its profile and the step, then records the terms', async () => {
    const order: string[] = [];
    const { api } = renderStart({
      'me.memberships_list': () => page([]),
      'onboarding.list': () => page([]),
      'me.get': () => ({ email: 'reza@test.carpal.app', phone: '+989123456789' }),
      'org.create': () => (order.push('org.create'), org()),
      'provider.profile_put': () => (order.push('profile_put'), profile),
      'policy.current': ({ path }) => ({ policy_version: (path as { policy_key: string }).policy_key === 'terms' ? 't-2.1' : 'ai-1.0' }),
      'org.consents_grant': () => (order.push('consent'), {}),
      'onboarding.update': () => (order.push('update'), flow('location', 1)),
      'onboarding.accept_terms': () => (order.push('terms'), flow('location', 1)),
    });
    expect(await screen.findByRole('heading', { name: EN.titles.business })).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText(EN.business.email) as HTMLInputElement).value).toBe('reza@test.carpal.app'));

    fireEvent.click(screen.getByRole('button', { name: EN.business.create }));
    expect(await screen.findByText(EN.business.nameRequired)).toBeTruthy();
    expect(screen.getByText(EN.business.termsRequired)).toBeTruthy();
    expect(api.calls.some((c) => c.opId === 'org.create')).toBe(false);

    fireEvent.change(screen.getByLabelText(EN.business.name), { target: { value: 'Reza Auto' } });
    fireEvent.click(screen.getByRole('button', { name: EN.types.mobile_mechanic }));
    fireEvent.change(screen.getByLabelText(EN.business.phone), { target: { value: '0912 345 6789' } });
    fireEvent.click(screen.getByLabelText(new RegExp(EN.business.terms)));
    fireEvent.click(screen.getByLabelText(EN.business.ai));
    fireEvent.click(screen.getByRole('button', { name: EN.business.create }));

    expect(await screen.findByRole('heading', { name: EN.titles.location })).toBeTruthy();
    await waitFor(() => expect(order).toContain('terms'));
    expect(order).toEqual(['org.create', 'profile_put', 'consent', 'update', 'terms']);
    const call = (op: string) => api.calls.find((c) => c.opId === op)!.args;
    expect(call('org.create')).toMatchObject({
      body: { name: 'Reza Auto', organization_type: 'provider', contact_email: 'reza@test.carpal.app', contact_phone: '+989123456789' },
      idempotencyKey: expect.any(String),
    });
    expect(call('provider.profile_put')).toMatchObject({
      path: { org_id: ORG },
      body: {
        provider_type: 'mobile_mechanic',
        service_modes: ['mobile'],
        price_tier: 'unspecified',
        warranty_offered: false,
        contact_channels: [{ type: 'phone', value: '+989123456789', preferred: true }],
      },
    });
    expect(call('provider.profile_put').ifMatch).toBeUndefined();
    expect(call('org.consents_grant')).toMatchObject({ body: { consent_type: 'provider_analytics_ai_use', policy_version: 'ai-1.0' } });
    expect(call('onboarding.update')).toMatchObject({
      path: { flow_type: 'provider' },
      body: { current_step: 'location', completed_step: 'business' },
      ifMatch: '"v1"',
    });
    expect(call('onboarding.accept_terms')).toMatchObject({ body: { terms_version: 't-2.1' } });
    // The new business becomes the active one of this device.
    expect(localStorage.getItem('cp:provider:active:u1')).toBe(ORG);
  });

  it('says to verify the e-mail or phone when the server asks for it', async () => {
    renderStart({
      'me.memberships_list': () => page([]),
      'onboarding.list': () => page([]),
      'me.get': () => ({ email: 'reza@test.carpal.app', phone: '+989123456789' }),
      'org.create': () => {
        throw new ApiProblem(403, { code: 'VERIFIED_CONTACT_REQUIRED' });
      },
    });
    fireEvent.change(await screen.findByLabelText(EN.business.name), { target: { value: 'Reza Auto' } });
    await waitFor(() => expect((screen.getByLabelText(EN.business.phone) as HTMLInputElement).value).not.toBe(''));
    fireEvent.click(screen.getByLabelText(new RegExp(EN.business.terms)));
    fireEvent.click(screen.getByRole('button', { name: EN.business.create }));
    expect(await screen.findByText(EN.business.verifyTitle)).toBeTruthy();
    expect(screen.getByRole('link', { name: EN.business.verifyAction }).getAttribute('href')).toBe('/en/settings/profile');
  });

  it('still records the consent and the terms when the owner retries after a failed profile save', async () => {
    let profilePuts = 0;
    const { api } = renderStart({
      'me.memberships_list': () => page([]),
      'onboarding.list': () => page([]),
      'org.create': () => org(),
      'org.update': () => org(),
      'provider.profile_put': () => {
        if (++profilePuts === 1) throw new ApiProblem(0, { code: 'NETWORK' });
        return profile;
      },
      'policy.current': () => ({ policy_version: 'v9' }),
      'org.consents_grant': () => ({}),
      'onboarding.update': () => flow('location', 1),
      'onboarding.accept_terms': () => flow('location', 1),
    });
    fireEvent.change(await screen.findByLabelText(EN.business.name), { target: { value: 'Reza Auto' } });
    await waitFor(() => expect((screen.getByLabelText(EN.business.phone) as HTMLInputElement).value).not.toBe(''));
    fireEvent.click(screen.getByLabelText(new RegExp(EN.business.terms)));
    fireEvent.click(screen.getByLabelText(EN.business.ai));
    fireEvent.click(screen.getByRole('button', { name: EN.business.create }));
    await waitFor(() => expect(profilePuts).toBe(1));
    // The business exists now; the terms and AI boxes stay until the welcome has run.
    const retry = await screen.findByRole('button', { name: EN.next });
    expect((screen.getByLabelText(EN.business.ai) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(retry);
    expect(await screen.findByRole('heading', { name: EN.titles.location })).toBeTruthy();
    await waitFor(() => expect(api.calls.some((c) => c.opId === 'onboarding.accept_terms')).toBe(true));
    expect(api.calls.filter((c) => c.opId === 'org.create')).toHaveLength(1);
    expect(api.calls.filter((c) => c.opId === 'org.consents_grant')).toHaveLength(1);
  });

  it('keeps the profile fields the Web UI set when the step is saved again', () => {
    const existing = {
      ...profile,
      version: 4,
      description_translations: { fa: 'x' },
      years_in_business: 12,
      contact_channels: [{ type: 'whatsapp', value: '+989100000000', preferred: true }],
    };
    expect(profileWrite(existing as never, 'garage', '+989123456789')).toEqual({
      description_translations: { fa: 'x' },
      years_in_business: 12,
      provider_type: 'garage',
      service_modes: ['in_shop'],
      price_tier: 'unspecified',
      warranty_offered: false,
      contact_channels: [
        { type: 'phone', value: '+989123456789', preferred: false },
        { type: 'whatsapp', value: '+989100000000', preferred: true },
      ],
    });
  });
});

describe('resume (PW2.T2)', () => {
  it('comes back at step 3 after leaving at the end of step 2, on the unpublished business', async () => {
    const { api } = renderStart(draftHandlers({ step: 'services', locations: [location] }));
    expect(await screen.findByRole('heading', { name: EN.titles.services })).toBeTruthy();
    expect(screen.getByText(`Step 3 of 4 · ${EN.steps.services}`)).toBeTruthy();
    for (const c of api.calls.filter((x) => x.opId.startsWith('provider.') || x.opId.startsWith('org.')))
      expect((c.args.path as { org_id: string }).org_id).toBe(ORG);
  });

  it('saves the repairs and brands chosen, then goes on to the hours', async () => {
    const { api } = renderStart(
      draftHandlers(
        { step: 'services', locations: [location], categories: [{ id: 'c0', taxonomy_node_id: 'sys-susp' }] },
        {
          'provider.service_category_create': (a) => ({
            id: 'c1',
            taxonomy_node_id: (a.body as { taxonomy_node_id: string }).taxonomy_node_id,
          }),
          'provider.coverage_create': () => ({ created: [{ id: 'cv1', brand_node_id: 'kia' }], skipped: [] }),
        },
      ),
    );
    const saved = await screen.findByRole('button', { name: 'Suspension' });
    // Saved earlier: shown chosen, removed only in the Web UI.
    expect(saved.getAttribute('aria-pressed')).toBe('true');
    expect((saved as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: EN.next }));
    expect(await screen.findByText(EN.services.missing)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Brakes' }));
    fireEvent.change(screen.getByLabelText(EN.services.brandSearch), { target: { value: 'ki' } });
    expect(screen.queryByRole('button', { name: 'BMW' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Kia' }));
    fireEvent.click(screen.getByRole('button', { name: EN.next }));

    expect(await screen.findByRole('heading', { name: EN.titles.hours })).toBeTruthy();
    const call = (op: string) => api.calls.filter((c) => c.opId === op).map((c) => c.args.body);
    expect(call('provider.service_category_create')).toEqual([
      { taxonomy_node_id: 'sys-brakes', experience_level: 'intermediate', visibility: 'public' },
    ]);
    expect(call('provider.coverage_create')).toEqual([{ items: [{ brand_node_id: 'kia', coverage_level: 'standard' }] }]);
    await waitFor(() => expect(call('onboarding.update')).toContainEqual({ current_step: 'hours', completed_step: 'services' }));
  });
});

describe('step 2 without a map (PW2.T3)', () => {
  it('offers the phone position only, and the Web UI when that is not available either', async () => {
    renderStart(draftHandlers({ step: 'location' }));
    expect(await screen.findByRole('heading', { name: EN.titles.location })).toBeTruthy();
    // jsdom has no WebGL and no geolocation.
    expect(await screen.findByTestId('no-map')).toBeTruthy();
    expect((screen.getByRole('button', { name: EN.location.useMine }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(EN.location.noWayTitle)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: EN.next }));
    expect(await screen.findByText(EN.location.pinRequired)).toBeTruthy();
    expect(screen.getByText(EN.location.streetRequired)).toBeTruthy();
  });

  it('saves a pin from the phone position with the typed address, and warns once when they are far apart', async () => {
    const getCurrentPosition = vi.fn((ok: PositionCallback) =>
      ok({ coords: { latitude: 35.71, longitude: 51.41 } } as GeolocationPosition),
    );
    Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition }, configurable: true });
    try {
      const { api } = renderStart(
        draftHandlers(
          { step: 'location' },
          {
            'geo.reverse': () => ({
              candidate: {
                label: '',
                point: { lat: 35.71, lng: 51.41 },
                address_line_1: 'Azadi 12',
                city: 'Tehran',
                region: null,
                postal_code: null,
                country: 'IR',
              },
            }),
            'org.location_pin_check': () => ({
              geocoded_point: null,
              distance_m: 2400,
              location_check_status: 'far_apart',
              threshold_m: 500,
            }),
            'org.location_create': () => location,
          },
        ),
      );
      fireEvent.click(await screen.findByRole('button', { name: EN.location.useMine }));
      await waitFor(() => expect((screen.getByLabelText(EN.location.street) as HTMLInputElement).value).toBe('Azadi 12'));
      fireEvent.click(screen.getByLabelText(new RegExp(EN.location.area)));
      fireEvent.click(screen.getByRole('button', { name: EN.next }));
      expect(await screen.findByText(EN.location.farTitle)).toBeTruthy();
      expect(api.calls.some((c) => c.opId === 'org.location_create')).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: EN.location.saveAnyway }));
      expect(await screen.findByRole('heading', { name: EN.titles.services })).toBeTruthy();
      expect(api.calls.find((c) => c.opId === 'org.location_create')!.args.body).toEqual({
        address_line_1: 'Azadi 12',
        city: 'Tehran',
        country: 'IR',
        pin: { lat: 35.71, lng: 51.41 },
        public_address_visibility: 'approximate',
        timezone: 'Asia/Tehran',
        is_primary: true,
      });
    } finally {
      Reflect.deleteProperty(navigator, 'geolocation');
    }
  });
});

describe('step 4: hours and go live (PW-ONB-04)', () => {
  const ready = {
    step: 'hours',
    locations: [location],
    categories: [{ id: 'c1', taxonomy_node_id: 'sys-brakes' }],
    coverage: [{ id: 'cv1', brand_node_id: 'bmw' }],
  };

  it('shows publish problems in plain words with a way to the step', async () => {
    renderStart(
      draftHandlers(ready, {
        'availability.rule_create': (a) => ({ id: `r${(a.body as { day_of_week: number }).day_of_week}`, ...(a.body as object) }),
        'org.location_update': () => ({ ...location, version: 3 }),
        'provider.publish': () => {
          throw new ApiProblem(422, {
            code: 'PUBLISH_REQUIREMENTS_UNMET',
            requirements: ['supported_brand', 'active_location', 'brand_new_rule'],
          });
        },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: EN.publish }));
    const list = await screen.findByTestId('unmet');
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      `${EN.unmet.active_location}${EN.goTo.location}`,
      `${EN.unmet.supported_brand}${EN.goTo.services}`,
      EN.unmet.other,
    ]);
    fireEvent.click(within(rows[0]!).getByRole('button', { name: EN.goTo.location }));
    expect(await screen.findByRole('heading', { name: EN.titles.location })).toBeTruthy();
  });

  it('saves the hours, publishes and shows the live profile with what to finish later', async () => {
    let published = false;
    const { api } = renderStart(
      draftHandlers(ready, {
        'availability.rule_create': (a) => ({ id: `r${(a.body as { day_of_week: number }).day_of_week}`, ...(a.body as object) }),
        'org.location_update': () => ({ ...location, version: 3 }),
        'provider.publish': () => ((published = true), { public_status: 'published', unmet: [] }),
        // After the publish the business is re-read for its new slug.
        'org.get': () => (published ? org({ status: 'active', slug: 'reza-auto' }) : org()),
      }),
    );
    // Friday off, Monday shorter.
    const monday = await screen.findByLabelText('Monday closes at');
    fireEvent.change(monday, { target: { value: '16:00' } });
    fireEvent.click(screen.getByRole('button', { name: EN.publish }));
    expect(await screen.findByRole('heading', { name: EN.result.title })).toBeTruthy();
    const rules = api.calls
      .filter((c) => c.opId === 'availability.rule_create')
      .map((c) => c.args.body as { day_of_week: number; end_time: string });
    expect(rules.map((r) => r.day_of_week).sort()).toEqual([0, 1, 2, 3, 4, 6]);
    expect(rules.find((r) => r.day_of_week === 1)!.end_time).toBe('16:00');
    expect(api.calls.find((c) => c.opId === 'org.location_update')!.args).toMatchObject({
      ifMatch: '"v2"',
      body: { hours: { weekly: expect.any(Array) } },
    });
    expect(api.calls.some((c) => c.opId === 'org.verification_submit')).toBe(false);
    await waitFor(() =>
      expect(api.calls.filter((c) => c.opId === 'onboarding.update').map((c) => c.args.body)).toContainEqual({
        current_step: 'done',
        completed_step: 'hours',
        status: 'completed',
      }),
    );
    expect(screen.getByRole('link', { name: EN.result.profile }).getAttribute('href')).toBe('/en/shop/reza-auto');
    expect(screen.getByText(EN.result.pendingChip)).toBeTruthy();
    expect(screen.getByRole('link', { name: new RegExp(EN.result.later.team) }).getAttribute('href')).toContain(
      `/en/provider/team?org=${ORG}`,
    );
    expect(screen.getByRole('link', { name: EN.result.today }).getAttribute('href')).toBe('/en/provider/today');
  });
});

describe('Today for an unpublished business', () => {
  it('offers the owner to continue setting up; staff only see that it is not live', async () => {
    const today: Handlers = {
      'provider.profile_get': () => ({ ...profile, measured_response_time_minutes: null, completeness_gaps: [] }),
      'provider.appointments_list': () => page([]),
      'reviews.org_list': () => page([]),
      'review_approvals.list': () => page([]),
      'provider.portfolio_list': () => page([]),
    };
    const first = renderApp(
      <WorkshopProvider>
        <TodayWhenReady />
      </WorkshopProvider>,
      { locale: 'en', session: signedIn('Reza'), handlers: { ...today, 'me.memberships_list': () => page([membership('draft')]) } },
    );
    expect(await screen.findByText(BUNDLED.en.provider.today.draftTitle)).toBeTruthy();
    expect(screen.getByRole('link', { name: BUNDLED.en.provider.today.draftAction }).getAttribute('href')).toBe('/en/provider/start');
    first.unmount();

    renderApp(
      <WorkshopProvider>
        <TodayWhenReady />
      </WorkshopProvider>,
      {
        locale: 'en',
        session: signedIn('Reza'),
        handlers: { ...today, 'me.memberships_list': () => page([membership('draft', 'provider_staff')]) },
      },
    );
    expect(await screen.findByText(BUNDLED.en.provider.today.draftTitle)).toBeTruthy();
    expect(screen.queryByRole('link', { name: BUNDLED.en.provider.today.draftAction })).toBeNull();
  });
});

function TodayWhenReady() {
  return (
    <WorkshopGate>
      <WorkshopToday />
    </WorkshopGate>
  );
}
