// PW3 (DOM): Requests list and detail of CarPal Workshop. The list splits one group=new read into New and Proposed,
// puts safety-critical first and filters 'My jobs' from participants (read only while the filter is on). The detail
// opens a new request into provider_reviewing once, shows "Triage: not provided" and "Not shared by customer", and
// answers from allowed_transitions: Accept (and a 409 CAPACITY_UNAVAILABLE that shows the day and offers Propose
// time), Propose time with a note, Decline with the reason in words, Ask for information as a customer-visible note,
// and a 409 INVALID_TRANSITION that reloads and says what changed. The AI card runs only on request and the screen
// works with the AI off.
import type { Appointment, Membership } from '@carpal/api-contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '../../../tests/support/next-navigation';
import { renderApp, signedIn, type Handlers } from '../../../tests/support/render-app';
import { ApiProblem } from '@/lib/api/problem';
import { BUNDLED } from '@/lib/i18n/dictionary';
import { WorkshopProvider } from './context';
import { WorkshopRequestDetail } from './request-detail';
import { WorkshopRequests } from './requests';
import { WorkshopGate } from './shell';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));
vi.mock('next/link', () => import('../../../tests/support/next-link'));
vi.mock('@/lib/browser-nav', () => ({ goTo: vi.fn() }));

const EN = BUNDLED.en.provider.requests;
const ORG = '0195f3b1-6a2b-7c3d-8e4f-0000000000a1';
const DAY = 86_400_000;
const future = (days: number, hourUtc: number) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
};

const membership = (role: Membership['role'] = 'provider_staff'): Membership =>
  ({
    id: 'm1',
    role,
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
  }) as Membership;

const apt = (o: Partial<Appointment> = {}): Appointment =>
  ({
    id: 'sara',
    created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    version: 1,
    status: 'requested',
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
    triage_status: 'not_provided',
    safety_flag: false,
    service_system: null,
    service_task: null,
    symptom: { text: 'Front suspension noise', locale: 'en' },
    description: 'Knock from the front right over bumps',
    content_locale: 'en',
    urgency_level: 'medium',
    customer_expectations: null,
    time_windows: [{ id: 'w1', start_at: future(2, 9), end_at: future(2, 12), priority: 1 }],
    proposed_start_at: null,
    confirmed_start_at: null,
    estimated_duration_minutes: null,
    consent_to_share_history: false,
    cancellation_reason: null,
    allowed_transitions: ['provider_reviewing', 'confirmed', 'alternative_proposed', 'cancelled'],
    ...o,
  }) as Appointment;

const page = <T,>(items: T[], next: string | null = null) => ({ items, next_cursor: next });

function base(extra: Handlers = {}): Handlers {
  return {
    'me.memberships_list': () => page([membership()]),
    'provider.calendar': () => ({
      from: '',
      to: '',
      appointments: [apt({ id: 'other', status: 'confirmed' })],
      time_off: [],
      capacity: [],
    }),
    // The provider lists take at most 50 (422 above, found by the PW3 smoke).
    'provider.notes_list': (a) => {
      if ((a.query as { limit: number }).limit > 50) throw new ApiProblem(422, { code: 'VALIDATION_FAILED' });
      return page([]);
    },
    'pre_visit.provider_get': () => {
      throw new ApiProblem(404, { code: 'NOT_FOUND' });
    },
    ...extra,
  };
}

function renderList(extra: Handlers = {}) {
  return renderApp(
    <WorkshopProvider>
      <WorkshopGate>
        <WorkshopRequests />
      </WorkshopGate>
    </WorkshopProvider>,
    { locale: 'en', session: signedIn('Neda'), handlers: base(extra) },
  );
}

function renderDetail(extra: Handlers = {}) {
  return renderApp(
    <WorkshopProvider>
      <WorkshopGate>
        <WorkshopRequestDetail appointmentId="sara" />
      </WorkshopGate>
    </WorkshopProvider>,
    { locale: 'en', session: signedIn('Neda'), handlers: base(extra) },
  );
}

beforeEach(() => navigation.reset('/en/provider/requests'));
afterEach(() => localStorage.clear());

describe('Requests list (PW-REQ-01)', () => {
  const newPage = () =>
    page([
      apt({ id: 'plain', created_at: new Date(Date.now() - 5 * 3_600_000).toISOString() }),
      apt({ id: 'urgent', urgency_level: 'safety_critical', requester_display: 'Ali K.' }),
      apt({ id: 'prop', status: 'alternative_proposed', proposed_start_at: future(3, 10) }),
    ]);

  it('splits New and Proposed from one read, safety-critical first, and keeps the segment in the address', async () => {
    const { api } = renderList({ 'provider.appointments_list': () => newPage() });
    const list = await screen.findByTestId('request-list');
    const cards = within(list).getAllByRole('link');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain('Safety-critical');
    expect(cards[0]!.getAttribute('href')).toBe('/en/provider/requests/urgent');
    expect(cards[1]!.textContent).toContain('Preferred:');

    fireEvent.click(screen.getByRole('button', { name: /Proposed/ }));
    await waitFor(() => expect(navigation.search).toBe('s=proposed'));
    const proposed = within(await screen.findByTestId('request-list')).getAllByRole('link');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.textContent).toContain('You proposed:');
    // One read of group=new served both segments.
    expect(
      api.calls.filter((c) => c.opId === 'provider.appointments_list').every((c) => (c.args.query as { group: string }).group === 'new'),
    ).toBe(true);
    expect(api.calls.some((c) => c.opId === 'provider.participants_list')).toBe(false);
  });

  it("filters 'My jobs' from the participants, read only while the filter is on", async () => {
    const { api } = renderList({
      'provider.appointments_list': () => newPage(),
      'provider.participants_list': (a) => {
        const id = (a.path as { appointment_id: string }).appointment_id;
        return page(
          id === 'plain'
            ? [{ id: 'p1', user_id: 'u1', display_name: 'Neda', organization_id: ORG, participant_role: 'technician', status: 'active' }]
            : [{ id: 'p2', user_id: 'u1', display_name: 'Neda', organization_id: null, participant_role: 'requester', status: 'active' }],
        );
      },
    });
    await screen.findByTestId('request-list');
    fireEvent.click(screen.getByRole('button', { name: EN.myJobs }));
    await waitFor(() => expect(within(screen.getByTestId('request-list')).getAllByRole('link')).toHaveLength(1));
    expect(within(screen.getByTestId('request-list')).getByRole('link').getAttribute('href')).toBe('/en/provider/requests/plain');
    expect(api.calls.filter((c) => c.opId === 'provider.participants_list')).toHaveLength(2);
  });

  it('says when a segment is empty', async () => {
    renderList({ 'provider.appointments_list': () => page([]) });
    expect(await screen.findByText(EN.empty.new)).toBeTruthy();
  });
});

describe('Request detail (PW-REQ-02, PW-REQ-03)', () => {
  it('opens a new request into provider_reviewing once and shows the request without a report', async () => {
    let current = apt();
    const { api } = renderDetail({
      'provider.appointments_get': () => current,
      'provider.appointments_transition': (a) => {
        expect(a.body).toEqual({ to: 'provider_reviewing' });
        current = apt({ status: 'provider_reviewing', allowed_transitions: ['confirmed', 'alternative_proposed', 'cancelled'] });
        return current;
      },
    });
    expect(await screen.findByRole('heading', { name: 'Sara M.' })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('Reviewing').length).toBeGreaterThan(0));
    expect(api.calls.filter((c) => c.opId === 'provider.appointments_transition')).toHaveLength(1);
    expect(screen.getByText(EN.report.triageNone)).toBeTruthy();
    expect(screen.getByText(EN.report.historyNotShared)).toBeTruthy();
    expect(screen.getByText('Knock from the front right over bumps')).toBeTruthy();
    expect(screen.getByTestId('preferred-times').textContent).toMatch(/9:00 AM–12:00 PM/);
    // The AI runs only on request.
    expect(api.calls.some((c) => c.opId === 'ai.appointment_suggestions')).toBe(false);
  });

  it('shows the red safety banner first and the shared history from the report', async () => {
    renderDetail({
      'provider.appointments_get': () => apt({ status: 'provider_reviewing', safety_flag: true, allowed_transitions: ['confirmed'] }),
      'pre_visit.provider_get': () => ({
        mileage_km: 151200,
        issue_summary: 'Knock over bumps',
        reported_symptoms: [],
        triage_status: 'provided',
        ai_summary: 'Likely control arm bushings.',
        likely_services: [{ node_id: 'n', label: { text: 'Suspension', locale: 'en' } }],
        relevant_history_summary: 'Front brake pads and discs 14 months ago.',
        previous_related_repairs: [],
        known_warnings: [],
        suggested_focus_areas: [],
        media: [],
        customer_expectations: null,
      }),
    });
    const banner = await screen.findByText(EN.detail.safetyTitle);
    expect(banner.closest('[role="alert"]')).toBeTruthy();
    expect(await screen.findByText('Likely control arm bushings.')).toBeTruthy();
    expect(screen.getByText(EN.report.aiLabel)).toBeTruthy();
    expect(screen.getByText('Front brake pads and discs 14 months ago.')).toBeTruthy();
    expect(screen.getByText(/151,200 km/)).toBeTruthy();
  });

  it('accepts at the preferred time; a full slot shows the day and offers Propose time', async () => {
    let accepts = 0;
    const reviewing = apt({ status: 'provider_reviewing', allowed_transitions: ['confirmed', 'alternative_proposed', 'cancelled'] });
    const { api } = renderDetail({
      'provider.appointments_get': () => reviewing,
      'provider.note_create': (a) => ({ id: 'n', ...(a.body as object) }),
      'provider.appointments_transition': (a) => {
        const body = a.body as { to: string };
        if (body.to === 'confirmed' && ++accepts === 1) throw new ApiProblem(409, { code: 'CAPACITY_UNAVAILABLE' });
        return apt({ status: body.to as Appointment['status'], allowed_transitions: [] });
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: EN.actions.accept }));
    // Another day (today + 3 at the shop, UTC here) and 15:00.
    fireEvent.click(within(await screen.findByTestId('day-chips')).getAllByRole('button')[3]!);
    fireEvent.change(screen.getByLabelText(EN.sheets.time), { target: { value: '15:00' } });
    const chosen = future(3, 15);
    fireEvent.click(screen.getByTestId('sheet-submit'));
    expect(await screen.findByText(EN.errors.capacity)).toBeTruthy();
    expect(screen.getByText(/1 visit booked/)).toBeTruthy();
    const first = api.calls.find((c) => c.opId === 'provider.appointments_transition')!;
    expect(first.args.body).toMatchObject({ to: 'confirmed', confirmed_start_at: chosen, estimated_duration_minutes: 60 });

    // Propose time from the same sheet, with a note.
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: EN.actions.propose }));
    fireEvent.change(await screen.findByLabelText(EN.sheets.propose.note), { target: { value: 'Afternoon lets us order a part.' } });
    fireEvent.click(screen.getByTestId('sheet-submit'));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.opId === 'provider.appointments_transition').at(-1)!.args.body).toMatchObject({
        to: 'alternative_proposed',
        // The same day and time as the refused Accept.
        proposed_start_at: chosen,
        note: 'Afternoon lets us order a part.',
      }),
    );
    // W-APP-01 shows messages, not the proposal's history note: the note also goes out as a customer-visible message.
    await waitFor(() =>
      expect(api.calls.find((c) => c.opId === 'provider.note_create')?.args.body).toEqual({
        note_type: 'customer_visible',
        body: 'Afternoon lets us order a part.',
        content_locale: 'en',
      }),
    );
  });

  it('declines with the reason in words and asks for information as a customer-visible note', async () => {
    const { api } = renderDetail({
      'provider.appointments_get': () =>
        apt({ status: 'provider_reviewing', allowed_transitions: ['confirmed', 'alternative_proposed', 'cancelled'] }),
      'provider.note_create': (a) => ({ id: 'n1', ...(a.body as object) }),
      'provider.appointments_transition': () =>
        apt({ status: 'cancelled', cancelled_by: 'provider', cancellation_reason: 'declined', allowed_transitions: [] }),
    });
    fireEvent.click(await screen.findByRole('button', { name: EN.actions.more }));
    fireEvent.click(within(screen.getByTestId('more-answers')).getByRole('button', { name: EN.actions.ask }));
    fireEvent.change(await screen.findByLabelText(EN.sheets.ask.label), { target: { value: 'Does it knock when braking?' } });
    fireEvent.click(screen.getByTestId('sheet-submit'));
    await waitFor(() => expect(api.calls.some((c) => c.opId === 'provider.note_create')).toBe(true));
    expect(api.calls.find((c) => c.opId === 'provider.note_create')!.args.body).toEqual({
      note_type: 'customer_visible',
      body: 'Does it knock when braking?',
      content_locale: 'en',
    });
    expect(api.calls.some((c) => c.opId === 'provider.appointments_transition')).toBe(false);

    fireEvent.click(await screen.findByRole('button', { name: EN.actions.more }));
    fireEvent.click(within(screen.getByTestId('more-answers')).getByRole('button', { name: EN.actions.decline }));
    fireEvent.click(await screen.findByRole('button', { name: EN.decline.reasons.vehicle_not_covered }));
    fireEvent.change(screen.getByLabelText(EN.decline.note), { target: { value: 'Try a BMW specialist.' } });
    fireEvent.click(screen.getByTestId('sheet-submit'));
    await waitFor(() =>
      expect(api.calls.find((c) => c.opId === 'provider.appointments_transition')?.args.body).toEqual({
        to: 'cancelled',
        cancellation_reason: 'declined',
      }),
    );
    await waitFor(() =>
      expect(api.calls.filter((c) => c.opId === 'provider.note_create').at(-1)?.args.body).toEqual({
        note_type: 'customer_visible',
        body: 'We do not work on this vehicle: Try a BMW specialist.',
        content_locale: 'en',
      }),
    );
    // The message goes after the decline succeeded, never before it.
    const ops = api.calls.map((c) => c.opId);
    expect(ops.lastIndexOf('provider.note_create')).toBeGreaterThan(ops.indexOf('provider.appointments_transition'));
    expect(await screen.findByText(EN.detail.declined)).toBeTruthy();
  });

  it('reloads after 409 INVALID_TRANSITION and says what the request is now', async () => {
    let gets = 0;
    renderDetail({
      'provider.appointments_get': () =>
        ++gets === 1
          ? apt({ status: 'provider_reviewing', allowed_transitions: ['confirmed', 'alternative_proposed', 'cancelled'] })
          : apt({ status: 'cancelled', allowed_transitions: [], cancellation_reason: 'Found another shop' }),
      'provider.appointments_transition': () => {
        throw new ApiProblem(409, { code: 'INVALID_TRANSITION' });
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: EN.actions.accept }));
    fireEvent.click(await screen.findByTestId('sheet-submit'));
    expect(await screen.findByText('This request changed meanwhile. It is now: Cancelled.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: EN.actions.accept })).toBeNull();
    expect(screen.getByText('Reason: Found another shop')).toBeTruthy();
  });

  const reviewing = () => apt({ status: 'provider_reviewing', allowed_transitions: ['confirmed', 'alternative_proposed', 'cancelled'] });

  it('works with the AI off', async () => {
    renderDetail({
      'provider.appointments_get': reviewing,
      'ai.appointment_suggestions': () => {
        throw new ApiProblem(503, { code: 'AI_UNAVAILABLE' });
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: EN.ai.run }));
    expect(await screen.findByText(EN.ai.off)).toBeTruthy();
    expect(screen.getByRole('button', { name: EN.actions.accept })).toBeTruthy();
  });

  it('shows the AI suggestion as a labelled draft whose duration prefills Accept', async () => {
    const { api } = renderDetail({
      'provider.appointments_get': reviewing,
      'ai.appointment_suggestions': () => ({ id: 'j', status: 'succeeded', result: { type: 'ai_insight', id: 'i' } }),
      'ai.insight_get': () => ({
        summary: 'A 2-hour slot; control arms are often not in stock.',
        structured_payload: {
          suggested_duration_minutes: 120,
          longer_than_requested: true,
          conflict_count: 1,
          customer_need: 'Inspection',
        },
      }),
      'provider.appointments_transition': (a) => apt({ status: (a.body as { to: Appointment['status'] }).to, allowed_transitions: [] }),
    });
    fireEvent.click(await screen.findByRole('button', { name: EN.ai.run }));
    expect(await screen.findByText('A 2-hour slot; control arms are often not in stock.')).toBeTruthy();
    const card = screen.getByTestId('ai-suggestion');
    expect(within(card).getByText(EN.ai.label)).toBeTruthy();
    expect(within(card).getByText(/Suggested duration: 2 h · longer than the customer expects/)).toBeTruthy();
    expect(within(card).getByText('1 conflict with booked work')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: EN.ai.use }));
    fireEvent.click(screen.getByRole('button', { name: EN.actions.accept }));
    fireEvent.click(await screen.findByTestId('sheet-submit'));
    await waitFor(() =>
      expect(api.calls.find((c) => c.opId === 'provider.appointments_transition')?.args.body).toMatchObject({
        to: 'confirmed',
        estimated_duration_minutes: 120,
      }),
    );
  });
});
