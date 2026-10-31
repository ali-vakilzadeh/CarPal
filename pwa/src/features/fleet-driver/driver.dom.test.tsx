// P12.T4/T5 (DOM): DRV-WEB — the driver home lists the assigned vehicles of each fleet (and says when none is
// assigned), the F-ISSUE-01 report sends to the fleet route with the raised urgency and the odometer, a report made
// offline is queued and sent when the browser is back online; the offline page lists the saved pages; the header's
// install button follows the second-visit rule.
import type { Membership, Vehicle } from '@carpal/api-contracts';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp, signedIn, type Handlers } from '../../../tests/support/render-app';
import { InstallButton, OfflineScreen } from '@/features/pwa';
import { ApiProblem } from '@/lib/api/problem';
import { BUNDLED } from '@/lib/i18n/dictionary';
import { DriverHome, DriverReport } from './driver-screens';
import { storeKey } from './model';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));
vi.mock('next/link', () => import('../../../tests/support/next-link'));
vi.mock('@/lib/browser-nav', () => ({ goTo: vi.fn() }));

const FA = BUNDLED.fa;
const ORG = '0195f3b1-6a2b-7c3d-8e4f-0000000000f1';
const VEH = '0195f3b1-6a2b-7c3d-8e4f-0000000000c1';

const membership = (o: Partial<Membership> = {}): Membership =>
  ({
    id: 'm1',
    created_at: '',
    updated_at: '',
    role: 'fleet_driver',
    status: 'active',
    joined_at: '2026-10-30T10:00:00Z',
    organization: {
      id: ORG,
      name: 'Tehran Taxi',
      organization_type: 'fleet',
      slug: null,
      logo_url: null,
      status: 'active',
      verification_status: 'unverified',
    },
    ...o,
  }) as Membership;

const vehicle = (o: Partial<Vehicle> = {}): Vehicle =>
  ({
    id: VEH,
    created_at: '',
    updated_at: '',
    version: 1,
    owner_type: 'organization',
    owner_id: ORG,
    brand_node_id: 'b1',
    model_node_id: 'm1',
    year: 2019,
    nickname: 'Van 12',
    license_plate: '12 B 345',
    mileage_km: 81000,
    vin_present: false,
    vin_last4: null,
    vin_decode_status: 'not_attempted',
    vin_decoded_at: null,
    status: 'active',
    profile_completeness: 50,
    assigned_driver: { user_id: 'u1', display_name: 'Sara M.' },
    open_issue_count: 0,
    next_reminder_due: null,
    primary_photo_url: null,
    duplicate_vin_warning: false,
    ...o,
  }) as Vehicle;

const base: Handlers = {
  'me.memberships_list': () => ({ items: [membership()], next_cursor: null }),
  'vehicles.list': () => ({ items: [vehicle()], next_cursor: null }),
  'vehicles.get': () => vehicle(),
  'taxonomy.snapshot': () => ({ items: [], next_cursor: null }),
};

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

afterEach(() => {
  setOnline(true);
  localStorage.clear();
  sessionStorage.clear();
});

describe('driver home', () => {
  it('lists the assigned vehicles of each fleet with Report an issue', async () => {
    renderApp(<DriverHome />, { session: signedIn(), handlers: base });
    expect(await screen.findByRole('heading', { level: 2, name: 'Tehran Taxi' })).toBeInTheDocument();
    expect(await screen.findByText('Van 12')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: FA.driver.report })).toHaveAttribute('href', `/fa/drive/${ORG}/${VEH}/report`);
  });

  it('says when no vehicle is assigned, and when the user drives for no fleet', async () => {
    const { unmount } = renderApp(<DriverHome />, {
      session: signedIn(),
      handlers: { ...base, 'vehicles.list': () => ({ items: [], next_cursor: null }) },
    });
    expect(await screen.findByText(FA.driver.noVehicleTitle)).toBeInTheDocument();
    unmount();
    renderApp(<DriverHome />, {
      session: signedIn(),
      handlers: {
        ...base,
        'me.memberships_list': () => ({ items: [membership({ role: 'individual', organization: null })], next_cursor: null }),
      },
    });
    expect(await screen.findByText(FA.driver.noFleetTitle)).toBeInTheDocument();
  });
});

describe('issue report (F-ISSUE-01)', () => {
  it('sends to the fleet route: shortcut title, safety-critical when unsafe, then the odometer', async () => {
    const {
      api: { calls },
    } = renderApp(<DriverReport orgId={ORG} vehicleId={VEH} />, {
      session: signedIn(),
      handlers: {
        ...base,
        'issues.create': () => ({ id: 'i1' }),
        'vehicles.mileage_add': () => ({ id: 'ml1', lower_than_previous: false }),
        'issues.list': () => ({ items: [], next_cursor: null }),
      },
    });
    await screen.findByText('Van 12');
    fireEvent.click(screen.getByRole('button', { name: FA.driver.shortcut.brakes }));
    fireEvent.change(screen.getByLabelText(FA.driver.form.description), { target: { value: 'ترمز صدا می‌دهد و نرم است' } });
    fireEvent.click(screen.getByLabelText(FA.driver.form.unsafe));
    expect(screen.getByText(FA.driver.safety.title)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(FA.driver.form.mileage), { target: { value: '۸۱۵۰۰' } });
    fireEvent.click(screen.getByRole('button', { name: FA.driver.form.submit }));
    expect(await screen.findByText(FA.driver.done.title)).toBeInTheDocument();
    const create = calls.find((c) => c.opId === 'issues.create')!;
    expect(create.args).toMatchObject({
      path: { org_id: ORG, vehicle_id: VEH },
      body: { title: FA.driver.shortcut.brakes, urgency_level: 'safety_critical', content_locale: 'fa' },
    });
    expect(calls.find((c) => c.opId === 'vehicles.mileage_add')!.args).toMatchObject({
      path: { org_id: ORG, vehicle_id: VEH },
      body: { mileage_km: 81500 },
    });
  });

  it('checks the description and the odometer before sending', async () => {
    const {
      api: { calls },
    } = renderApp(<DriverReport orgId={ORG} vehicleId={VEH} />, { session: signedIn(), handlers: base });
    await screen.findByText('Van 12');
    fireEvent.change(screen.getByLabelText(FA.driver.form.description), { target: { value: 'کوتاه' } });
    fireEvent.change(screen.getByLabelText(FA.driver.form.mileage), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: FA.driver.form.submit }));
    expect(await screen.findByText(FA.driver.errors.description)).toBeInTheDocument();
    expect(screen.getByText(FA.driver.errors.mileage)).toBeInTheDocument();
    expect(calls.some((c) => c.opId === 'issues.create')).toBe(false);
  });

  it('queues the report offline and sends it once the browser is back online', async () => {
    let fail = true;
    const {
      api: { calls },
    } = renderApp(<DriverReport orgId={ORG} vehicleId={VEH} />, {
      session: signedIn(),
      handlers: {
        ...base,
        'issues.create': () => {
          if (fail) throw new ApiProblem(0, { code: 'NETWORK', title: 'offline' });
          return { id: 'i2' };
        },
      },
    });
    await screen.findByText('Van 12');
    act(() => setOnline(false));
    expect(await screen.findByText(FA.driver.form.offline)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(FA.driver.form.description), { target: { value: 'چراغ هشدار موتور روشن شد' } });
    fireEvent.click(screen.getByRole('button', { name: FA.driver.form.submitLater }));
    expect(await screen.findByText(FA.driver.done.queuedTitle)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(storeKey('u1'))!).queue).toHaveLength(1);
    expect(calls.some((c) => c.opId === 'issues.create')).toBe(false);

    fail = false;
    // The driver pages send the queue when the network is back.
    renderApp(<DriverHome />, { session: signedIn(), handlers: { ...base, 'issues.create': () => ({ id: 'i2' }) } });
    act(() => setOnline(true));
    await waitFor(() => expect(localStorage.getItem(storeKey('u1'))).toBeNull());
  });

  it('keeps a draft on this device and brings it back', async () => {
    const { unmount } = renderApp(<DriverReport orgId={ORG} vehicleId={VEH} />, { session: signedIn(), handlers: base });
    await screen.findByText('Van 12');
    fireEvent.change(screen.getByLabelText(FA.driver.form.description), { target: { value: 'لاستیک جلو کم‌باد است' } });
    fireEvent.click(screen.getByRole('button', { name: FA.driver.form.saveDraft }));
    unmount();
    renderApp(<DriverReport orgId={ORG} vehicleId={VEH} />, { session: signedIn(), handlers: base });
    expect(await screen.findByText(FA.driver.form.draftRestored)).toBeInTheDocument();
    expect(screen.getByLabelText(FA.driver.form.description)).toHaveValue('لاستیک جلو کم‌باد است');
  });
});

describe('offline page and install button', () => {
  it('lists the pages saved for the signed-in user', async () => {
    const store = new Map<string, Response>([
      [
        '/__carpal/saved-pages.json',
        new Response(
          JSON.stringify([
            { url: '/fa/garage', title: 'گاراژ من · کارپال', savedAt: '2026-10-31T09:00:00Z' },
            { url: '/en/garage', title: 'My Garage', savedAt: '2026-10-31T09:00:00Z' },
          ]),
        ),
      ],
    ]);
    vi.stubGlobal('caches', {
      keys: async () => ['cp-static', 'cp-user-u1'],
      open: async () => ({ match: async (k: string) => store.get(k)?.clone() }),
    });
    try {
      renderApp(<OfflineScreen />, { session: signedIn() });
      expect(await screen.findByRole('link', { name: /گاراژ من/ })).toHaveAttribute('href', '/fa/garage');
      expect(screen.queryByRole('link', { name: /My Garage/ })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows "Install CarPal" from the second signed-in visit once the browser offers installation', async () => {
    localStorage.setItem('cp:pwa:install', JSON.stringify({ visits: 1, dismissedAt: null, installed: false }));
    renderApp(<InstallButton />, { session: signedIn() });
    const prompt = Object.assign(new Event('beforeinstallprompt'), {
      prompt: vi.fn(async () => undefined),
      userChoice: Promise.resolve({ outcome: 'dismissed' as const }),
    });
    act(() => {
      window.dispatchEvent(prompt);
    });
    const button = await screen.findByRole('button', { name: FA.pwa.install.button });
    fireEvent.click(screen.getByRole('button', { name: FA.pwa.install.dismiss }));
    await waitFor(() => expect(screen.queryByRole('button', { name: FA.pwa.install.button })).toBeNull());
    expect(button).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('cp:pwa:install')!)).toMatchObject({ visits: 2 });
  });
});
