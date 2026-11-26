// PW4 (DOM): Update job and Close job of CarPal Workshop (PW-JOB-01). A staff member (P*) moves a job with the buttons
// the server allows; Awaiting parts sends the note, the estimated completion and the cost range (the upper end as the
// cost estimate, with If-Match); a 409 INVALID_TRANSITION reloads and says what changed; No-show appears only from the
// booked time; Cancel needs a reason; a closed job shows the record, the review invitation and the photos shortcut.
// Close job prefills the category and task from the request, sends the cost split, the part lines and the warranty,
// then the internal note; server field errors show beside the field. Today lists the jobs still in the workshop.
import type { Appointment, Membership, TaxonomyNode, TaxonomyType } from '@carpal/api-contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation, router } from '../../../tests/support/next-navigation';
import { renderApp, signedIn, type Handlers } from '../../../tests/support/render-app';
import { ApiProblem } from '@/lib/api/problem';
import { BUNDLED } from '@/lib/i18n/dictionary';
import { WorkshopCloseJob } from './close-job';
import { WorkshopProvider } from './context';
import { WorkshopJob } from './job';
import { WorkshopGate } from './shell';
import { WorkshopToday } from './today';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));
vi.mock('next/link', () => import('../../../tests/support/next-link'));
vi.mock('@/lib/browser-nav', () => ({ goTo: vi.fn() }));

const EN = BUNDLED.en.provider.jobs;
const ORG = '0195f3b1-6a2b-7c3d-8e4f-0000000000a1';
const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

const membership: Membership = {
  id: 'm1',
  role: 'provider_staff',
  status: 'active',
  organization: {
    id: ORG,
    name: 'Reza Auto Suspension',
    organization_type: 'provider',
    slug: null,
    logo_url: null,
    status: 'active',
    verification_status: 'verified',
  },
} as Membership;

const apt = (o: Partial<Appointment> = {}): Appointment =>
  ({
    id: 'sara',
    created_at: at(-72),
    version: 3,
    status: 'in_progress',
    requester_display: 'Sara M.',
    provider_location: { id: 'loc1', timezone: 'UTC' },
    vehicle: {
      id: 'v',
      brand: { text: 'BMW', locale: 'en' },
      model: { text: '320i', locale: 'en' },
      series: { text: 'E90', locale: 'en' },
      year: 2012,
      nickname: null,
    },
    safety_flag: false,
    urgency_level: 'medium',
    service_system: { text: 'Suspension', locale: 'en' },
    service_task: { text: 'Control arm replacement', locale: 'en' },
    symptom: null,
    description: 'Knock from the front right over bumps',
    content_locale: 'en',
    confirmed_start_at: at(-2),
    proposed_start_at: null,
    estimated_duration_minutes: 120,
    estimated_completion_from: null,
    estimated_completion_to: null,
    parts_availability_note: null,
    cost_estimate: null,
    cancellation_reason: null,
    cancelled_by: null,
    completed_at: null,
    service_record_id: null,
    allowed_transitions: ['awaiting_parts', 'ready_for_pickup', 'completed'],
    ...o,
  }) as Appointment;

const node = (id: string, type: TaxonomyType, name: string, parent: string | null = null): TaxonomyNode =>
  ({ id, type, parent_id: parent, name: { text: name, locale: 'en' }, status: 'active', sort_order: 0 }) as TaxonomyNode;
const NODES = [
  node('sys-brakes', 'service_system', 'Brakes'),
  node('sys-susp', 'service_system', 'Suspension'),
  node('task-arm', 'service_task', 'Control arm replacement', 'sys-susp'),
  node('task-shock', 'service_task', 'Shock absorber replacement', 'sys-susp'),
];

const page = <T,>(items: T[]) => ({ items, next_cursor: null });

function base(extra: Handlers = {}): Handlers {
  return {
    'me.memberships_list': () => page([membership]),
    'pre_visit.provider_get': () => {
      throw new ApiProblem(404, { code: 'NOT_FOUND' });
    },
    'taxonomy.snapshot': ({ query }) => {
      const q = query as { type: string; parent_id?: string };
      return page(NODES.filter((n) => n.type === q.type && (!q.parent_id || n.parent_id === q.parent_id)));
    },
    ...extra,
  };
}

function render(ui: React.ReactNode, extra: Handlers = {}) {
  return renderApp(
    <WorkshopProvider>
      <WorkshopGate>{ui}</WorkshopGate>
    </WorkshopProvider>,
    { locale: 'en', session: signedIn('Hamid'), handlers: base(extra) },
  );
}

const transitions = (api: { calls: { opId: string; args: Record<string, unknown> }[] }) =>
  api.calls.filter((c) => c.opId === 'provider.appointments_transition').map((c) => c.args.body);

beforeEach(() => navigation.reset('/en/provider/jobs/sara'));
afterEach(() => localStorage.clear());

describe('Update job (PW-JOB-01)', () => {
  it('lets a staff member move the job with the buttons the server allows', async () => {
    let current = apt();
    const { api } = render(<WorkshopJob appointmentId="sara" />, {
      'provider.appointments_get': () => current,
      'provider.appointments_transition': () => {
        current = apt({ status: 'ready_for_pickup', allowed_transitions: ['completed'] });
        return current;
      },
    });
    const bar = await screen.findByRole('region', { name: EN.progress });
    expect(within(bar).getByText(EN.steps.in_progress).closest('li')!.getAttribute('aria-current')).toBe('step');
    const group = within(bar).getByRole('group', { name: EN.update });
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([EN.actions.ready_for_pickup, EN.actions.awaiting_parts]);
    expect(within(bar).getByRole('link', { name: EN.actions.completed }).getAttribute('href')).toBe('/en/provider/jobs/sara/close');

    fireEvent.click(within(group).getByRole('button', { name: EN.actions.ready_for_pickup }));
    await waitFor(() => expect(within(bar).getByText(EN.steps.ready_for_pickup).closest('li')!.getAttribute('aria-current')).toBe('step'));
    expect(transitions(api)).toEqual([{ to: 'ready_for_pickup' }]);
    expect(screen.queryByRole('button', { name: EN.actions.awaiting_parts })).toBeNull();
  });

  it('sets Awaiting parts with the note, the estimated completion and the cost range', async () => {
    let current = apt();
    const { api } = render(<WorkshopJob appointmentId="sara" />, {
      'provider.appointments_get': () => current,
      'provider.appointments_transition': (a) => {
        current = apt({ status: 'awaiting_parts', version: 4, ...(a.body as object), allowed_transitions: ['in_progress', 'cancelled'] });
        return current;
      },
      'provider.appointments_update': (a) => {
        current = { ...current, version: 5, cost_estimate: (a.body as { cost_estimate: Appointment['cost_estimate'] }).cost_estimate };
        return current;
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: EN.actions.awaiting_parts }));
    const sheet = await screen.findByRole('dialog', { name: EN.sheets.parts.title });
    fireEvent.change(within(sheet).getByLabelText(EN.parts.note), { target: { value: 'Bushing torn. Part reserved.' } });
    const days = within(within(sheet).getByTestId('eta-days')).getAllByRole('button');
    fireEvent.click(days[1]!);
    fireEvent.change(within(sheet).getByLabelText(EN.parts.time), { target: { value: '13:00' } });
    fireEvent.change(within(sheet).getByLabelText(EN.parts.costFrom), { target: { value: '4000000' } });
    fireEvent.change(within(sheet).getByLabelText(EN.parts.costTo), { target: { value: '6000000' } });
    fireEvent.click(within(sheet).getByTestId('job-sheet-submit'));

    await waitFor(() => expect(screen.getByTestId('parts-info').textContent).toContain('Bushing torn. Part reserved.'));
    const [body] = transitions(api) as { to: string; parts_availability_note: string; estimated_completion_to: string }[];
    expect(body!.to).toBe('awaiting_parts');
    expect(body!.parts_availability_note).toMatch(/^Bushing torn\. Part reserved\. · Expected cost .*4,000,000.*6,000,000/);
    expect(body!.estimated_completion_to).toMatch(/T13:00:00(\.000)?Z$/);
    const update = api.calls.find((c) => c.opId === 'provider.appointments_update')!;
    expect(update.args.ifMatch).toBe('"v4"');
    expect((update.args.body as { cost_estimate: { amount: string } }).cost_estimate.amount).toBe('6000000');
    expect(screen.getByTestId('parts-info').textContent).toContain('Estimate:');
  });

  it('reloads and says what changed when someone else moved the job', async () => {
    let calls = 0;
    render(<WorkshopJob appointmentId="sara" />, {
      'provider.appointments_get': () => (++calls > 1 ? apt({ status: 'completed', allowed_transitions: [] }) : apt()),
      'provider.appointments_transition': () => {
        throw new ApiProblem(409, { code: 'INVALID_TRANSITION' });
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: EN.actions.ready_for_pickup }));
    expect(await screen.findByText('This job changed meanwhile. It is now: Completed.')).toBeTruthy();
  });

  it('offers No-show only from the booked time, and Cancel needs a reason', async () => {
    const booked = apt({ status: 'confirmed', confirmed_start_at: at(3), allowed_transitions: ['checked_in', 'no_show', 'cancelled'] });
    const { api } = render(<WorkshopJob appointmentId="sara" />, {
      'provider.appointments_get': () => booked,
      'provider.appointments_transition': (a) =>
        apt({ status: 'cancelled', cancelled_by: 'provider', ...(a.body as object), allowed_transitions: [] }),
    });
    const group = await screen.findByRole('group', { name: EN.update });
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([EN.actions.checked_in, EN.actions.cancelled]);
    fireEvent.click(within(group).getByRole('button', { name: EN.actions.cancelled }));
    const sheet = await screen.findByRole('dialog', { name: EN.sheets.cancel.title });
    fireEvent.click(within(sheet).getByTestId('job-sheet-submit'));
    expect(await within(sheet).findByText(EN.cancel.required)).toBeTruthy();
    fireEvent.change(within(sheet).getByLabelText(EN.cancel.reason), { target: { value: 'The lift is broken today' } });
    fireEvent.click(within(sheet).getByTestId('job-sheet-submit'));
    expect(await screen.findByText('You cancelled this visit: The lift is broken today')).toBeTruthy();
    expect(transitions(api)).toEqual([{ to: 'cancelled', cancellation_reason: 'The lift is broken today' }]);
  });

  it('offers No-show once the booked time has passed', async () => {
    render(<WorkshopJob appointmentId="sara" />, {
      'provider.appointments_get': () =>
        apt({ status: 'confirmed', confirmed_start_at: at(-1), allowed_transitions: ['checked_in', 'no_show', 'cancelled'] }),
    });
    const group = await screen.findByRole('group', { name: EN.update });
    expect(within(group).getByRole('button', { name: EN.actions.no_show })).toBeTruthy();
  });

  it('shows a closed job with the record, the review invitation and the photos shortcut', async () => {
    render(<WorkshopJob appointmentId="sara" />, {
      'provider.appointments_get': () =>
        apt({ status: 'completed', completed_at: at(-1), service_record_id: 'rec1', allowed_transitions: [] }),
    });
    const closed = await screen.findByTestId('job-closed');
    expect(closed.textContent).toContain(EN.closed.record);
    expect(closed.textContent).toContain('Sara M. gets an invitation to review your shop.');
    expect(within(closed).getByTestId('add-photos').getAttribute('href')).toBe('/en/provider/photos/new?appointment=sara');
    expect(screen.queryByRole('group', { name: EN.update })).toBeNull();
  });
});

describe('Close job (PW-JOB-01)', () => {
  const ready = () => apt({ status: 'ready_for_pickup', allowed_transitions: ['completed'] });

  it('prefills from the request and closes with the cost split, the part line, the warranty and the internal note', async () => {
    navigation.reset('/en/provider/jobs/sara/close');
    const { api } = render(<WorkshopCloseJob appointmentId="sara" />, {
      'provider.appointments_get': () => ready(),
      'provider.appointments_transition': () =>
        apt({ status: 'completed', completed_at: at(0), service_record_id: 'rec1', allowed_transitions: [] }),
      'provider.note_create': (a) => ({ id: 'n1', ...(a.body as object) }),
    });
    const system = (await screen.findByLabelText(/Service category/)) as HTMLSelectElement;
    await waitFor(() => expect(system.value).toBe('sys-susp'));
    await waitFor(() => expect((screen.getByLabelText(EN.close.task) as HTMLSelectElement).value).toBe('task-arm'));

    fireEvent.change(screen.getByLabelText(EN.close.labour), { target: { value: '1,500,000' } });
    fireEvent.change(screen.getByLabelText(EN.close.parts), { target: { value: '3000000' } });
    expect(screen.getByTestId('close-total').textContent).toContain('4,500,000');
    fireEvent.click(screen.getByRole('button', { name: EN.close.addPart }));
    const line = screen.getByTestId('part-line');
    fireEvent.change(within(line).getByLabelText(EN.close.partName), { target: { value: 'Lemförder control arm' } });
    fireEvent.change(within(line).getByLabelText(EN.close.partNumber), { target: { value: '31126776940' } });
    fireEvent.change(screen.getByLabelText(EN.close.warranty), { target: { value: '12 months on part and labour' } });
    fireEvent.change(screen.getByLabelText(EN.close.note), { target: { value: 'Left bushing starting to crack.' } });
    fireEvent.click(screen.getByTestId('close-submit'));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/en/provider/jobs/sara'));
    const [body] = transitions(api) as { final_cost: { amount: string; currency: string }; service_record: unknown }[];
    expect(body!.final_cost.amount).toBe('4500000');
    expect(body!.final_cost.currency).toMatch(/^[A-Z]{3}$/);
    expect(body!.service_record).toEqual({
      service_system_node_id: 'sys-susp',
      service_task_node_id: 'task-arm',
      parts_used: [{ name: 'Lemförder control arm', part_number: '31126776940', quantity: 1 }],
      cost_breakdown: { labor: '1500000', parts: '3000000' },
      warranty_note: '12 months on part and labour',
    });
    const note = api.calls.find((c) => c.opId === 'provider.note_create')!;
    expect(note.args.body).toEqual({ note_type: 'internal', body: 'Left bushing starting to crack.', content_locale: 'en' });
    // No invoice photo: no job log.
    expect(api.calls.some((c) => c.opId === 'provider.job_log_create')).toBe(false);
  });

  it('needs the category and shows server field errors beside the field', async () => {
    navigation.reset('/en/provider/jobs/sara/close');
    const { api } = render(<WorkshopCloseJob appointmentId="sara" />, {
      'provider.appointments_get': () => apt({ ...ready(), service_system: null, service_task: null }),
      'provider.appointments_transition': () => {
        throw new ApiProblem(422, {
          code: 'VALIDATION_FAILED',
          errors: [{ pointer: '/service_record/service_task_node_id', code: 'not_descendant' }],
        });
      },
    });
    const system = (await screen.findByLabelText(/Service category/)) as HTMLSelectElement;
    await waitFor(() => expect(within(system).getAllByRole('option').length).toBeGreaterThan(2));
    expect(system.value).toBe('');
    fireEvent.click(screen.getByTestId('close-submit'));
    expect(await screen.findByText(EN.close.errors.system)).toBeTruthy();
    expect(transitions(api)).toHaveLength(0);

    fireEvent.change(system, { target: { value: 'sys-susp' } });
    await waitFor(() => expect(within(screen.getByLabelText(EN.close.task)).getAllByRole('option').length).toBeGreaterThan(2));
    fireEvent.change(screen.getByLabelText(EN.close.task), { target: { value: 'task-shock' } });
    fireEvent.click(screen.getByTestId('close-submit'));
    expect(await screen.findByText(EN.close.errors.task)).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('says when the job cannot be closed now', async () => {
    render(<WorkshopCloseJob appointmentId="sara" />, {
      'provider.appointments_get': () => apt({ status: 'awaiting_parts', allowed_transitions: ['in_progress', 'cancelled'] }),
    });
    expect(await screen.findByText('This job cannot be closed now. It is: Awaiting parts.')).toBeTruthy();
  });
});

describe('Today’s jobs (PW4)', () => {
  it('lists the jobs still in the workshop with today’s visits, each opening its job page', async () => {
    navigation.reset('/en/provider/today');
    const { api } = render(<WorkshopToday />, {
      'provider.profile_get': () => ({ measured_response_time_minutes: null, completeness_gaps: [] }),
      'reviews.org_list': () => page([]),
      'provider.portfolio_list': () => page([]),
      'provider.appointments_list': ({ query }) => {
        const g = (query as { group: string }).group;
        if (g === 'today') return page([apt({ id: 'today1', status: 'confirmed', confirmed_start_at: at(1) })]);
        if (g === 'in_progress') return page([apt({ id: 'yesterday', status: 'awaiting_parts', confirmed_start_at: at(-26) })]);
        return page([]);
      },
    });
    const list = await screen.findByTestId('todays-jobs');
    const links = within(list)
      .getAllByRole('link')
      .map((l) => l.getAttribute('href'));
    expect(links.sort()).toEqual(['/en/provider/jobs/today1', '/en/provider/jobs/yesterday']);
    expect(
      api.calls.some((c) => c.opId === 'provider.appointments_list' && (c.args.query as { group: string }).group === 'in_progress'),
    ).toBe(true);
  });
});
