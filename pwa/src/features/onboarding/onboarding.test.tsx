// P4.T6/T7: the onboarding check after every sign-in and the stepper (saves with If-Match, first car with VIN
// suggestions, "Did you buy this car?", skip, finish), with the real providers and a fake typed client.
import type { TaxonomyNode, TaxonomyType } from '@carpal/api-contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guest, renderApp, signedIn, type Handlers } from '../../../tests/support/render-app';
import { navigation, router } from '../../../tests/support/next-navigation';
import { ApiProblem } from '@/lib/api/problem';
import { goTo } from '@/lib/browser-nav';
import { HELP_DRAFT_KEY } from './account';
import { Onboarding } from './onboarding';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));
vi.mock('next/link', () => import('../../../tests/support/next-link'));
vi.mock('@/lib/browser-nav', () => ({ goTo: vi.fn() }));

const NEXT = '/en/shop/reza';

const node = (id: string, type: TaxonomyType, name: string, parent: string | null = null): TaxonomyNode => ({
  id,
  type,
  parent_id: parent,
  name: { text: name, locale: 'en' },
  description: null,
  slug: id,
  regions: [],
  attributes: null,
  sort_order: 0,
  status: 'active',
  merged_into_id: null,
});
const NODES = [
  node('bmw', 'vehicle_brand', 'BMW'),
  node('s3', 'vehicle_model', '3 Series', 'bmw'),
  node('e90', 'vehicle_series', 'E90', 's3'),
];
const snapshot = ({ query }: Record<string, unknown>) => {
  const q = query as { type: TaxonomyType; parent_id?: string };
  return { items: NODES.filter((n) => n.type === q.type && (!q.parent_id || n.parent_id === q.parent_id)), next_cursor: null };
};

function progress(over: Record<string, unknown> = {}) {
  return {
    id: 'onb-1',
    created_at: '2026-10-25T10:00:00Z',
    updated_at: '2026-10-25T10:00:00Z',
    version: 1,
    flow_type: 'individual',
    organization_id: null,
    current_step: 'role',
    completed_steps: [],
    status: 'in_progress',
    completed_at: null,
    assisted: false,
    assisted_by_display_name: null,
    ...over,
  };
}

const vehicle = (over: Record<string, unknown> = {}) => ({
  id: 'v1',
  version: 1,
  brand_node_id: 'bmw',
  model_node_id: 's3',
  series_node_id: 'e90',
  year: 2012,
  nickname: 'Silver',
  status: 'active',
  ...over,
});

beforeEach(() => {
  navigation.reset(`/en/onboarding?next=${encodeURIComponent(NEXT)}`);
  vi.mocked(goTo).mockClear();
  sessionStorage.clear();
  localStorage.clear();
});

describe('after sign-in (P4.T7)', () => {
  it('a finished account goes straight on to the page', async () => {
    renderApp(<Onboarding next={NEXT} portalUrl="https://portal.test/signup" policyVersion="2026-10" />, {
      locale: 'en',
      session: signedIn(),
      handlers: { 'onboarding.list': () => ({ items: [progress({ status: 'completed' })], next_cursor: null }) },
    });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(NEXT));
  });

  it('a failed sign-in passes its outcome on; a guest who came here directly signs in first', async () => {
    navigation.reset(`/en/onboarding?next=${encodeURIComponent(NEXT)}&signin=cancelled`);
    const first = renderApp(<Onboarding next={NEXT} portalUrl="x" policyVersion="v" />, { locale: 'en', session: guest });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`${NEXT}?signin=cancelled`));
    first.unmount();

    navigation.reset(`/en/onboarding?next=${encodeURIComponent(NEXT)}`);
    window.history.replaceState(null, '', `/en/onboarding?next=${encodeURIComponent(NEXT)}`);
    renderApp(<Onboarding next={NEXT} portalUrl="x" policyVersion="v" />, { locale: 'en', session: guest });
    await waitFor(() => expect(goTo).toHaveBeenCalledWith(expect.stringMatching(/^\/bff\/login\?return_to=%2Fen%2Fonboarding%3Fnext%3D/)));
  });
});

describe('the stepper (P4.T6)', () => {
  it('new account: role → first car (VIN suggestion kept) → skip the problem → finish, then the page', async () => {
    sessionStorage.setItem(
      'cp:signup-choices',
      JSON.stringify({ marketing: true, aiPersonalization: false, policyVersion: '2026-10', at: Date.now() }),
    );
    let version = 0;
    const updates: Record<string, unknown>[] = [];
    const handlers: Handlers = {
      'onboarding.list': () => ({ items: [], next_cursor: null }),
      'onboarding.update': (args) => {
        updates.push(args);
        version += 1;
        return progress({ version, current_step: (args.body as { current_step: string }).current_step });
      },
      'taxonomy.snapshot': snapshot,
      'vehicles.list': () => ({ items: [], next_cursor: null }),
      'vehicles.create': () => vehicle(),
      'vehicles.vin_decode': () => ({ decode_status: 'partial', suggested: { year: 2011 }, decoder_source: 'carpal-local' }),
      'consents.grant': () => ({}),
      'me.preferences_get': () => ({}),
      'me.preferences_update': () => ({}),
      'me.get': () => ({ timezone: 'Pacific/Chatham' }),
      'me.update': () => ({}),
    };
    const { api } = renderApp(<Onboarding next={NEXT} portalUrl="https://portal.test/signup" policyVersion="2026-10" />, {
      locale: 'en',
      session: signedIn(),
      handlers,
    });

    // 1. How you'll use CarPal: a business choice points to the portal; the individual path goes on.
    expect(await screen.findByRole('heading', { name: 'How will you mainly use CarPal?' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/I run a repair or service business/));
    expect(screen.getByRole('link', { name: 'Open the business portal' })).toHaveAttribute('href', 'https://portal.test/signup');
    fireEvent.click(screen.getByRole('button', { name: 'Continue as an individual' }));

    // 2. First car.
    expect(await screen.findByRole('heading', { name: 'Add your car' })).toBeInTheDocument();
    expect(updates[0]).toMatchObject({
      path: { flow_type: 'individual' },
      body: { current_step: 'vehicle', completed_step: 'role' },
      ifMatch: '"v1"',
    });
    await waitFor(() => expect(screen.getByRole('option', { name: 'BMW' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Brand'), { target: { value: 'bmw' } });
    await waitFor(() => expect(screen.getByRole('option', { name: '3 Series' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 's3' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'E90' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Series (optional)'), { target: { value: 'e90' } });
    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '2012' } });
    fireEvent.change(screen.getByLabelText('VIN (optional)'), { target: { value: 'wbaph5c55ba274521' } });
    fireEvent.change(screen.getByLabelText('Nickname (optional)'), { target: { value: 'Silver' } });
    fireEvent.change(screen.getByLabelText('Mileage (optional)'), { target: { value: '۱۴۸۰۰۰' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save vehicle' }));
    expect(await screen.findByText('This VIN suggests 2011; you entered 2012.')).toBeInTheDocument();
    expect(api.calls.find((c) => c.opId === 'vehicles.create')!.args).toEqual({
      body: {
        brand_node_id: 'bmw',
        model_node_id: 's3',
        series_node_id: 'e90',
        year: 2012,
        vin: 'WBAPH5C55BA274521',
        mileage_km: 148000,
        nickname: 'Silver',
      },
    });
    expect(localStorage.getItem('cp:active-vehicle')).toBe('v1');
    fireEvent.click(screen.getByRole('button', { name: 'Keep 2012' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // 3. Anything wrong? — skipped.
    expect(await screen.findByRole('heading', { name: 'Is anything wrong with this car right now?' })).toBeInTheDocument();
    expect(updates[1]).toMatchObject({ body: { current_step: 'problem', completed_step: 'vehicle' }, ifMatch: '"v1"' });
    expect(screen.getByRole('button', { name: 'Get help' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    // 4. Permissions → finish.
    expect(await screen.findByRole('heading', { name: 'Permissions' })).toBeInTheDocument();
    expect(updates[2]).toEqual({ path: { flow_type: 'individual' }, body: { current_step: 'permissions' }, ifMatch: '"v2"' });
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(NEXT));
    expect(updates[3]).toMatchObject({
      body: { current_step: 'done', completed_step: 'permissions', status: 'completed' },
      ifMatch: '"v3"',
    });

    // Sign-up choices became a consent and a preference (DI-30); the account time zone follows the browser (OQ-13).
    expect(api.calls.find((c) => c.opId === 'consents.grant')!.args).toEqual({
      body: { consent_type: 'marketing', policy_version: '2026-10', granted_to: { type: 'platform' } },
    });
    expect(api.calls.find((c) => c.opId === 'me.preferences_update')!.args).toEqual({ body: { marketing_opt_in: true } });
    expect(api.calls.find((c) => c.opId === 'me.update')!.args).toEqual({
      body: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    });
  });

  it('resumes at the saved step with its version, and keeps a Help Me draft', async () => {
    const updates: Record<string, unknown>[] = [];
    renderApp(<Onboarding next={NEXT} portalUrl="x" policyVersion="2026-10" />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'onboarding.list': () => ({ items: [progress({ current_step: 'problem', version: 4 })], next_cursor: null }),
        'onboarding.update': (args) => {
          updates.push(args);
          return progress({ version: 5 });
        },
      },
    });
    expect(await screen.findByRole('heading', { name: 'Is anything wrong with this car right now?' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Describe what’s happening'), { target: { value: 'Clunk over speed bumps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suspension / clunk' }));
    fireEvent.click(screen.getByRole('button', { name: 'Get help' }));
    await screen.findByRole('heading', { name: 'Permissions' });
    expect(updates[0]).toMatchObject({ body: { current_step: 'permissions', completed_step: 'problem' }, ifMatch: '"v4"' });
    expect(JSON.parse(localStorage.getItem(HELP_DRAFT_KEY)!)).toMatchObject({
      vehicleId: null,
      text: 'Clunk over speed bumps',
      symptoms: ['suspension'],
    });
  });

  it('a VIN in another garage: "Did you buy this car?" asks the owner for a transfer (BA-04)', async () => {
    const handlers: Handlers = {
      'onboarding.list': () => ({ items: [progress({ current_step: 'vehicle' })], next_cursor: null }),
      'onboarding.update': () => progress({ version: 2, current_step: 'problem' }),
      'taxonomy.snapshot': snapshot,
      'vehicles.create': () => {
        throw new ApiProblem(409, { code: 'DUPLICATE', vin_transfer_available: true });
      },
      'vehicles.transfer_request': () => ({ id: 't1', status: 'pending' }),
    };
    const { api } = renderApp(<Onboarding next={NEXT} portalUrl="x" policyVersion="2026-10" />, {
      locale: 'en',
      session: signedIn(),
      handlers,
    });
    await screen.findByRole('heading', { name: 'Add your car' });
    await waitFor(() => expect(screen.getByRole('option', { name: 'BMW' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Brand'), { target: { value: 'bmw' } });
    await waitFor(() => expect(screen.getByRole('option', { name: '3 Series' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 's3' } });
    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '2012' } });
    fireEvent.change(screen.getByLabelText('VIN (optional)'), { target: { value: 'WBAPH5C55BA274521' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save vehicle' }));
    expect(await screen.findByText('Did you buy this car?')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Message to the owner (optional)'), { target: { value: 'I bought it in May.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for the car' }));
    expect(await screen.findByText(/Request sent/)).toBeInTheDocument();
    expect(api.calls.find((c) => c.opId === 'vehicles.transfer_request')!.args).toEqual({
      body: { vin: 'WBAPH5C55BA274521', message: 'I bought it in May.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Is anything wrong with this car right now?' });
  });

  it('checks the car before saving: brand and model, year, VIN letters', async () => {
    const { api } = renderApp(<Onboarding next={NEXT} portalUrl="x" policyVersion="2026-10" />, {
      locale: 'en',
      session: signedIn(),
      handlers: {
        'onboarding.list': () => ({ items: [progress({ current_step: 'vehicle' })], next_cursor: null }),
        'taxonomy.snapshot': snapshot,
      },
    });
    await screen.findByRole('heading', { name: 'Add your car' });
    fireEvent.change(screen.getByLabelText('VIN (optional)'), { target: { value: 'WBAPH5C55BA27452O' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save vehicle' }));
    expect(screen.getByText('Choose the brand and the model.')).toBeInTheDocument();
    expect(screen.getByText('Choose the year of the car.')).toBeInTheDocument();
    expect(screen.getByText('VINs never use the letters I, O or Q.')).toBeInTheDocument();
    expect(api.calls.some((c) => c.opId === 'vehicles.create')).toBe(false);
  });
});
