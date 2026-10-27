// P7.T7 (DOM): My Garage — the list with the plan line, chips and the parked group; inline mileage with the
// "Mileage went down" warning; the C-PLAN-01 modal at the limit; ownership requests (owner accepts after the list of
// what moves); the record form keeping its input on a 412 (GD-09 amendment 5); W-GAR-03 on 409 limit and duplicate
// VIN ("Did you buy this car?"); the AI-off card; the Jalali date field.
import type { ServiceRecord, TaxonomyNode, Vehicle, VehicleTransfer } from '@carpal/api-contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '../../../tests/support/next-navigation';
import { renderApp, signedIn, type Handlers } from '../../../tests/support/render-app';
import { DateField } from '@/components/fields/date-field';
import { Dialog } from '@/components/shell/dialog';
import { ApiProblem } from '@/lib/api/problem';
import { VehicleAiTips } from './ai';
import { GarageScreen } from './garage-screen';
import { RecordFormScreen } from './record-form';
import { VehicleFormScreen } from './vehicle-form';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));
vi.mock('next/link', () => import('../../../tests/support/next-link'));

const V1 = '0195f3b1-6a2b-7c3d-8e4f-0000000000e1';
const V2 = '0195f3b1-6a2b-7c3d-8e4f-0000000000e2';
const V3 = '0195f3b1-6a2b-7c3d-8e4f-0000000000e3';
const R1 = '0195f3b1-6a2b-7c3d-8e4f-0000000000f1';
const BRAND = 'brand-bmw';
const MODEL = 'model-320';
const SYSTEM = 'sys-brakes';

const node = (id: string, type: TaxonomyNode['type'], name: string, parent: string | null = null): TaxonomyNode => ({
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

const NODES: Record<string, TaxonomyNode[]> = {
  vehicle_brand: [node(BRAND, 'vehicle_brand', 'BMW')],
  vehicle_model: [node(MODEL, 'vehicle_model', '320i', BRAND)],
  service_system: [node(SYSTEM, 'service_system', 'Brakes')],
};

function vehicle(o: Partial<Vehicle> = {}): Vehicle {
  return {
    id: V1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 3,
    nickname: 'Silver',
    brand_node_id: BRAND,
    model_node_id: MODEL,
    year: 2008,
    mileage_km: 152400,
    owner_type: 'user',
    owner_id: 'u1',
    vin_present: true,
    vin_last4: '4521',
    vin_decode_status: 'decoded',
    vin_decoded_at: null,
    status: 'active',
    profile_completeness: 70,
    assigned_driver: null,
    open_issue_count: 1,
    next_reminder_due: null,
    primary_photo_url: null,
    duplicate_vin_warning: false,
    ...o,
  };
}

function base(o: { vehicles?: Vehicle[]; used?: number; transfers?: VehicleTransfer[] } = {}): Handlers {
  const vehicles = o.vehicles ?? [vehicle(), vehicle({ id: V2, nickname: 'Old Pride', status: 'sold', open_issue_count: 0 })];
  return {
    'vehicles.list': () => ({ items: vehicles, next_cursor: null }),
    'vehicles.get': (a) => vehicles.find((v) => v.id === (a.path as { vehicle_id: string }).vehicle_id) ?? vehicles[0],
    'subscription.me_get': () => ({
      plan: { plan_key: 'individual_free', max_vehicles: 5 },
      usage: { active_vehicles: o.used ?? vehicles.filter((v) => v.status === 'active').length },
    }),
    'vehicles.transfers_list': () => ({ items: o.transfers ?? [], next_cursor: null }),
    'vehicles.mileage_list': () => ({ items: [], next_cursor: null }),
    'issues.list': () => ({ items: [], next_cursor: null }),
    'reminders.list': () => ({ items: [], next_cursor: null }),
    'service_records.list': () => ({ items: [], next_cursor: null }),
    'taxonomy.snapshot': (a) => ({ items: NODES[(a.query as { type: string }).type] ?? [], next_cursor: null }),
  };
}

beforeEach(() => {
  navigation.reset(`/en/garage/${V1}/overview`);
  localStorage.clear();
});

describe('W-GAR-01 My Garage', () => {
  it('lists vehicles with the plan line, chips and the collapsed sold group, and the selected car', async () => {
    renderApp(<GarageScreen vehicleId={V1} tab="overview" />, { locale: 'en', session: signedIn(), handlers: base() });
    expect(await screen.findByTestId('plan-line')).toHaveTextContent('1 of 5 vehicles on the free plan');
    const list = screen.getByRole('navigation', { name: 'Your vehicles' });
    expect(within(list).getAllByText('Silver')[0]!.closest('a')).toHaveAttribute('aria-current', 'page');
    expect(within(list).getByText('1 open issue')).toBeInTheDocument();
    expect(within(list).getByText('Sold & inactive (1)')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: 'Silver' })).toBeInTheDocument();
    expect(screen.getByTestId('vin')).toHaveTextContent('4521');
    expect(screen.getByRole('link', { name: 'Service history' })).toHaveAttribute('href', `/en/garage/${V1}/history`);
  });

  it('edits mileage inline and asks before saving a lower value', async () => {
    const handlers = { ...base(), 'vehicles.mileage_add': vi.fn((_args: Record<string, unknown>) => ({ id: 'm1' })) };
    renderApp(<GarageScreen vehicleId={V1} tab="overview" />, { locale: 'en', session: signedIn(), handlers });
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    const input = screen.getByLabelText('New mileage');
    fireEvent.change(input, { target: { value: '15240' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Mileage went down — correct a typo?')).toBeInTheDocument();
    expect(handlers['vehicles.mileage_add']).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(handlers['vehicles.mileage_add']).toHaveBeenCalledTimes(1));
    expect(handlers['vehicles.mileage_add'].mock.calls[0]![0]).toMatchObject({ path: { vehicle_id: V1 }, body: { mileage_km: 15240 } });
  });

  it('opens the vehicle limit panel at the limit and frees a slot', async () => {
    const vehicles = [vehicle(), vehicle({ id: V3, nickname: 'Van' })];
    const handlers = { ...base({ vehicles, used: 5 }), 'vehicles.status_change': vi.fn(() => vehicles[1]) };
    renderApp(<GarageScreen vehicleId={V1} tab="overview" />, { locale: 'en', session: signedIn(), handlers });
    fireEvent.click(await screen.findByRole('button', { name: 'Add vehicle' }));
    const dialog = await screen.findByRole('dialog', { name: 'Vehicle limit' });
    expect(within(dialog).getByText('The free plan includes 5 active vehicles.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Mark as sold' })[1]!);
    await waitFor(() =>
      expect(handlers['vehicles.status_change']).toHaveBeenCalledWith(
        expect.objectContaining({ path: { vehicle_id: V3 }, body: { status: 'sold' } }),
      ),
    );
    await waitFor(() => expect(navigation.pathname).toBe('/en/garage/add'));
  });

  it('lets the owner accept an ownership request after showing what moves', async () => {
    const transfer: VehicleTransfer = {
      id: 'tr1',
      created_at: '2026-10-20T00:00:00Z',
      updated_at: '2026-10-20T00:00:00Z',
      version: 1,
      direction: 'incoming',
      vehicle_id: V1,
      vehicle_summary: { brand_node_id: BRAND, model_node_id: MODEL, year: 2008, vin_last4: '4521' },
      requester_display: 'Reza K.',
      message: 'I bought Silver last week.',
      status: 'pending',
      decided_at: null,
      expires_at: '2026-11-03T00:00:00Z',
    };
    const handlers = { ...base({ transfers: [transfer] }), 'vehicles.transfer_decide': vi.fn(() => ({ ...transfer, status: 'accepted' })) };
    renderApp(<GarageScreen vehicleId={V1} tab="overview" />, { locale: 'en', session: signedIn(), handlers });
    const block = await screen.findByTestId('ownership-requests');
    expect(within(block).getByText('Reza K. says they bought this car')).toBeInTheDocument();
    expect(within(block).getByText('I bought Silver last week.')).toBeInTheDocument();
    fireEvent.click(within(block).getByRole('button', { name: 'Accept' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move this car to the new owner?' });
    expect(within(dialog).getByText('Service history and invoices')).toBeInTheDocument();
    expect(handlers['vehicles.transfer_decide']).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move the car' }));
    await waitFor(() =>
      expect(handlers['vehicles.transfer_decide']).toHaveBeenCalledWith(
        expect.objectContaining({ path: { transfer_id: 'tr1' }, body: { decision: 'accept' } }),
      ),
    );
  });
});

describe('W-GAR-02 record form', () => {
  const rec: ServiceRecord = {
    id: R1,
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-01T00:00:00Z',
    version: 2,
    service_date: '2026-03-01',
    service_system_node_id: SYSTEM,
    description: 'Front pads',
    visibility: 'private',
    vehicle_id: V1,
    source_type: 'user_manual',
    verification_status: 'self_reported',
    provider: null,
    appointment_id: null,
    job_log_id: null,
    next_service_insight_id: null,
    created_by_type: 'user',
    status: 'active',
    evidence: [],
  };

  it('keeps what was typed when the record changed elsewhere (412) and reloads on request', async () => {
    const get = vi.fn(() => rec);
    const handlers: Handlers = {
      ...base(),
      'service_records.get': get,
      'service_records.update': () => {
        throw new ApiProblem(412, { code: 'VERSION_MISMATCH' });
      },
    };
    navigation.reset(`/en/garage/${V1}/records/${R1}/edit`);
    renderApp(<RecordFormScreen vehicleId={V1} recordId={R1} />, { locale: 'en', session: signedIn(), handlers });
    const text = await screen.findByLabelText('What was done?');
    fireEvent.change(text, { target: { value: 'Front pads and both discs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This changed elsewhere — reload')).toBeInTheDocument();
    expect(screen.getByLabelText('What was done?')).toHaveValue('Front pads and both discs');
    const before = get.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(before));
    expect(await screen.findByText(/Loaded the latest version/)).toBeInTheDocument();
    expect(screen.getByLabelText('What was done?')).toHaveValue('Front pads and both discs');
  });
});

describe('W-GAR-03 add vehicle', () => {
  async function fillCar() {
    await screen.findByRole('option', { name: 'BMW' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Brand' }), { target: { value: BRAND } });
    await screen.findByRole('option', { name: '320i' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: MODEL } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Year' }), { target: { value: '2008' } });
  }

  it('opens the limit panel on 409 VEHICLE_LIMIT_REACHED and keeps the entered data', async () => {
    const handlers: Handlers = {
      ...base({ used: 5 }),
      'vehicles.create': () => {
        throw new ApiProblem(409, { code: 'VEHICLE_LIMIT_REACHED' });
      },
    };
    navigation.reset('/en/garage/add');
    renderApp(<VehicleFormScreen vehicleId={null} />, { locale: 'en', session: signedIn(), handlers });
    await fillCar();
    fireEvent.change(screen.getByLabelText('Nickname'), { target: { value: 'Blue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('dialog', { name: 'Vehicle limit' })).toBeInTheDocument();
    expect(screen.getByLabelText('Nickname')).toHaveValue('Blue');
  });

  it('offers "Did you buy this car?" for a VIN in another garage', async () => {
    const request = vi.fn(() => ({ id: 'tr9', status: 'pending', expires_at: '2026-11-09T00:00:00Z' }));
    const handlers: Handlers = {
      ...base(),
      'vehicles.create': () => {
        throw new ApiProblem(409, { code: 'DUPLICATE', vin_transfer_available: true });
      },
      'vehicles.transfer_request': request,
    };
    navigation.reset('/en/garage/add');
    renderApp(<VehicleFormScreen vehicleId={null} />, { locale: 'en', session: signedIn(), handlers });
    fireEvent.change(await screen.findByLabelText('VIN (optional)'), { target: { value: 'wba vb7 1050 kx12345' } });
    await fillCar();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Did you buy this car?')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Message to the owner (optional)'), { target: { value: 'Bought it in October.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for the car' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ body: { vin: 'WBAVB71050KX12345', message: 'Bought it in October.' } }),
      ),
    );
    expect(await screen.findByText('Request sent')).toBeInTheDocument();
  });
});

describe('AI and dates', () => {
  it('shows the AI-off state when the AI answers 503 AI_UNAVAILABLE (BA-02)', async () => {
    const handlers: Handlers = {
      ...base(),
      'ai.vehicle_suggestions': () => {
        throw new ApiProblem(503, { code: 'AI_UNAVAILABLE' });
      },
    };
    renderApp(<VehicleAiTips vehicle={vehicle()} />, {
      locale: 'en',
      session: signedIn(),
      handlers,
      flags: { 'ai.vehicle_helper.enabled': true },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Get maintenance tips' }));
    expect(await screen.findByText('AI help is off right now. Your history and reminders work as usual.')).toBeInTheDocument();
  });

  it('hides the AI card while its flag is off', () => {
    const { container } = renderApp(<VehicleAiTips vehicle={vehicle()} />, { locale: 'en', session: signedIn(), handlers: base() });
    expect(container.querySelector('[data-ai-state]')).toBeNull();
  });

  it('picks dates in the Jalali calendar in FA and reports ISO dates', async () => {
    const seen: string[] = [];
    function Probe() {
      const [v, setV] = useState('');
      return (
        <DateField
          label="تاریخ"
          value={v}
          onChange={(iso) => {
            seen.push(iso);
            setV(iso);
          }}
        />
      );
    }
    renderApp(<Probe />, { locale: 'fa', session: signedIn() });
    fireEvent.change(screen.getByRole('combobox', { name: 'تاریخ سال' }), { target: { value: '1405' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'تاریخ ماه' }), { target: { value: '8' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'تاریخ روز' }), { target: { value: '3' } });
    expect(seen.at(-1)).toBe('2026-10-25');
    expect(screen.getByRole('combobox', { name: 'تاریخ ماه' })).toHaveDisplayValue('آبان');
  });
});

describe('dialogs over drawers', () => {
  it('closes only the top dialog on Escape (the document preview over the record drawer)', () => {
    const closed: string[] = [];
    renderApp(
      <Dialog name="drawer" variant="panel" open onClose={() => closed.push('drawer')} title="Record">
        <Dialog name="preview" open onClose={() => closed.push('preview')} title="Invoice">
          <p>preview</p>
        </Dialog>
      </Dialog>,
      { locale: 'en', session: signedIn() },
    );
    fireEvent(screen.getByRole('dialog', { name: 'Invoice' }), new Event('cancel', { cancelable: true }));
    expect(closed).toEqual(['preview']);
  });
});
